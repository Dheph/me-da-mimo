-- Members are added by e-mail: an existing account joins at once, otherwise the
-- e-mail waits in family_invites and joins when that account is created.
-- Replaces the join-by-link flow.
drop function public.join_family(text);
alter table public.families drop column invite_code;

create table public.family_invites (
  family_id uuid not null references public.families on delete cascade,
  email text not null check (email = lower(email) and email like '%_@_%'),
  created_at timestamptz not null default now(),
  primary key (family_id, email)
);
create index on public.family_invites (email);
alter table public.family_invites enable row level security;
revoke insert, update on public.family_invites from anon, authenticated;
create policy "owner sees invites" on public.family_invites for select to authenticated
  using (public.family_owner(family_id) = auth.uid());
create policy "owner cancels invite" on public.family_invites for delete to authenticated
  using (public.family_owner(family_id) = auth.uid());

-- Returns 'added' (account exists, now a member) or 'invited' (joins on sign-up).
create function public.add_member(fam uuid, member_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare e text := lower(trim(member_email)); uid uuid;
begin
  if public.family_owner(fam) is distinct from auth.uid() then
    raise exception 'Só quem criou a família pode adicionar membros';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido'; end if;
  select id into uid from auth.users where lower(email) = e;
  if uid is null then
    insert into public.family_invites (family_id, email) values (fam, e) on conflict do nothing;
    return 'invited';
  end if;
  insert into public.family_members (family_id, user_id) values (fam, uid) on conflict do nothing;
  if found then
    insert into public.notifications (user_id, title, body, url)
    select uid, 'Você entrou numa família 🎄', name, '#/familia/' || fam from public.families where id = fam;
  end if;
  return 'added';
end $$;
revoke execute on function public.add_member from public, anon;
grant execute on function public.add_member to authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)), 60));
  insert into public.family_members (family_id, user_id)
  select family_id, new.id from public.family_invites where email = lower(new.email)
  on conflict do nothing;
  delete from public.family_invites where email = lower(new.email);
  return new;
end $$;
