-- Sign-up as admin: metadata.family_name creates the family (the admin is also a member,
-- via families_add_owner). Sign-up as member: joins the families that invited the e-mail.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare fam_name text := left(nullif(trim(new.raw_user_meta_data->>'family_name'), ''), 80);
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)), 60));
  if fam_name is not null then
    insert into public.families (name, owner_id) values (fam_name, new.id);
  end if;
  insert into public.family_members (family_id, user_id)
  select family_id, new.id from public.family_invites where email = lower(new.email)
  on conflict do nothing;
  delete from public.family_invites where email = lower(new.email);
  return new;
end $$;
