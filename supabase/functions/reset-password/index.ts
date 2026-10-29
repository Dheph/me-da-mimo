// "Esqueci a senha": username/e-mail + one-time code from the family admin -> new password.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { login, code, password } = await req.json();
    if (String(password ?? '').length < 6) return reply({ error: 'A senha precisa ter pelo menos 6 caracteres.' }, 400);

    const { data: res, error } = await db.rpc('consume_password_reset', { login: String(login ?? ''), code: String(code ?? '') });
    if (error) throw error;
    if (!res.ok) return reply({ error: res.error }, 400);

    const { data, error: e2 } = await db.auth.admin.updateUserById(res.user_id, { password: String(password) });
    if (e2) throw e2;
    return reply({ ok: true, email: data.user.email });
  } catch (err) {
    console.error('reset-password error', (err as Error).message);
    return reply({ error: 'Não deu certo agora. Tente de novo em instantes.' }, 500);
  }
});
