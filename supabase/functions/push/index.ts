// Drena a fila de notifications (pushed_at null) para Web Push. Chamada pelo trigger kick_push.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function vapid() {
  let { data, error } = await db.rpc('vapid_keys');
  if (error) throw error;
  if (!data?.vapid_private_key) {
    // Primeira execução: a chave privada nasce aqui e só vive no Vault.
    const k = webpush.generateVAPIDKeys();
    const { error: e } = await db.rpc('set_vapid_keys', { public_key: k.publicKey, private_key: k.privateKey });
    if (e) throw e;
    ({ data, error } = await db.rpc('vapid_keys')); // relê: outra chamada pode ter gravado antes
    if (error) throw error;
  }
  return data as { vapid_public_key: string; vapid_private_key: string };
}

Deno.serve(async () => {
  try {
    const keys = await vapid();
    webpush.setVapidDetails('https://dheph.github.io/me-da-mimo/', keys.vapid_public_key, keys.vapid_private_key);

    const { data: pending, error } = await db.from('notifications').select('id')
      .is('pushed_at', null).order('created_at').limit(200);
    if (error) throw error;
    if (!pending.length) return Response.json({ sent: 0 });

    // Reivindica antes de enviar: só as linhas que esta chamada conseguiu marcar.
    const { data: claimed, error: e2 } = await db.from('notifications')
      .update({ pushed_at: new Date().toISOString() })
      .in('id', pending.map((n) => n.id)).is('pushed_at', null)
      .select('user_id, title, body, url');
    if (e2) throw e2;
    if (!claimed.length) return Response.json({ sent: 0 });

    const { data: subs, error: e3 } = await db.from('push_subscriptions')
      .select('endpoint, user_id, subscription').in('user_id', [...new Set(claimed.map((n) => n.user_id))]);
    if (e3) throw e3;

    let sent = 0, gone = 0, failed = 0;
    await Promise.all(claimed.flatMap((n) => subs.filter((s) => s.user_id === n.user_id).map(async (s) => {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify({ title: n.title, body: n.body, url: n.url ?? '' }));
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { gone++; await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint); }
        else { failed++; console.error('push failed', code, (err as Error).message); }
      }
    })));
    return Response.json({ claimed: claimed.length, sent, gone, failed });
  } catch (err) {
    console.error('push error', (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
});
