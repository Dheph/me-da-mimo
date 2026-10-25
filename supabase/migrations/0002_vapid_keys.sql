-- VAPID keys live in Vault. The push edge function generates them on first run
-- (so the private key never leaves Supabase); the frontend reads the public one.
drop function public.vapid_private_key();

create function public.vapid_keys() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_object_agg(name, decrypted_secret) from vault.decrypted_secrets
  where name in ('vapid_public_key', 'vapid_private_key')
$$;

create function public.set_vapid_keys(public_key text, private_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from vault.secrets where name = 'vapid_private_key') then return; end if;
  perform vault.create_secret(public_key, 'vapid_public_key');
  perform vault.create_secret(private_key, 'vapid_private_key');
end $$;

create function public.vapid_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vapid_public_key'
$$;

revoke execute on function public.vapid_keys, public.set_vapid_keys, public.vapid_public_key from public, anon, authenticated;
grant execute on function public.vapid_keys, public.set_vapid_keys to service_role;
grant execute on function public.vapid_public_key to authenticated;
