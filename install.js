// Install prompt: Chrome/Edge/Android give a real prompt; iPhone needs the Share-menu steps.
import { isIOS, standalone } from './push.js';

let deferred = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own, friendlier button
  deferred = e;
  dispatchEvent(new Event('mimo:installable'));
});
addEventListener('appinstalled', () => { deferred = null; });

export const installed = standalone;
export const canPrompt = () => !!deferred;
// Instagram/Facebook/WhatsApp/Telegram webviews can't install apps at all.
export const inAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|WhatsApp|Telegram|wv\)/i.test(navigator.userAgent);
export const platform = () => (isIOS() ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop');

export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome === 'accepted';
}
