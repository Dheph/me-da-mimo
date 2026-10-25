// Web Push no cliente: SW + assinatura salva em push_subscriptions.
export async function registerSW() {
  if ('serviceWorker' in navigator) return navigator.serviceWorker.register('./sw.js', { scope: './' });
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS se diz Mac
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function pushState() {
  if (isIOS() && !standalone()) return 'needs-install'; // iOS só tem push no PWA instalado
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

const b64urlToBytes = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function enablePush(supabase) {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Permissão de notificação negada');
  const { data: key, error } = await supabase.rpc('vapid_public_key');
  if (error || !key) throw error || new Error('Chave de push indisponível');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() ||
    await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
  const { error: e2 } = await supabase.rpc('save_push_subscription', { sub: sub.toJSON() });
  if (e2) throw e2;
}

export async function disablePush(supabase) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}
