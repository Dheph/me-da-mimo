-- Me Dá Mimo: schema, RLS, triggers.
create extension if not exists pg_net;

-- Tables -------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  invite_code text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  created_at timestamptz not null default now()
);

create table public.family_members (
  family_id uuid not null references public.families on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index on public.family_members (user_id);

create table public.gifts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  url text check (url is null or url ~* '^https?://'),
  note text check (char_length(note) <= 500),
  purchased boolean not null default false, -- set by trigger; owner sees it without seeing the buyer
  created_at timestamptz not null default now()
);
create index on public.gifts (owner_id);

create table public.purchases (
  gift_id uuid primary key references public.gifts on delete cascade,
  buyer_id uuid not null default auth.uid() references public.profiles on delete cascade,
  created_at timestamptz not null default now()
);
create index on public.purchases (buyer_id);

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  title text not null,
  body text not null,
  url text,
  read_at timestamptz,
  pushed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);
create index on public.notifications (created_at) where pushed_at is null;

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
create index on public.push_subscriptions (user_id);

-- Helpers (security definer so RLS policies don't recurse) ------------------

create function public.is_member(fam uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members where family_id = fam and user_id = auth.uid())
$$;

create function public.shares_family(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select other = auth.uid() or exists (
    select 1 from public.family_members a
    join public.family_members b on a.family_id = b.family_id
    where a.user_id = auth.uid() and b.user_id = other
  )
$$;

create function public.family_owner(fam uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select owner_id from public.families where id = fam
$$;

-- Triggers -----------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)), 60));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.add_owner_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.family_members (family_id, user_id) values (new.id, new.owner_id);
  return new;
end $$;
create trigger families_add_owner after insert on public.families
  for each row execute function public.add_owner_member();

create function public.notify_new_gift() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, title, body, url)
  select distinct b.user_id,
         (select name from public.profiles where id = new.owner_id) || ' quer um mimo 🎁',
         new.title,
         '#/pessoa/' || new.owner_id
  from public.family_members a
  join public.family_members b on a.family_id = b.family_id
  where a.user_id = new.owner_id and b.user_id <> new.owner_id;
  return new;
end $$;
create trigger gifts_notify after insert on public.gifts
  for each row execute function public.notify_new_gift();

create function public.on_purchase_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare g public.gifts;
begin
  if tg_op = 'INSERT' then
    update public.gifts set purchased = true where id = new.gift_id returning * into g;
    insert into public.notifications (user_id, title, body, url)
    values (g.owner_id, 'Alguém comprou um mimo pra você! 🎉', g.title, '#/');
    return new;
  end if;
  update public.gifts set purchased = false where id = old.gift_id;
  return old;
end $$;
create trigger purchases_change after insert or delete on public.purchases
  for each row execute function public.on_purchase_change();

-- Wakes the `push` edge function, which flushes every notification with pushed_at null.
-- The anon key is public (it's in the frontend too); the function only drains the queue.
create function public.kick_push() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://ytdrhnxkycmutrfnsmho.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl0ZHJobnhreWNtdXRyZm5zbWhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MDkzMjUsImV4cCI6MjEwODQ4NTMyNX0.7u-pHuT7e74Bg9XHbxtvrQAHZK7ilSo_zCBW9GZnq1o'
    ),
    body := '{}'::jsonb
  );
  return null;
end $$;
create trigger notifications_push after insert on public.notifications
  for each statement execute function public.kick_push();

-- RPCs ---------------------------------------------------------------------

create function public.join_family(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare fam uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into fam from public.families where invite_code = code;
  if fam is null then raise exception 'Convite inválido'; end if;
  insert into public.family_members (family_id, user_id) values (fam, auth.uid()) on conflict do nothing;
  return fam;
end $$;

-- Upsert so a shared device can move its subscription to whoever is logged in now.
create function public.save_push_subscription(sub jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.push_subscriptions (endpoint, user_id, subscription)
  values (sub->>'endpoint', auth.uid(), sub)
  on conflict (endpoint) do update set user_id = excluded.user_id, subscription = excluded.subscription;
end $$;

-- Read by the push edge function (service role only).
create function public.vapid_private_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key'
$$;

revoke execute on function public.join_family, public.save_push_subscription, public.vapid_private_key,
  public.is_member, public.shares_family, public.family_owner from public, anon;
grant execute on function public.join_family, public.save_push_subscription,
  public.is_member, public.shares_family, public.family_owner to authenticated;
revoke execute on function public.vapid_private_key from authenticated;
grant execute on function public.vapid_private_key to service_role;
revoke execute on function public.handle_new_user, public.add_owner_member, public.notify_new_gift,
  public.on_purchase_change, public.kick_push from public, anon, authenticated;

-- RLS ----------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.gifts enable row level security;
alter table public.purchases enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;

-- Column grants: clients only write the columns they own.
revoke insert, update on public.profiles, public.families, public.family_members, public.gifts,
  public.purchases, public.notifications, public.push_subscriptions from anon, authenticated;
grant update (name) on public.profiles to authenticated;
grant insert (name), update (name) on public.families to authenticated;
grant insert (title, url, note), update (title, url, note) on public.gifts to authenticated;
grant insert (gift_id) on public.purchases to authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy "see co-members" on public.profiles for select to authenticated using (public.shares_family(id));
create policy "edit self" on public.profiles for update to authenticated using (id = auth.uid());

create policy "see my families" on public.families for select to authenticated
  using (owner_id = auth.uid() or public.is_member(id));
create policy "create family" on public.families for insert to authenticated with check (owner_id = auth.uid());
create policy "owner edits" on public.families for update to authenticated using (owner_id = auth.uid());
create policy "owner deletes" on public.families for delete to authenticated using (owner_id = auth.uid());

create policy "see members" on public.family_members for select to authenticated using (public.is_member(family_id));
-- Owner removes anyone but themselves; members can leave.
create policy "remove or leave" on public.family_members for delete to authenticated
  using ((user_id = auth.uid() or public.family_owner(family_id) = auth.uid())
         and user_id <> public.family_owner(family_id));

create policy "see family gifts" on public.gifts for select to authenticated using (public.shares_family(owner_id));
create policy "add own gift" on public.gifts for insert to authenticated with check (owner_id = auth.uid());
create policy "edit own gift" on public.gifts for update to authenticated using (owner_id = auth.uid());
create policy "delete own gift" on public.gifts for delete to authenticated using (owner_id = auth.uid());

-- The gift owner never sees purchases (surprise); they only see gifts.purchased.
create policy "see others' purchases" on public.purchases for select to authenticated
  using (buyer_id = auth.uid() or exists (
    select 1 from public.gifts g where g.id = gift_id and g.owner_id <> auth.uid() and public.shares_family(g.owner_id)));
create policy "buy for family" on public.purchases for insert to authenticated
  with check (buyer_id = auth.uid() and exists (
    select 1 from public.gifts g where g.id = gift_id and g.owner_id <> auth.uid() and public.shares_family(g.owner_id)));
create policy "undo own purchase" on public.purchases for delete to authenticated using (buyer_id = auth.uid());

create policy "my notifications" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "mark read" on public.notifications for update to authenticated using (user_id = auth.uid());

create policy "my subscriptions" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "unsubscribe" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
