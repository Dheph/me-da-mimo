// First access of an admin-created user: checks username + family code, then creates the
// account with the chosen password. Needs the admin API, so it runs here and not in the browser.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const DOMAIN = 'me-da-mimo.invalid'; // must match handle_new_user() and the frontend
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { username, code, password } = await req.json();
    const u = String(username ?? '').trim().toLowerCase();
    if (String(password ?? '').length < 6) return reply({ error: 'A senha precisa ter pelo menos 6 caracteres.' }, 400);

    // Checks username + code and returns a one-time token the DB trigger requires on insert.
    const { data: check, error } = await db.rpc('issue_claim_ticket', { u, code: String(code ?? '') });
    if (error) throw error;
    if (!check.ok) return reply({ error: check.error }, 400);

    const email = `${u}@${DOMAIN}`;
    const { error: e2 } = await db.auth.admin.createUser({
      email,
      password: String(password),
      email_confirm: true,
      user_metadata: { name: check.name, claim: check.token }, // present on insert, unlike app_metadata
    });
    if (e2) {
      const taken = /already|exists|registered/i.test(e2.message);
      return reply({ error: taken ? 'Esse usuário já criou a senha. Entre com usuário e senha.' : e2.message }, 400);
    }
    return reply({ ok: true, email });
  } catch (err) {
    console.error('claim-user error', (err as Error).message);
    return reply({ error: 'Não deu certo agora. Tente de novo em instantes.' }, 500);
  }
});
