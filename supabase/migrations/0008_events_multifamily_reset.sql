-- Events per family (e.g. "Natal 2026"): every wish belongs to one event, so each family
-- (and each occasion) has its own lists. Plus: join more families by code, and an
-- admin-issued code to reset a forgotten password.

-- 1) Events ---------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  event_date date,
  created_at timestamptz not null default now()
);
create index on public.events (family_id);
alter table public.events enable row level security;
revoke insert, update on public.events from anon, authenticated;
grant insert (family_id, name, event_date), update (name, event_date) on public.events to authenticated;
create policy "members see events" on public.events for select to authenticated using (public.is_member(family_id));
create policy "admin creates events" on public.events for insert to authenticated with check (public.family_owner(family_id) = auth.uid());
create policy "admin edits events" on public.events for update to authenticated using (public.family_owner(family_id) = auth.uid());
create policy "admin deletes events" on public.events for delete to authenticated using (public.family_owner(family_id) = auth.uid());

create function public.event_family(ev uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select family_id from public.events where id = ev
$$;
revoke execute on function public.event_family from public, anon;
grant execute on function public.event_family to authenticated;

-- 2) Wishes move into events (existing ones go to a "Natal 2026" of their owner's family)
alter table public.gifts add column event_id uuid references public.events on delete cascade;
insert into public.events (family_id, name, event_date) select id, 'Natal 2026', '2026-12-25' from public.families;
update public.gifts g set event_id = (
  select e.id from public.family_members fm join public.events e on e.family_id = fm.family_id
  where fm.user_id = g.owner_id order by fm.joined_at limit 1);
alter table public.gifts alter column event_id set not null;
create index on public.gifts (event_id);
grant insert (event_id) on public.gifts to authenticated;

drop policy "see family gifts" on public.gifts;
drop policy "add own gift" on public.gifts;
create policy "see event gifts" on public.gifts for select to authenticated
  using (public.is_member(public.event_family(event_id)));
create policy "add own gift" on public.gifts for insert to authenticated
  with check (owner_id = auth.uid() and public.is_member(public.event_family(event_id)));

-- Gift RLS (inside the subquery) already limits to my families' events.
drop policy "see others' purchases" on public.purchases;
drop policy "buy for family" on public.purchases;
create policy "see others' purchases" on public.purchases for select to authenticated
  using (buyer_id = auth.uid() or exists (select 1 from public.gifts g where g.id = gift_id and g.owner_id <> auth.uid()));
create policy "buy for family" on public.purchases for insert to authenticated
  with check (buyer_id = auth.uid() and exists (select 1 from public.gifts g where g.id = gift_id and g.owner_id <> auth.uid()));

create or replace function public.notify_new_gift() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, title, body, url)
  select fm.user_id,
         (select name from public.profiles where id = new.owner_id) || ' quer um mimo 🎁',
         new.title || ' · ' || e.name,
         '#/evento/' || e.id
  from public.events e join public.family_members fm on fm.family_id = e.family_id
  where e.id = new.event_id and fm.user_id <> new.owner_id;
  return new;
end $$;

-- Leaving/removed from a family takes your wishes in its events with you.
create function public.drop_member_gifts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.gifts g using public.events e
  where e.id = g.event_id and e.family_id = old.family_id and g.owner_id = old.user_id;
  return old;
end $$;
create trigger family_members_drop_gifts after delete on public.family_members
  for each row execute function public.drop_member_gifts();
revoke execute on function public.drop_member_gifts from public, anon, authenticated;

-- 3) Join another family with its code -------------------------------------------
alter table public.families add constraint families_access_code_key unique (access_code);
alter table public.profiles add column join_failures int not null default 0;

-- Returns the family id, or null for a wrong code (no raise, so the failure counts).
create function public.join_with_code(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare fam uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if (select join_failures from public.profiles where id = auth.uid()) >= 10 then
    raise exception 'Muitas tentativas erradas. Peça ajuda ao admin da família.';
  end if;
  select id into fam from public.families where access_code = upper(trim(code));
  if fam is null then
    update public.profiles set join_failures = join_failures + 1 where id = auth.uid();
    return null;
  end if;
  update public.profiles set join_failures = 0 where id = auth.uid();
  insert into public.family_members (family_id, user_id) values (fam, auth.uid()) on conflict do nothing;
  return fam;
end $$;
revoke execute on function public.join_with_code from public, anon;
grant execute on function public.join_with_code to authenticated;

-- 4) Forgot password: the admin issues a one-time code for a member ------------------
create table public.password_resets (
  user_id uuid primary key references public.profiles on delete cascade,
  code text not null,
  expires_at timestamptz not null default now() + interval '24 hours',
  failures int not null default 0
);
alter table public.password_resets enable row level security; -- definer functions only
revoke all on public.password_resets from anon, authenticated;

create function public.issue_password_reset(member uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare c text := public.new_access_code();
begin
  if not exists (select 1 from public.family_members fm join public.families f on f.id = fm.family_id
                 where fm.user_id = member and f.owner_id = auth.uid()) then
    raise exception 'Só o admin da família pode gerar o código de nova senha';
  end if;
  insert into public.password_resets (user_id, code) values (member, c)
  on conflict (user_id) do update set code = excluded.code, expires_at = now() + interval '24 hours', failures = 0;
  return c;
end $$;
revoke execute on function public.issue_password_reset from public, anon;
grant execute on function public.issue_password_reset to authenticated;

-- Used by the reset-password function: username or e-mail + code -> user id (code is single use).
create function public.consume_password_reset(login text, code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l text := lower(trim(login)); uid uuid; r public.password_resets;
begin
  select id into uid from public.profiles where username = l;
  if uid is null then select id into uid from auth.users where lower(email) = l; end if;
  if uid is null then select user_id into uid from public.login_aliases where email = l; end if;
  select * into r from public.password_resets where user_id = uid;
  if r is null or r.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'Código inválido ou vencido. Peça um novo ao admin da família.');
  end if;
  if r.failures >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Muitas tentativas. Peça um código novo ao admin da família.');
  end if;
  if upper(trim(code)) <> r.code then
    update public.password_resets set failures = failures + 1 where user_id = uid;
    return jsonb_build_object('ok', false, 'error', 'Código incorreto.');
  end if;
  delete from public.password_resets where user_id = uid;
  return jsonb_build_object('ok', true, 'user_id', uid);
end $$;
revoke execute on function public.consume_password_reset from public, anon, authenticated;
grant execute on function public.consume_password_reset to service_role;
