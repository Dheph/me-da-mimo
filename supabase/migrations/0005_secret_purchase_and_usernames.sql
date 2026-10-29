-- 1) A purchase is a secret from the gift owner: no alert, no "purchased" flag they can read.
--    Buyers still see it through purchases (RLS hides those rows from the owner) and
--    purchases.gift_id being the primary key is the lock against buying twice.
drop trigger purchases_change on public.purchases;
drop function public.on_purchase_change();
alter table public.gifts drop column purchased;

-- The buyer is told if a gift they bought is removed from the list.
create function public.notify_bought_gift_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, title, body, url)
  select p.buyer_id, 'Um presente que você comprou saiu da lista', old.title, '#/'
  from public.purchases p where p.gift_id = old.id;
  return old;
end $$;
create trigger gifts_removed before delete on public.gifts
  for each row execute function public.notify_bought_gift_removed();
revoke execute on function public.notify_bought_gift_removed from public, anon, authenticated;

-- 2) Accounts created by the admin: username + family access code on first login.
--    Their auth e-mail is "<username>@me-da-mimo.invalid" (reserved TLD, never mailed).
alter table public.profiles
  add column username text unique check (username ~ '^[a-z0-9][a-z0-9._]{2,29}$');

create function public.new_access_code() returns text
language sql volatile set search_path = '' as $$
  -- 6 chars without look-alikes (no I, L, O, 0, 1)
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', get_byte(b, i) % 31 + 1, 1), '')
  from extensions.gen_random_bytes(6) b, generate_series(0, 5) i
$$;

alter table public.families
  add column access_code text not null default public.new_access_code(),
  add column code_failures int not null default 0;
-- Members must not read the code: only the admin, through family_access_code().
revoke select on public.families from anon, authenticated;
grant select (id, name, owner_id, created_at) on public.families to authenticated;

create table public.pending_users (
  username text primary key check (username ~ '^[a-z0-9][a-z0-9._]{2,29}$'),
  family_id uuid not null references public.families on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create index on public.pending_users (family_id);
alter table public.pending_users enable row level security;
revoke insert, update on public.pending_users from anon, authenticated;
create policy "owner sees pending" on public.pending_users for select to authenticated
  using (public.family_owner(family_id) = auth.uid());
create policy "owner cancels pending" on public.pending_users for delete to authenticated
  using (public.family_owner(family_id) = auth.uid());

-- Optional e-mail a username account can also log in with (private to its owner).
create table public.login_aliases (
  email text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  user_id uuid not null unique references public.profiles on delete cascade
);
alter table public.login_aliases enable row level security;
revoke insert, update on public.login_aliases from anon, authenticated;
create policy "my alias" on public.login_aliases for select to authenticated using (user_id = auth.uid());
create policy "remove my alias" on public.login_aliases for delete to authenticated using (user_id = auth.uid());

create function public.username_available(u text) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(u) ~ '^[a-z0-9][a-z0-9._]{2,29}$'
     and not exists (select 1 from public.profiles where username = lower(u))
     and not exists (select 1 from public.pending_users where username = lower(u))
$$;

create function public.create_family_user(fam uuid, u text, member_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare un text := lower(trim(u)); nm text := trim(member_name);
begin
  if public.family_owner(fam) is distinct from auth.uid() then
    raise exception 'Só quem criou a família pode criar usuários';
  end if;
  if un !~ '^[a-z0-9][a-z0-9._]{2,29}$' then
    raise exception 'Usuário inválido: use de 3 a 30 letras minúsculas, números, ponto ou _';
  end if;
  if nm = '' then raise exception 'Escreva o nome da pessoa'; end if;
  if not public.username_available(un) then raise exception 'Esse usuário já existe, tente outro'; end if;
  insert into public.pending_users (username, family_id, name) values (un, fam, left(nm, 60));
  return un;
end $$;

create function public.family_access_code(fam uuid) returns text
language sql stable security definer set search_path = '' as $$
  select access_code from public.families where id = fam and owner_id = auth.uid()
$$;

create function public.renew_access_code(fam uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  update public.families set access_code = public.new_access_code(), code_failures = 0
  where id = fam and owner_id = auth.uid() returning access_code into code;
  if code is null then raise exception 'Só quem criou a família pode gerar um código novo'; end if;
  return code;
end $$;

-- Checks username + code without raising, so a wrong guess still counts toward the lock.
-- 10 wrong codes lock the family code until the admin renews it.
create function public.claim_check(u text, code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.pending_users; f public.families;
begin
  select * into p from public.pending_users where username = lower(trim(u));
  if p is null then
    if exists (select 1 from public.profiles where username = lower(trim(u))) then
      return jsonb_build_object('ok', false, 'error', 'Esse usuário já criou a senha. Entre com usuário e senha.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'Usuário não encontrado. Confira com quem te convidou.');
  end if;
  select * into f from public.families where id = p.family_id;
  if f.code_failures >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Código bloqueado por muitas tentativas. Peça um código novo ao admin.');
  end if;
  if upper(trim(code)) <> f.access_code then
    update public.families set code_failures = code_failures + 1 where id = f.id;
    return jsonb_build_object('ok', false, 'error', 'Código incorreto.');
  end if;
  return jsonb_build_object('ok', true, 'name', p.name, 'family', f.name);
end $$;

-- Maps an optional e-mail to the account's login e-mail (lets username accounts log in by e-mail).
create function public.login_email_for(e text) returns text
language sql stable security definer set search_path = '' as $$
  select u.email from public.login_aliases a join auth.users u on u.id = a.user_id where a.email = lower(trim(e))
$$;

create function public.set_login_email(e text) returns void
language plpgsql security definer set search_path = '' as $$
declare em text := lower(trim(e));
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido'; end if;
  if exists (select 1 from auth.users where lower(email) = em and id <> auth.uid())
     or exists (select 1 from public.login_aliases where email = em and user_id <> auth.uid()) then
    raise exception 'Esse e-mail já é usado por outra conta';
  end if;
  delete from public.login_aliases where user_id = auth.uid();
  insert into public.login_aliases (email, user_id) values (em, auth.uid());
end $$;

-- Sign-up: the admin API (claim-user function) sets app_metadata.mimo_username, which a
-- public sign-up cannot; that is what lets the reserved e-mail domain through.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fam_name text := left(nullif(trim(new.raw_user_meta_data->>'family_name'), ''), 80);
  un text := new.raw_app_meta_data->>'mimo_username';
begin
  if new.email like '%@me-da-mimo.invalid' and un is null then
    raise exception 'Endereço reservado';
  end if;
  insert into public.profiles (id, name, username)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)), 60), un);
  if un is not null then
    insert into public.family_members (family_id, user_id)
    select family_id, new.id from public.pending_users where username = un on conflict do nothing;
    delete from public.pending_users where username = un;
  end if;
  if fam_name is not null then
    insert into public.families (name, owner_id) values (fam_name, new.id);
  end if;
  insert into public.family_members (family_id, user_id)
  select family_id, new.id from public.family_invites where email = lower(new.email)
  on conflict do nothing;
  delete from public.family_invites where email = lower(new.email);
  return new;
end $$;

-- new_access_code stays executable: it is the families.access_code default, evaluated as the inserting user.
revoke execute on function public.username_available, public.create_family_user,
  public.family_access_code, public.renew_access_code, public.claim_check, public.login_email_for,
  public.set_login_email from public, anon, authenticated;
grant execute on function public.username_available, public.create_family_user, public.family_access_code,
  public.renew_access_code, public.set_login_email to authenticated;
grant execute on function public.claim_check, public.login_email_for to anon, authenticated, service_role;
