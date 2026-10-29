-- Fix: GoTrue inserts the user before it writes app_metadata, so the trigger never saw
-- mimo_username and rejected every first access. Now the claim-user function gets a
-- one-time ticket (after checking username + code) and passes its token in user_metadata,
-- which IS present on insert. A public sign-up can't know the token.
create table public.claim_tickets (
  username text primary key,
  token text not null,
  expires_at timestamptz not null default now() + interval '2 minutes'
);
alter table public.claim_tickets enable row level security; -- no policies: definer functions only
revoke all on public.claim_tickets from anon, authenticated;

create function public.issue_claim_ticket(u text, code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare res jsonb := public.claim_check(u, code); tk text;
begin
  if not (res->>'ok')::boolean then return res; end if;
  tk := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.claim_tickets (username, token) values (lower(trim(u)), tk)
  on conflict (username) do update set token = excluded.token, expires_at = now() + interval '2 minutes';
  return res || jsonb_build_object('token', tk);
end $$;
revoke execute on function public.issue_claim_ticket from public, anon, authenticated;
grant execute on function public.issue_claim_ticket to service_role;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  fam_name text := left(nullif(trim(new.raw_user_meta_data->>'family_name'), ''), 80);
  un text;
begin
  if new.email like '%@me-da-mimo.invalid' then
    delete from public.claim_tickets
    where username = split_part(new.email, '@', 1)
      and token = new.raw_user_meta_data->>'claim' and expires_at > now()
    returning username into un;
    if un is null then raise exception 'Endereço reservado'; end if;
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
