-- The first access uses the family's CURRENT code, and only for users created in that family.
create or replace function public.claim_check(u text, code text) returns jsonb
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
    return jsonb_build_object('ok', false, 'error', 'Código incorreto. Se o admin gerou um código novo, peça o convite de novo.');
  end if;
  return jsonb_build_object('ok', true, 'name', p.name, 'family', f.name);
end $$;
