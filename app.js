import { supabase } from './supabase.js';
import { registerSW, pushState, enablePush, disablePush } from './push.js';
import { installed, canPrompt, promptInstall, inAppBrowser, platform } from './install.js';
import { startTour } from './tour.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const nav = $('#nav');

let user = null; // auth user
let me = null; // { id, name } from profiles
let booted = false;
let seq = 0; // render token: a slow, older render never overwrites a newer one
let recovering = false; // opened the e-mail "reset password" link

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const fmtDate = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function validUrl(u) {
  try { new URL(u); return /^https?:\/\//i.test(u); } catch { return false; }
}

function friendly(err) {
  const msg = err?.message ?? String(err);
  if (err?.status === 429 || /rate limit|too many|security purposes/i.test(msg)) return 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.';
  if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/already registered/i.test(msg)) return 'Este e-mail já tem conta. Use "Entrar".';
  if (/password should be/i.test(msg)) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (/duplicate key/i.test(msg)) return 'Alguém acabou de comprar este presente.';
  if (/failed to fetch|network/i.test(msg)) return 'Sem conexão. Verifique a internet.';
  return msg;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// Unwraps a supabase response, throwing its error.
function ok({ data, error }) {
  if (error) throw error;
  return data;
}

async function busy(btn, fn) {
  btn?.setAttribute('aria-busy', 'true'); // spinner via CSS
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(friendly(e)); } finally {
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }
}

// In-app confirm: native confirm()/prompt() are blocked in some installed apps and webviews.
function ask(text, okLabel = 'Confirmar') {
  const dlg = $('#ask-dialog');
  $('#ask-text').textContent = text;
  $('#ask-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}

// Copies text; falls back to selecting a field so the person can copy by hand.
async function copyText(text, field) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field?.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

// Flashes a label on a button for a moment (toasts sit under modal dialogs).
function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = old; }, 2000);
}

// Click delegation: <button data-act="name" data-id="…"> calls actions.name(id).
function on(el, actions) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && actions[b.dataset.act]) busy(b, () => actions[b.dataset.act](b.dataset.id, b));
  });
}

const submit = (form, fn) => (e) => {
  e.preventDefault();
  busy(form.querySelector('button[type=submit], button:not([type])'), () => fn(Object.fromEntries(new FormData(form))));
};

function section(html) {
  const el = document.createElement('section');
  el.innerHTML = html;
  return el;
}

function go(hash) {
  if (location.hash === hash || (hash === '#/' && !location.hash)) render();
  else location.hash = hash;
}

const giftBody = (g) => {
  const href = safeUrl(g.url);
  const title = href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(g.title)} <span aria-hidden="true">↗</span><span class="sr-only"> (abre em nova aba)</span></a>`
    : esc(g.title);
  return `<h3>${title}</h3>${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}`;
};

// Inline stroke icons (24×24), styled by .i in style.css.
const ICONS = {
  gift: '<path d="M20 12v9H4v-9"/><path d="M2 7h20v5H2z"/><path d="M12 21V7"/><path d="M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m22 7-10 6L2 7"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  share: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  addsq: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  dots: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
};
const ico = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const tile = (name, extra = '') => `<span class="tile${extra}" aria-hidden="true">${ico(name)}</span>`;
const initial = (name) => esc((String(name ?? '').trim()[0] ?? '?').toUpperCase());
const emptyState = (icon, title, text) => `<div class="empty">${tile(icon, ' big')}<p><strong>${title}</strong>${text}</p></div>`;

// ---------- router ----------

const routes = [
  [/^(#\/?)?$/, home, 'home'],
  [/^#\/familias$/, families, 'familias'],
  [/^#\/familia\/([0-9a-f-]{36})$/, family, 'familias'],
  [/^#\/pessoa\/([0-9a-f-]{36})$/, person, 'familias'],
  [/^#\/alertas$/, alerts, 'alertas'],
  [/^#\/perfil$/, profile, 'perfil'],
];

async function render(focus = false) {
  const token = ++seq;
  const hash = location.hash;
  nav.hidden = !user;
  const first = hash.match(/^#\/primeiro-acesso(?:\/([\w.]+))?$/);
  const forgot = hash.match(/^#\/esqueci-senha(?:\/([\w.@+-]+))?$/);
  if (!user) {
    return show(first ? firstAccess(first[1]) : forgot ? forgotPassword(forgot[1]) : hash === '#/entrar' ? login(false)
      : hash === '#/criar-conta' ? login(true) : landing(), focus);
  }
  if (recovering) return show(newPassword(), focus);
  if (first || forgot || hash === '#/entrar' || hash === '#/criar-conta') return go('#/');
  // Links from alerts open the event they talk about.
  const ev = hash.match(/^#\/evento\/([0-9a-f-]{36})$/);
  if (ev) {
    remember('mimo_event', ev[1]);
    return go('#/');
  }

  const route = routes.find(([re]) => re.test(hash));
  if (!route) return go('#/');
  const [re, fn, tab] = route;
  for (const a of nav.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  updateBadge();
  try {
    const el = await fn(...hash.match(re).slice(1));
    if (token !== seq) return;
    show(el, focus);
    el.afterShow?.();
  } catch (e) {
    if (token !== seq) return;
    const el = section(`<p class="empty">Não deu para carregar. ${esc(friendly(e))}</p><button class="btn" data-act="retry">Tentar de novo</button>`);
    on(el, { retry: () => render() });
    show(el, focus);
  }
}

function show(el, focus) {
  view.replaceChildren(el);
  if (focus) view.focus();
}

async function updateBadge() {
  const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  const badge = $('#badge');
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : count;
  $('#nav-alerts').setAttribute('aria-label', count ? `Alertas, ${count} não lidos` : 'Alertas');
}

// ---------- views ----------

// Public home for logged-out visitors.
function landing() {
  return section(`
    <div class="landing">
      <div class="hero">
        <div class="hero-copy">
          <h2>Natal sem presente repetido e sem “o que você quer ganhar?”</h2>
          <p class="lead">Cada pessoa da família monta sua lista de mimos. Quem vai presentear escolhe um e marca que comprou. Quem vai ganhar não fica sabendo de nada até a noite de Natal.</p>
          <div class="actions">
            <a class="btn primary big" href="#/criar-conta">Criar minha família</a>
            <a class="btn big" href="#/entrar">Já tenho conta</a>
          </div>
          <p class="first-link">Recebeu um usuário e um código da família? <a href="#/primeiro-acesso">Faça o primeiro acesso</a></p>
          <p class="muted small">É grátis e funciona direto no navegador do celular.</p>
        </div>
        <div class="hero-art" aria-hidden="true">
          <img src="icons/logo.png" alt="" width="148" height="148">
          <div class="mock">
            <div class="mock-item">${tile('gift')}<span><strong>Livro de receitas</strong><small>Capa dura, se tiver</small></span></div>
            <div class="mock-item">${tile('bag')}<span><strong>Pantufa quentinha</strong><small class="seal">Você comprou ✔</small></span></div>
          </div>
        </div>
      </div>

      <section class="panel how" aria-labelledby="how-title">
        <h2 id="how-title">Como funciona</h2>
        <ol class="steps">
          <li>${tile('users')}<div><h3>O admin cria a família e o evento</h3><p>Quem organiza cria a família, um evento (como o Natal) e um usuário para cada pessoa. Manda o convite pelo WhatsApp e pronto.</p></div></li>
          <li>${tile('list')}<div><h3>Cada um monta sua lista</h3><p>Coloque o que você quer ganhar, com o link da loja e detalhes como tamanho, cor ou modelo.</p></div></li>
          <li>${tile('bell')}<div><h3>A família fica sabendo</h3><p>Entrou pedido novo numa lista? Todo mundo da família recebe um alerta.</p></div></li>
          <li>${tile('check')}<div><h3>Comprou, marcou “Comprei”</h3><p>O presente sai da lista dos outros, para ninguém comprar repetido. Quem vai ganhar não fica sabendo de nada.</p></div></li>
        </ol>
      </section>

      <section class="roles-info" aria-labelledby="roles-title">
        <h2 id="roles-title">Um organiza, todo mundo participa</h2>
        <div class="duo">
          <div class="card">${tile('crown')}<h3>Admin da família</h3><p>Cria a família, adiciona e remove pessoas. E também é membro: tem a própria lista e ganha presente como todo mundo.</p></div>
          <div class="card">${tile('mail')}<h3>Membro</h3><p>Não precisa configurar nada. O admin manda um usuário e um código; no primeiro acesso você só cria a sua senha.</p></div>
        </div>
      </section>

      <section aria-labelledby="perks-title">
        <h2 id="perks-title">Feito para o Natal em família</h2>
        <ul class="perks">
          <li>${tile('repeat')}<div><h3>Sem presente repetido</h3><p>Quando alguém marca que comprou, o resto da família já vê que aquele item foi.</p></div></li>
          <li>${tile('lock')}<div><h3>Surpresa de verdade</h3><p>Você nunca vê se alguém já comprou um pedido seu, nem quem foi. Só descobre no Natal.</p></div></li>
          <li>${tile('phone')}<div><h3>Funciona como app</h3><p>Abra no celular e adicione à tela inicial. Sem baixar nada da loja.</p></div></li>
          <li>${tile('bell')}<div><h3>Avisos na hora</h3><p>Receba notificação quando alguém da família fizer um pedido novo.</p></div></li>
        </ul>
      </section>

      <section class="faq" aria-labelledby="faq-title">
        <h2 id="faq-title">Perguntas frequentes</h2>
        <div class="stack">
          <details><summary>Dá para ter mais de uma família ou evento?</summary><p>Sim. Entre em outras famílias com o código delas, e cada família pode ter vários eventos: Natal, amigo secreto, aniversários. Cada um tem a sua lista.</p></details>
          <details><summary>É grátis?</summary><p>Sim. É só criar a conta e começar a montar a lista.</p></details>
          <details><summary>Quem vê quem comprou cada presente?</summary><p>O resto da família vê, para ninguém comprar a mesma coisa. Quem vai ganhar não vê nada: nem que foi comprado, nem por quem.</p></details>
          <details><summary>Preciso instalar alguma coisa?</summary><p>Não. Funciona no navegador. Se quiser, adicione à tela inicial para abrir como um app.</p></details>
          <details><summary>Uso iPhone. Recebo as notificações?</summary><p>Sim, no iOS 16.4 ou mais novo. No Safari, toque em Compartilhar → Adicionar à Tela de Início, abra o Me Dá Mimo pelo ícone e ative as notificações no Perfil.</p></details>
        </div>
      </section>

      <div class="closing">
        <h2>Bora montar a lista deste Natal?</h2>
        <a class="btn primary big" href="#/criar-conta">Criar minha família</a>
      </div>

      <footer class="foot">© 2026 Me Dá Mimo · Feito com carinho para o Natal em família</footer>
    </div>`);
}

// Admin-created accounts log in by username; their auth e-mail lives on a reserved, never-mailed domain.
const USER_DOMAIN = 'me-da-mimo.invalid';
async function loginEmail(id) {
  id = id.trim().toLowerCase();
  if (!id.includes('@')) return `${id}@${USER_DOMAIN}`;
  const { data } = await supabase.rpc('login_email_for', { e: id }); // optional e-mail of a username account
  return data || id;
}

// First access: username + family code, then the person creates a password.
function firstAccess(prefill = '') {
  const el = section(`
    <div class="auth">
    <h2>Primeiro acesso</h2>
    <p class="muted">Use o usuário e o código que a sua família mandou.</p>
    <form id="f-code" class="card stack">
      <label>Usuário
        <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(prefill)}" placeholder="Ex.: renan.lag">
      </label>
      <label>Código
        <input name="code" required maxlength="6" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" placeholder="Ex.: K7P2QX" class="code">
      </label>
      <button type="submit" class="btn primary big">Continuar</button>
    </form>
    <form id="f-pass" class="card stack" hidden>
      <p class="banner" id="welcome"></p>
      <label>Crie uma senha
        <input name="password" type="password" required minlength="6" autocomplete="new-password">
      </label>
      <label>Repita a senha
        <input name="again" type="password" required minlength="6" autocomplete="new-password">
      </label>
      <p class="muted small">Daqui pra frente você entra com o seu usuário e essa senha.</p>
      <button type="submit" class="btn primary big">Criar senha e entrar</button>
    </form>
    <p class="muted switch">Já criou sua senha? <a href="#/entrar">Entrar</a></p>
    </div>`);
  const fCode = $('#f-code', el);
  const fPass = $('#f-pass', el);
  let creds;
  fCode.onsubmit = submit(fCode, async (f) => {
    const check = ok(await supabase.rpc('claim_check', { u: f.username, code: f.code }));
    if (!check.ok) throw new Error(check.error);
    creds = { username: f.username.trim().toLowerCase(), code: f.code.trim() };
    $('#welcome', el).textContent = `Oi, ${check.name}! Você vai entrar na família ${check.family} 🎄`;
    fCode.hidden = true;
    fPass.hidden = false;
    fPass.elements.password.focus();
  });
  fPass.onsubmit = submit(fPass, async (f) => {
    if (f.password !== f.again) throw new Error('As duas senhas estão diferentes.');
    const { data, error } = await supabase.functions.invoke('claim-user', { body: { ...creds, password: f.password } });
    if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error ?? 'Não deu certo agora. Tente de novo.');
    // Success fires onAuthStateChange, which renders the app.
    ok(await supabase.auth.signInWithPassword({ email: data.email, password: f.password }));
  });
  return el;
}

// Forgot password: the family admin gives a one-time code (works for any account);
// accounts with a real e-mail can also get a link by e-mail.
function forgotPassword(prefill = '') {
  const el = section(`
    <div class="auth">
    <h2>Esqueci a senha</h2>
    <p class="muted">Peça ao admin da sua família um <strong>código de nova senha</strong>. Ele gera em Família → Pessoas.</p>
    <form id="f-reset" class="card stack">
      <label>Usuário ou e-mail
        <input name="login" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(prefill)}" placeholder="Ex.: renan.lag">
      </label>
      <label>Código de nova senha
        <input name="code" required maxlength="6" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" placeholder="Ex.: K7P2QX" class="code">
      </label>
      <label>Nova senha
        <input name="password" type="password" required minlength="6" autocomplete="new-password">
      </label>
      <label>Repita a nova senha
        <input name="again" type="password" required minlength="6" autocomplete="new-password">
      </label>
      <button type="submit" class="btn primary big">Salvar nova senha</button>
    </form>
    <details class="card by-email">
      <summary>Entra com um e-mail de verdade? Receba um link</summary>
      <form id="f-mail" class="stack">
        <label>Seu e-mail
          <input name="email" type="email" required autocomplete="email" inputmode="email">
        </label>
        <button type="submit" class="btn">Enviar link</button>
      </form>
    </details>
    <p class="muted switch"><a href="#/entrar">Voltar para entrar</a></p>
    </div>`);
  const reset = $('#f-reset', el);
  reset.onsubmit = submit(reset, async (f) => {
    if (f.password !== f.again) throw new Error('As duas senhas estão diferentes.');
    const { data, error } = await supabase.functions.invoke('reset-password', { body: { login: f.login, code: f.code, password: f.password } });
    if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error ?? 'Não deu certo agora. Tente de novo.');
    toast('Senha nova salva! 🎄');
    // Success fires onAuthStateChange, which renders the app.
    ok(await supabase.auth.signInWithPassword({ email: data.email, password: f.password }));
  });
  const mail = $('#f-mail', el);
  mail.onsubmit = submit(mail, async (f) => {
    ok(await supabase.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: location.origin + location.pathname }));
    toast('Se esse e-mail tiver conta, chega um link em instantes. Abra neste mesmo aparelho.');
  });
  return el;
}

function newPassword() {
  const el = section(`
    <div class="auth">
    <h2>Crie uma senha nova</h2>
    <form id="f-new" class="card stack">
      <label>Nova senha
        <input name="password" type="password" required minlength="6" autocomplete="new-password">
      </label>
      <label>Repita a nova senha
        <input name="again" type="password" required minlength="6" autocomplete="new-password">
      </label>
      <button type="submit" class="btn primary big">Salvar nova senha</button>
    </form>
    </div>`);
  const form = $('#f-new', el);
  form.onsubmit = submit(form, async (f) => {
    if (f.password !== f.again) throw new Error('As duas senhas estão diferentes.');
    ok(await supabase.auth.updateUser({ password: f.password }));
    recovering = false;
    toast('Senha nova salva! 🎄');
    go('#/');
  });
  return el;
}

function login(signup) {
  const el = section(`
    <div class="auth">
    <h2>${signup ? 'Criar conta' : 'Que bom te ver de novo'}</h2>
    <p class="muted">${signup ? 'Leva menos de um minuto. Depois é só montar sua lista.' : 'Entre para ver sua lista e a da sua família.'}</p>
    <form id="f-auth" class="card stack">
      ${signup ? `<fieldset class="roles">
        <legend>Como você vai usar?</legend>
        <label class="role"><input type="radio" name="role" value="admin" checked>
          ${tile('crown')}<span><strong>Admin da família</strong> Crio a família e adiciono as pessoas pelo e-mail. Também tenho minha lista.</span></label>
        <label class="role"><input type="radio" name="role" value="member">
          ${tile('mail')}<span><strong>Membro da família</strong> Alguém da família já adicionou meu e-mail.</span></label>
      </fieldset>
      <label data-role="admin">Nome da família
        <input name="family" maxlength="80" pattern=".*\\S.*" placeholder="Ex.: Família Silva" required>
      </label>
      <p class="banner" data-role="member" hidden>🎄 Use o mesmo e-mail que o admin cadastrou: você já entra na família.</p>
      <label>Seu nome
        <input name="name" required maxlength="60" pattern=".*\\S.*" autocomplete="name">
      </label>` : ''}
      ${signup ? `<label>E-mail
        <input name="email" type="email" required autocomplete="email" inputmode="email">
      </label>` : `<label>Usuário ou e-mail
        <input name="email" required autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Ex.: renan.lag">
      </label>`}
      <label>Senha
        <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}">
      </label>
      <button type="submit" class="btn primary big">${signup ? 'Criar conta' : 'Entrar'}</button>
    </form>
    <p class="muted switch">${signup ? 'Já tem conta? <a href="#/entrar">Entrar</a>' : '<a href="#/esqueci-senha">Esqueci a senha</a><br>Recebeu usuário e código? <a href="#/primeiro-acesso">Primeiro acesso</a><br>Vai organizar a família? <a href="#/criar-conta">Criar conta</a>'}</p>
    </div>`);
  const form = $('#f-auth', el);
  if (signup) {
    const family = form.elements.family;
    form.onchange = () => {
      const role = form.elements.role.value;
      for (const x of form.querySelectorAll('[data-role]')) x.hidden = x.dataset.role !== role;
      family.required = role === 'admin';
    };
  }
  // Success fires onAuthStateChange, which renders the app.
  form.onsubmit = submit(form, async (f) => {
    const email = f.email.trim();
    if (!signup) return ok(await supabase.auth.signInWithPassword({ email: await loginEmail(email), password: f.password }));
    // The DB trigger creates the family (admin) or joins the inviting ones (member).
    const meta = { name: f.name.trim(), ...(f.role === 'admin' && { family_name: f.family.trim() }) };
    const data = ok(await supabase.auth.signUp({ email, password: f.password, options: { data: meta } }));
    if (!data.session) toast('Conta criada! Confirme pelo link no seu e-mail e depois entre.');
  });
  return el;
}

// Purchases are only visible on other people's gifts (the owner never sees the buyer).
async function purchasesOf(gifts) {
  if (!gifts.length) return {};
  const buys = ok(await supabase.from('purchases').select('gift_id, buyer_id, profiles(name)').in('gift_id', gifts.map((g) => g.id)));
  return Object.fromEntries(buys.map((b) => [b.gift_id, b]));
}

function buyStatus(g, buyOf) {
  const b = buyOf[g.id];
  if (!b) return `<button class="btn primary" data-act="buy" data-id="${esc(g.id)}">${ico('check')} Comprei este</button>`;
  if (b?.buyer_id === me.id) return `<span class="seal">Você comprou ✔</span><button class="btn small" data-act="undo" data-id="${esc(g.id)}">Desfazer</button>`;
  return `<span class="seal">Já comprado por ${esc(b?.profiles?.name ?? 'alguém')}</span>`;
}

const buyActions = {
  buy: async (gid) => {
    const { error } = await supabase.from('purchases').insert({ gift_id: gid });
    render();
    if (error) throw error;
    toast('Anotado! O segredo está guardado 🤫');
  },
  undo: async (gid) => {
    ok(await supabase.from('purchases').delete().eq('gift_id', gid));
    render();
  },
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const PAGE = 10;
// Filters survive re-renders (e.g. after "Comprei este") for the whole session; reset per event.
const give = { event: null, owner: '', status: 'open', q: '', limit: PAGE };
let mineLimit = PAGE;

// Escapes LIKE wildcards so a typed "%" or "_" matches literally.
const likeTerm = (q) => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

const moreButton = (act, shown, total) => (total > shown
  ? `<button class="btn more" data-act="${act}">Mostrar mais <span class="muted">(${shown} de ${total})</span></button>` : '');

// Per-device conveniences (current event, tour seen). Private mode just forgets them.
const remember = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// ---------- current family + event ----------
// Every wish lives in one event of one family; the app always shows one event at a time.
const ctx = { families: [], events: [], family: null, event: null };

const fmtDay = (d) => (d ? new Date(d + 'T12:00').toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' }) : '');
// Next upcoming event, else the most recent one.
function pickEvent(evs) {
  const today = new Date().toISOString().slice(0, 10);
  return evs.find((e) => e.event_date && e.event_date >= today) ?? evs.at(-1) ?? null;
}

async function loadCtx() {
  const [fams, evs] = await Promise.all([
    supabase.from('families').select('id, name, owner_id').order('created_at').then(ok),
    supabase.from('events').select('id, name, event_date, family_id').order('event_date', { nullsFirst: false }).order('created_at').then(ok),
  ]);
  Object.assign(ctx, { families: fams, events: evs });
  ctx.event = evs.find((e) => e.id === recall('mimo_event')) ?? null;
  ctx.family = fams.find((f) => f.id === (ctx.event?.family_id ?? recall('mimo_family'))) ?? fams[0] ?? null;
  if (!ctx.event && ctx.family) ctx.event = pickEvent(evs.filter((e) => e.family_id === ctx.family.id));
  remember('mimo_family', ctx.family?.id);
  remember('mimo_event', ctx.event?.id);
  if (give.event !== ctx.event?.id) Object.assign(give, { event: ctx.event?.id, owner: '', status: 'open', q: '', limit: PAGE });
}

function useEvent(ev) {
  remember('mimo_event', ev.id);
  remember('mimo_family', ev.family_id);
}

const isAdmin = (fam) => fam?.owner_id === me.id;
const natalName = () => {
  const d = new Date();
  return `Natal ${d.getMonth() === 11 && d.getDate() > 25 ? d.getFullYear() + 1 : d.getFullYear()}`;
};

// Family/event switcher, in a sheet so it works the same on any screen.
function openSwitcher() {
  const dlg = $('#sheet');
  $('#sheet-body').innerHTML = `
    <h2>Trocar evento</h2>
    ${ctx.families.map((f) => {
      const evs = ctx.events.filter((e) => e.family_id === f.id);
      return `<div class="sheet-group">
        <h3>${esc(f.name)} ${isAdmin(f) ? '<span class="tag admin">Admin</span>' : ''}</h3>
        ${evs.length ? evs.map((e) => `<button class="pick${e.id === ctx.event?.id ? ' on' : ''}" data-ev="${esc(e.id)}">
          <span>${esc(e.name)}</span><small>${fmtDay(e.event_date)}</small></button>`).join('')
        : `<p class="muted small">Nenhum evento ainda.${isAdmin(f) ? '' : ' O admin vai criar.'}</p>`}
        ${isAdmin(f) ? `<a class="btn small" href="#/familia/${esc(f.id)}" data-close>${ico('plus')} Criar evento</a>` : ''}
      </div>`;
    }).join('')}
    <a class="btn" href="#/familias" data-close>Entrar em outra família com código</a>`;
  $('#sheet-body').onclick = (e) => {
    const pick = e.target.closest('[data-ev]');
    if (pick) {
      useEvent(ctx.events.find((x) => x.id === pick.dataset.ev));
      dlg.close();
      return go('#/');
    }
    if (e.target.closest('[data-close]')) dlg.close();
  };
  dlg.showModal();
}
$('#sheet-close').onclick = () => $('#sheet').close();

const ctxBar = () => `
  <button class="ctx-bar" data-act="switch" aria-label="Evento atual: ${esc(ctx.event?.name ?? 'nenhum')}, família ${esc(ctx.family?.name)}. Trocar">
    <span class="ctx-ico" aria-hidden="true">🎄</span>
    <span class="ctx-text"><strong>${esc(ctx.event?.name ?? 'Sem evento')}</strong><small>${esc(ctx.family?.name)}${ctx.event?.event_date ? ' · ' + fmtDay(ctx.event.event_date) : ''}</small></span>
    <span class="ctx-swap">Trocar</span>
  </button>`;

const giveItem = (g, mineBought) => `
  <li class="item gift${mineBought ? ' bought' : ''}">
    <span class="tile initial" aria-hidden="true">${initial(g.profiles?.name)}</span>
    <div class="item-body"><span class="for">Para ${esc(g.profiles?.name ?? 'alguém')}</span>${giftBody(g)}</div>
    <div class="actions">${mineBought
      ? `<span class="seal">Você comprou ✔</span><button class="btn small" data-act="undo" data-id="${esc(g.id)}">Desfazer</button>`
      : `<button class="btn primary" data-act="buy" data-id="${esc(g.id)}">${ico('check')} Comprei este</button>`}</div>
  </li>`;

const mineItem = (g) => `
  <li class="item gift">
    ${tile('gift')}
    <div class="item-body">
      ${giftBody(g)}
    </div>
    <div class="actions">
      <button class="btn small" data-act="edit" data-id="${esc(g.id)}">Editar</button>
      <button class="btn small danger" data-act="del" data-id="${esc(g.id)}">Apagar</button>
    </div>
  </li>`;

// "Presentes para dar": server-side filter + page, so a big family never renders everything at once.
async function loadGive(box) {
  const token = (box.token = (box.token ?? 0) + 1);
  const cols = 'id, title, url, note, owner_id, created_at, profiles(name)';
  let rows, count;
  if (give.status === 'mine') {
    let q = supabase.from('purchases').select(`created_at, gifts!inner(${cols})`, { count: 'exact' })
      .eq('buyer_id', me.id).eq('gifts.event_id', ctx.event.id);
    if (give.owner) q = q.eq('gifts.owner_id', give.owner);
    if (give.q) q = q.ilike('gifts.title', likeTerm(give.q));
    ({ data: rows, count } = ok2(await q.order('created_at', { ascending: false }).range(0, give.limit - 1)));
    rows = rows.map((r) => r.gifts);
  } else {
    // Anti-join: only gifts nobody bought yet. Owners never reach this (it's other people's gifts).
    let q = supabase.from('gifts').select(`${cols}, purchases(gift_id)`, { count: 'exact' })
      .eq('event_id', ctx.event.id).neq('owner_id', me.id).is('purchases', null);
    if (give.owner) q = q.eq('owner_id', give.owner);
    if (give.q) q = q.ilike('title', likeTerm(give.q));
    ({ data: rows, count } = ok2(await q.order('created_at', { ascending: false }).range(0, give.limit - 1)));
  }
  if (token !== box.token) return; // a newer filter already answered
  box.innerHTML = rows.length
    ? `<ul class="list">${rows.map((g) => giveItem(g, give.status === 'mine')).join('')}</ul>${moreButton('moreGive', rows.length, count)}`
    : emptyState('gift', give.q || give.owner ? 'Nada encontrado' : give.status === 'mine' ? 'Você ainda não marcou nenhuma compra' : 'Nada para comprar agora',
      give.q || give.owner ? 'Tente outro nome ou mostre todas as pessoas.' : give.status === 'mine'
        ? 'Quando você tocar em “Comprei este”, o presente aparece aqui.'
        : 'Quando alguém da família fizer um pedido, ele aparece aqui.');
}

async function loadMine(box) {
  const { data: rows, count } = ok2(await supabase.from('gifts').select('id, title, url, note', { count: 'exact' })
    .eq('event_id', ctx.event.id).eq('owner_id', me.id).order('created_at', { ascending: false }).range(0, mineLimit - 1));
  box.rows = rows;
  box.innerHTML = rows.length
    ? `<ul class="list">${rows.map(mineItem).join('')}</ul>${moreButton('moreMine', rows.length, count)}`
    : emptyState('gift', 'Você ainda não pediu nada', 'Toque em “Adicionar meu pedido” lá em cima.');
}

// Like ok(), but keeps the count of a { count: 'exact' } query.
function ok2({ data, count, error }) {
  if (error) throw error;
  return { data, count };
}

// No family yet: join one with a code (most people) or start one (the organizer).
function noFamily() {
  const el = section(`
    <div id="nudge"></div>
    <p class="hello">Oi, ${esc(me.name)}! 🎄</p>
    <div class="intro">
      <h2>Vamos começar</h2>
      <p>Você ainda não está em nenhuma família. Escolha uma opção:</p>
    </div>
    ${joinForm()}
    ${createFamilyForm()}`);
  wireFamilyForms(el);
  return el;
}

const joinForm = () => `
  <form id="f-join" class="card stack">
    <h3>Tenho um código de família</h3>
    <p class="muted small">Peça o código para quem organiza a família.</p>
    <label>Código da família
      <input name="code" required maxlength="6" autocapitalize="characters" spellcheck="false" autocomplete="off" placeholder="Ex.: K7P2QX" class="code">
    </label>
    <button type="submit" class="btn primary">Entrar na família</button>
  </form>`;

const createFamilyForm = () => `
  <form id="f-fam" class="card stack">
    <h3>Vou organizar uma família</h3>
    <p class="muted small">Você vira o admin: cria os eventos e adiciona as pessoas.</p>
    <label>Nome da família
      <input name="name" required maxlength="80" pattern=".*\\S.*" placeholder="Ex.: Família Silva">
    </label>
    <button type="submit" class="btn">Criar família</button>
  </form>`;

function wireFamilyForms(el) {
  const join = $('#f-join', el);
  if (join) join.onsubmit = submit(join, async (f) => {
    const fam = ok(await supabase.rpc('join_with_code', { code: f.code }));
    if (!fam) throw new Error('Código não encontrado. Confira as letras e tente de novo.');
    remember('mimo_family', fam);
    remember('mimo_event', null);
    toast('Você entrou na família! 🎄');
    go('#/');
  });
  const create = $('#f-fam', el);
  if (create) create.onsubmit = submit(create, async (f) => {
    const fam = ok(await supabase.from('families').insert({ name: f.name.trim() }).select('id').single());
    remember('mimo_family', fam.id);
    remember('mimo_event', null);
    go('#/'); // the home now walks the admin through the first event
  });
}

// Admin's first step: create the event the wishes will live in.
const eventForm = (id, title, intro) => `
  <form id="${id}" class="card stack event-form">
    ${title}
    ${intro}
    <div class="chips" role="group" aria-label="Sugestões">
      ${[natalName(), 'Amigo secreto', 'Aniversário', 'Dia das Crianças'].map((n) =>
        `<button type="button" class="chip-btn" data-suggest="${esc(n)}">${esc(n)}</button>`).join('')}
    </div>
    <label>Nome do evento
      <input name="name" required maxlength="60" pattern=".*\\S.*" placeholder="Ex.: ${esc(natalName())}" autocomplete="off">
    </label>
    <label>Data (se quiser)
      <input name="date" type="date">
    </label>
    <button type="submit" class="btn primary big">Criar evento</button>
  </form>`;

function wireEventForm(form, familyId) {
  form.onclick = (e) => {
    const s = e.target.closest('[data-suggest]');
    if (!s) return;
    form.elements.name.value = s.dataset.suggest;
    if (s.dataset.suggest.startsWith('Natal')) form.elements.date.value = `${s.dataset.suggest.slice(-4)}-12-25`;
    form.elements.name.focus();
  };
  form.onsubmit = submit(form, async (f) => {
    const ev = ok(await supabase.from('events').insert({ family_id: familyId, name: f.name.trim(), event_date: f.date || null })
      .select('id, family_id').single());
    useEvent(ev);
    toast('Evento criado! Agora é só fazer os pedidos 🎁');
    go('#/');
  });
}

function noEvent() {
  const admin = isAdmin(ctx.family);
  const el = section(`
    <div id="nudge"></div>
    ${ctx.families.length > 1 || ctx.events.length ? ctxBar() : ''}
    <p class="hello">Oi, ${esc(me.name)}! 🎄</p>
    ${admin ? eventForm('f-event', '<span class="step-chip">Primeiro passo</span><h2>Crie o primeiro evento</h2>',
      `<p>O evento é a ocasião dos presentes, como o Natal. Os pedidos da família <strong>${esc(ctx.family.name)}</strong> ficam dentro dele.</p>`)
    : emptyState('gift', 'Ainda não tem evento', `Quem organiza a família ${esc(ctx.family.name)} vai criar um evento, como o Natal. Aí você já pode fazer seus pedidos.`)}`);
  if (admin) wireEventForm($('#f-event', el), ctx.family.id);
  on(el, { switch: openSwitcher });
  return el;
}

const TOUR_KEY = 'mimo_tour';
function tourSteps() {
  return [
    { target: '.ctx-bar', title: 'Família e evento', text: 'Aqui aparece o evento de agora. Toque para trocar de família ou de evento.' },
    { target: '[data-act=add]', title: 'Seu pedido', text: 'Toque aqui para dizer o que você quer ganhar. Dá para colocar o link da loja.' },
    { target: '#h-fam', title: 'Sua família', text: 'Toque numa pessoa para ver os pedidos dela.' },
    { target: '#h-give', title: 'Presentes para dar', text: 'Comprou algo? Toque em “Comprei este”. Quem vai ganhar não fica sabendo.' },
    { target: '#nav', title: 'Menu', text: isAdmin(ctx.family)
      ? 'Em Família você cria eventos, adiciona pessoas e vê o código. Em Alertas ficam as novidades.'
      : 'Em Família você vê as pessoas e entra em outras famílias. Em Alertas ficam as novidades.' },
  ];
}

// Home = one event: install/notify nudge, add my wish, my family, what I can give, my wishes.
async function home() {
  await loadCtx();
  if (!ctx.family) return noFamily();
  if (!ctx.event) return noEvent();
  const [people, counts] = await Promise.all([
    supabase.from('family_members').select('user_id, profiles(name)').eq('family_id', ctx.family.id).neq('user_id', me.id).then(ok),
    supabase.from('gifts').select('owner_id').eq('event_id', ctx.event.id).neq('owner_id', me.id).then(ok),
  ]);
  people.sort((a, b) => (a.profiles?.name ?? '').localeCompare(b.profiles?.name ?? ''));
  if (give.owner && !people.some((p) => p.user_id === give.owner)) give.owner = '';
  const wishesOf = (id) => counts.filter((g) => g.owner_id === id).length;
  const admin = isAdmin(ctx.family);
  const addPeople = admin ? `<a class="btn small" href="#/familia/${esc(ctx.family.id)}">${ico('plus')} Adicionar pessoa</a>` : '';

  const el = section(`
    <div id="nudge"></div>
    ${ctxBar()}
    <div class="feature">
      <h2>O que você quer ganhar?</h2>
      <p>Conte para a família o que você quer no ${esc(ctx.event.name)}. Dá para colocar o link da loja, o tamanho e a cor.</p>
      <button class="btn dark big" data-act="add">${ico('plus')} Adicionar meu pedido</button>
    </div>

    <section class="block" aria-labelledby="h-fam">
      <div class="head"><h2 id="h-fam">Minha família</h2>${addPeople}</div>
      ${people.length ? `<p class="muted">Toque numa pessoa para ver os pedidos dela.</p>
      <ul class="list people">${people.map((p) => `
        <li><a class="item link-item" href="#/pessoa/${esc(p.user_id)}">
          <span class="tile initial" aria-hidden="true">${initial(p.profiles?.name)}</span>
          <span class="item-title">${esc(p.profiles?.name ?? 'Alguém')}<small>${plural(wishesOf(p.user_id), 'pedido', 'pedidos')}</small></span>
        </a></li>`).join('')}</ul>`
      : emptyState('users', 'Só você por aqui', admin
        ? 'Toque em “Adicionar pessoa” para chamar a família.'
        : 'Quem organiza a família vai adicionar as outras pessoas.')}
    </section>

    <section class="block" aria-labelledby="h-give">
      <div class="head"><h2 id="h-give">Presentes para dar</h2></div>
      <p class="muted">Comprou algum? Toque em “Comprei este”. Quem vai ganhar não fica sabendo que foi você.</p>
      <div class="filters" role="group" aria-label="Filtrar presentes">
        <div class="seg" role="group" aria-label="Mostrar">
          <button class="btn small" data-act="status" data-id="open" aria-pressed="${give.status === 'open'}">Para comprar</button>
          <button class="btn small" data-act="status" data-id="mine" aria-pressed="${give.status === 'mine'}">Que eu comprei</button>
        </div>
        ${people.length > 1 ? `<label class="inline">Pessoa
          <select id="f-owner"><option value="">Todas</option>${people.map((p) =>
            `<option value="${esc(p.user_id)}"${p.user_id === give.owner ? ' selected' : ''}>${esc(p.profiles?.name ?? 'Alguém')}</option>`).join('')}</select>
        </label>` : ''}
        <label class="inline grow">Procurar
          <input id="f-q" type="search" value="${esc(give.q)}" placeholder="Ex.: livro" autocomplete="off" enterkeyhint="search">
        </label>
      </div>
      <div id="give" aria-live="polite"></div>
    </section>

    <section class="block" aria-labelledby="h-mine">
      <div class="head"><h2 id="h-mine">Meus pedidos</h2></div>
      <div id="mine"></div>
    </section>`);

  const giveBox = $('#give', el);
  const mineBox = $('#mine', el);
  const refilter = () => { give.limit = PAGE; return loadGive(giveBox); };
  let typing;
  $('#f-q', el).oninput = (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => { give.q = e.target.value.trim(); refilter().catch((err) => toast(friendly(err))); }, 300);
  };
  const owner = $('#f-owner', el);
  if (owner) owner.onchange = () => { give.owner = owner.value; refilter().catch((err) => toast(friendly(err))); };

  on(el, {
    ...buyActions,
    switch: openSwitcher,
    status: (v) => {
      give.status = v;
      for (const b of el.querySelectorAll('[data-act=status]')) b.setAttribute('aria-pressed', b.dataset.id === v);
      return refilter();
    },
    moreGive: () => { give.limit += PAGE; return loadGive(giveBox); },
    moreMine: () => { mineLimit += PAGE; return loadMine(mineBox); },
    add: () => giftDialog(),
    edit: (id) => giftDialog(mineBox.rows.find((g) => g.id === id)),
    del: async (id) => {
      const g = mineBox.rows.find((x) => x.id === id);
      if (!await ask(`Apagar o pedido "${g.title}"?`, 'Apagar')) return;
      ok(await supabase.from('gifts').delete().eq('id', id));
      render();
    },
  });
  await Promise.all([loadGive(giveBox), loadMine(mineBox), nudge($('#nudge', el))]);
  // First visit: a short tour once the screen is on the page.
  if (!recall(TOUR_KEY)) el.afterShow = () => startTour(tourSteps(), { onDone: () => remember(TOUR_KEY, '1') });
  return el;
}

function giftDialog(gift) {
  const dlg = $('#gift-dialog');
  const form = $('#gift-form');
  const error = $('#gift-error');
  $('#gift-dialog-title').textContent = gift ? 'Editar meu pedido' : `Novo pedido · ${ctx.event.name}`;
  for (const k of ['title', 'url', 'note']) form.elements[k].value = gift?.[k] ?? '';
  error.textContent = '';
  // Errors show inside the dialog: the toast sits under the modal's top layer.
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const f = Object.fromEntries(new FormData(form));
    const row = { title: f.title.trim(), url: f.url.trim() || null, note: f.note.trim() || null };
    if (!row.title) return (error.textContent = 'Escreva o que você quer ganhar.');
    if (row.url && !validUrl(row.url)) return (error.textContent = 'O link precisa ser um endereço começando com http:// ou https://');
    btn.disabled = true;
    try {
      ok(gift ? await supabase.from('gifts').update(row).eq('id', gift.id)
        : await supabase.from('gifts').insert({ ...row, event_id: ctx.event.id }));
      dlg.close();
      toast(gift ? 'Pedido atualizado!' : 'Pedido adicionado! A família vai ser avisada 🎁');
      render();
    } catch (err) {
      error.textContent = friendly(err);
    } finally {
      btn.disabled = false;
    }
  };
  dlg.showModal();
  form.elements.title.focus();
}
$('#gift-cancel').onclick = () => $('#gift-dialog').close();

async function families() {
  await loadCtx();
  const el = section(`
    <h2>Família</h2>
    ${ctx.families.length ? `<ul class="list">${ctx.families.map((f) => `
      <li><a class="item link-item" href="#/familia/${esc(f.id)}">
        ${tile('home')}<span class="item-title">${esc(f.name)}<small>${plural(ctx.events.filter((e) => e.family_id === f.id).length, 'evento', 'eventos')}</small></span>
        ${isAdmin(f) ? '<span class="tag admin">Admin</span>' : '<span class="tag">Membro</span>'}
      </a></li>`).join('')}</ul>`
    : emptyState('users', 'Você ainda não está em nenhuma família', 'Entre com o código que a família mandou ou crie a sua.')}
    ${joinForm()}
    ${createFamilyForm()}`);
  wireFamilyForms(el);
  return el;
}

// Opens the invite with explicit buttons: share/copy need a fresh tap, not the end of an await.
function shareInvite(text, title = 'Convite pronto 🎄') {
  const dlg = $('#invite-dialog');
  $('#invite-title').textContent = title;
  const field = $('#invite-text');
  field.value = text;
  $('#invite-wa').href = 'https://wa.me/?text=' + encodeURIComponent(text);
  const share = $('#invite-share');
  share.hidden = !navigator.share;
  share.onclick = () => navigator.share({ text }).catch(() => {});
  $('#invite-copy').onclick = async (e) => flash(e.currentTarget, await copyText(text, field) ? 'Copiado ✔' : 'Selecione e copie');
  $('#invite-close').onclick = () => dlg.close();
  dlg.showModal();
}

// "Pessoas" filter state; reset when another family is opened.
const people = { fam: null, status: 'active', q: '', limit: PAGE };
// For PostgREST or(): drop the characters that are its own syntax.
const orTerm = (q) => likeTerm(q.replace(/[,()]/g, ' '));

async function family(id) {
  if (people.fam !== id) Object.assign(people, { fam: id, status: 'active', q: '', limit: PAGE });
  const [fam, code, events] = await Promise.all([
    supabase.from('families').select('id, name, owner_id').eq('id', id).maybeSingle().then(ok),
    supabase.rpc('family_access_code', { fam: id }).then(ok), // null unless I'm the admin
    supabase.from('events').select('id, name, event_date, family_id').eq('family_id', id).order('event_date', { nullsFirst: false }).order('created_at').then(ok),
  ]);
  if (!fam) return section('<a class="back" href="#/familias">← Família</a><p class="empty">Família não encontrada.</p>');
  const owner = fam.owner_id === me.id;
  if (!owner) people.status = 'active';
  const head = (table) => supabase.from(table).select('*', { count: 'exact', head: true }).eq('family_id', id).then(ok2).then((r) => r.count);
  const [nActive, nPending, nEmail] = await Promise.all([
    head('family_members'), owner ? head('pending_users') : 0, owner ? head('family_invites') : 0,
  ]);
  const link = location.origin + location.pathname + '#/criar-conta';
  const inviteText = (p) => `Oi, ${p.name}! 🎄 Entre na família "${fam.name}" no Me Dá Mimo:\n`
    + `${location.origin + location.pathname}#/primeiro-acesso/${p.username}\nUsuário: ${p.username}\nCódigo: ${code}`;
  const segBtn = (v, label, n) => `<button class="btn small" data-act="pstatus" data-id="${v}" aria-pressed="${people.status === v}">${label} <span class="chip">${n}</span></button>`;

  const el = section(`
    <a class="back" href="#/familias">← Família</a>
    <h2>${esc(fam.name)}</h2>
    <section class="block" aria-labelledby="h-events">
      <div class="head"><h2 id="h-events">Eventos</h2></div>
      ${events.length ? `<ul class="list">${events.map((e) => `
        <li class="item${owner ? ' wrap' : ''}">
          ${tile('gift')}
          <span class="item-title">${esc(e.name)}<small>${e.event_date ? fmtDay(e.event_date) : 'sem data'}</small></span>
          <div class="actions">
            <button class="btn small primary" data-act="openEvent" data-id="${esc(e.id)}">Abrir</button>
            ${owner ? `<button class="btn small danger" data-act="delEvent" data-id="${esc(e.id)}" data-name="${esc(e.name)}">Apagar</button>` : ''}
          </div>
        </li>`).join('')}</ul>`
      : emptyState('gift', 'Nenhum evento ainda', owner ? 'Crie o primeiro aqui embaixo, como o Natal.' : 'Quem organiza a família vai criar.')}
      ${owner ? `<details class="card by-email"${events.length ? '' : ' open'}>
        <summary>Criar evento</summary>
        ${eventForm('f-event', '', '<p class="muted small">Ex.: Natal, amigo secreto, aniversário. Cada evento tem a sua lista de pedidos.</p>')}
      </details>` : ''}
    </section>
    <section class="block" aria-labelledby="h-people">
      <div class="head"><h2 id="h-people">Pessoas</h2></div>
      <div class="filters" role="group" aria-label="Filtrar pessoas">
        ${owner ? `<div class="seg" role="group" aria-label="Mostrar">
          ${segBtn('active', 'Ativas', nActive)}${segBtn('pending', 'Aguardando', nPending)}${nEmail ? segBtn('email', 'Por e-mail', nEmail) : ''}
        </div>` : ''}
        <label class="inline grow">Procurar
          <input id="p-q" type="search" value="${esc(people.q)}" placeholder="Nome ou usuário" autocomplete="off" enterkeyhint="search">
        </label>
      </div>
      <div id="people" aria-live="polite"></div>
    </section>
    ${owner ? `
      <section class="block" aria-labelledby="h-add">
        <h2 id="h-add">Adicionar pessoa</h2>
        <form id="f-user" class="card stack">
          <h3>Criar usuário</h3>
          <p class="muted small">Crie o usuário e mande o convite. No primeiro acesso a pessoa usa o usuário + o código e cria a própria senha.</p>
          <label>Nome da pessoa
            <input name="name" required maxlength="60" pattern=".*\\S.*" placeholder="Ex.: Renan Lage" autocomplete="off">
          </label>
          <label>Usuário
            <input name="username" required maxlength="30" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="Ex.: renan.lag" aria-describedby="u-hint">
          </label>
          <p id="u-hint" class="small hint" aria-live="polite">Letras minúsculas, números, ponto ou _ (3 a 30).</p>
          <button type="submit" class="btn primary">Criar usuário</button>
        </form>
        <details class="card by-email">
          <summary>Prefere convidar por e-mail?</summary>
          <form id="f-add" class="stack">
            <p class="muted small">Se a pessoa já tem conta, entra na hora. Se não, entra quando criar a conta com este e-mail em <strong>${esc(link)}</strong>.</p>
            <label>E-mail da pessoa
              <input name="email" type="email" required autocomplete="off" inputmode="email">
            </label>
            <button type="submit" class="btn primary">Adicionar por e-mail</button>
          </form>
        </details>
        <div class="card stack code-card">
          <h3>Código da família</h3>
          <p class="muted small">Vai junto no convite. Vale para o primeiro acesso de quem foi criado nesta família.</p>
          <strong class="code-big" aria-label="Código ${esc(code.split('').join(' '))}">${esc(code)}</strong>
          <div class="actions">
            <button class="btn small" data-act="copyCode">Copiar código</button>
            <button class="btn small danger" data-act="renew">Gerar código novo</button>
          </div>
        </div>
      </section>
      <p class="end"><button class="btn danger" data-act="destroy">Apagar família</button></p>`
    : '<p class="end"><button class="btn danger" data-act="leave">Sair da família</button></p>'}`);

  // Server-side filter + page, like "Presentes para dar".
  const box = $('#people', el);
  const loadPeople = async () => {
    const token = (box.token = (box.token ?? 0) + 1);
    const t = people.q && orTerm(people.q);
    let q, render1;
    if (people.status === 'pending') {
      q = supabase.from('pending_users').select('username, name', { count: 'exact' }).eq('family_id', id);
      if (t) q = q.or(`name.ilike.${t},username.ilike.${t}`);
      q = q.order('created_at', { ascending: false });
      render1 = (p) => `
        <li class="item wrap">
          <span class="tile initial" aria-hidden="true">${initial(p.name)}</span>
          <span class="item-title">${esc(p.name)}<small>${esc(p.username)} · ainda não entrou</small></span>
          <div class="actions">
            <button class="btn small primary" data-act="sendInvite" data-id="${esc(p.username)}" data-name="${esc(p.name)}">Enviar convite</button>
            <button class="btn small danger" data-act="unpend" data-id="${esc(p.username)}">Cancelar</button>
          </div>
        </li>`;
    } else if (people.status === 'email') {
      q = supabase.from('family_invites').select('email', { count: 'exact' }).eq('family_id', id);
      if (t) q = q.ilike('email', t);
      q = q.order('created_at', { ascending: false });
      render1 = (i) => `
        <li class="item">${tile('mail')}<span class="item-title">${esc(i.email)}<small>espera criar a conta</small></span>
          <button class="btn small danger" data-act="uninvite" data-id="${esc(i.email)}">Cancelar</button></li>`;
    } else {
      q = supabase.from('family_members').select('user_id, joined_at, profiles!inner(name, username)', { count: 'exact' }).eq('family_id', id);
      if (t) q = q.or(`name.ilike.${t},username.ilike.${t}`, { referencedTable: 'profiles' });
      q = q.order('joined_at');
      render1 = (m) => {
        const name = m.profiles?.name ?? 'Alguém';
        const mine = m.user_id === me.id;
        return `
        <li class="item${owner && m.user_id !== fam.owner_id ? ' wrap' : ''}">
          <span class="tile initial" aria-hidden="true">${initial(name)}</span>
          <span class="item-title"><a href="${mine ? '#/' : '#/pessoa/' + esc(m.user_id)}">${esc(name)}${mine ? ' (você)' : ''}</a>${m.profiles?.username ? `<small>${esc(m.profiles.username)}</small>` : ''}</span>
          ${m.user_id === fam.owner_id ? '<span class="tag admin">Admin</span>' : '<span class="tag">Membro</span>'}
          ${owner && m.user_id !== fam.owner_id ? `<div class="actions">
            <button class="btn small" data-act="resetPass" data-id="${esc(m.user_id)}" data-name="${esc(name)}" data-login="${esc(m.profiles?.username ?? '')}">Nova senha</button>
            <button class="btn small danger" data-act="remove" data-id="${esc(m.user_id)}" data-name="${esc(name)}">Remover</button></div>` : ''}
        </li>`;
      };
    }
    const { data: rows, count } = ok2(await q.range(0, people.limit - 1));
    if (token !== box.token) return; // a newer search already answered
    box.innerHTML = rows.length
      ? `<ul class="list">${rows.map(render1).join('')}</ul>${moreButton('morePeople', rows.length, count)}`
      : emptyState('users', people.q ? 'Ninguém encontrado' : people.status === 'pending' ? 'Todo mundo já entrou 🎉' : 'Ninguém por aqui',
        people.q ? 'Tente outro nome ou usuário.' : people.status === 'pending' ? 'Quem você criar aparece aqui até fazer o primeiro acesso.' : 'Adicione pessoas logo abaixo.');
  };
  let typing;
  $('#p-q', el).oninput = (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => { people.q = e.target.value.trim(); people.limit = PAGE; loadPeople().catch((err) => toast(friendly(err))); }, 300);
  };
  await loadPeople();

  const evForm = $('#f-event', el);
  if (evForm) wireEventForm(evForm, id);

  const userForm = $('#f-user', el);
  if (userForm) {
    const { name, username } = userForm.elements;
    const hint = $('#u-hint', el);
    let edited = false, timer;
    const check = () => {
      clearTimeout(timer);
      const u = username.value.trim().toLowerCase();
      if (!u) { hint.textContent = 'Letras minúsculas, números, ponto ou _ (3 a 30).'; hint.className = 'small hint'; return; }
      timer = setTimeout(async () => {
        const { data } = await supabase.rpc('username_available', { u });
        if (username.value.trim().toLowerCase() !== u) return; // typed again meanwhile
        hint.textContent = data ? `✔ "${u}" está livre` : `✖ "${u}" já existe ou não é válido`;
        hint.className = `small hint ${data ? 'good' : 'bad'}`;
      }, 300);
    };
    // Suggests "first.last" from the name until the admin types a username.
    name.oninput = () => {
      if (edited) return;
      const parts = name.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/);
      username.value = parts.length > 1 ? `${parts[0]}.${parts.at(-1)}` : parts[0] ?? '';
      check();
    };
    username.oninput = () => { edited = !!username.value; check(); };
    userForm.onsubmit = submit(userForm, async (f) => {
      const u = ok(await supabase.rpc('create_family_user', { fam: id, u: f.username, member_name: f.name }));
      people.status = 'pending'; // show the new person in "Aguardando"
      people.q = '';
      await render(); // the list shows the new person before the invite opens
      shareInvite(inviteText({ name: f.name.trim(), username: u }));
    });
  }

  const addForm = $('#f-add', el);
  if (addForm) addForm.onsubmit = submit(addForm, async (f) => {
    const result = ok(await supabase.rpc('add_member', { fam: id, member_email: f.email }));
    toast(result === 'added' ? 'Membro adicionado! 🎄' : 'Pronto! Quando criar a conta com esse e-mail, já entra na família.');
    render();
  });

  on(el, {
    pstatus: (v) => {
      people.status = v;
      people.limit = PAGE;
      for (const b of el.querySelectorAll('[data-act=pstatus]')) b.setAttribute('aria-pressed', b.dataset.id === v);
      return loadPeople();
    },
    morePeople: () => { people.limit += PAGE; return loadPeople(); },
    openEvent: (ev) => { useEvent(events.find((e) => e.id === ev)); go('#/'); },
    delEvent: async (ev, btn) => {
      if (!await ask(`Apagar o evento "${btn.dataset.name}"? Os pedidos dele também vão embora.`, 'Apagar evento')) return;
      ok(await supabase.from('events').delete().eq('id', ev));
      render();
    },
    resetPass: async (uid, btn) => {
      if (!await ask(`Gerar um código de nova senha para ${btn.dataset.name}? Vale por 24 horas e só uma vez.`, 'Gerar código')) return;
      const c = ok(await supabase.rpc('issue_password_reset', { member: uid }));
      const login = btn.dataset.login;
      shareInvite(`Oi, ${btn.dataset.name}! Seu código para criar uma senha nova no Me Dá Mimo é ${c} (vale 24 horas).\n`
        + `Abra ${location.origin + location.pathname}#/esqueci-senha${login ? '/' + login : ''}`
        + (login ? `\nUsuário: ${login}` : '\nUse o seu e-mail de sempre.'), 'Código de nova senha 🔑');
    },
    copyCode: async (_, btn) => flash(btn, await copyText(code) ? 'Copiado ✔' : code),
    sendInvite: (u, btn) => shareInvite(inviteText({ username: u, name: btn.dataset.name })),
    unpend: async (u) => {
      if (!await ask(`Cancelar o usuário ${u}? O convite dele para de funcionar.`, 'Cancelar usuário')) return;
      ok(await supabase.from('pending_users').delete().eq('username', u));
      render();
    },
    renew: async () => {
      if (!await ask('Gerar um código novo? O código atual para de valer. Quem ainda não fez o primeiro acesso entra com o código novo: reenvie o convite.', 'Gerar código novo')) return;
      ok(await supabase.rpc('renew_access_code', { fam: id }));
      await render();
      toast('Código novo gerado. Reenvie o convite para quem ainda não entrou.');
    },
    uninvite: async (email) => {
      ok(await supabase.from('family_invites').delete().eq('family_id', id).eq('email', email));
      render();
    },
    remove: async (uid, btn) => {
      if (!await ask(`Remover ${btn.dataset.name} da família?`, 'Remover')) return;
      ok(await supabase.from('family_members').delete().eq('family_id', id).eq('user_id', uid));
      render();
    },
    destroy: async () => {
      if (!await ask(`Apagar a família "${fam.name}"? Isso não pode ser desfeito.`, 'Apagar família')) return;
      ok(await supabase.from('families').delete().eq('id', id));
      go('#/familias');
    },
    leave: async () => {
      if (!await ask(`Sair da família "${fam.name}"?`, 'Sair')) return;
      ok(await supabase.from('family_members').delete().eq('family_id', id).eq('user_id', me.id));
      go('#/familias');
    },
  });
  return el;
}

async function person(id) {
  if (id === me.id) {
    go('#/');
    return section('');
  }
  await loadCtx();
  if (!ctx.event) return go('#/'), section('');
  const [p, gifts] = await Promise.all([
    supabase.from('profiles').select('name').eq('id', id).maybeSingle().then(ok),
    // shortcut: one person's list capped at 100, add paging if someone ever asks for more
    supabase.from('gifts').select('id, title, url, note').eq('owner_id', id).eq('event_id', ctx.event.id).order('created_at').limit(100).then(ok),
  ]);
  if (!p) return section('<a class="back" href="#/">← Início</a><p class="empty">Pessoa não encontrada.</p>');
  const buyOf = await purchasesOf(gifts);

  const el = section(`
    <a class="back" href="#/">← Início</a>
    <div class="feature-title">
      <h2>Pedidos de ${esc(p.name)}</h2>
      <span class="chip">${gifts.length}</span>
    </div>
    <p class="for">${esc(ctx.event.name)} · ${esc(ctx.family.name)}</p>
    <p class="muted">Escolha um presente e marque “Comprei este”. ${esc(p.name)} não fica sabendo de nada.</p>
    ${gifts.length ? `<ul class="list">${gifts.map((g) => `
      <li class="item gift${buyOf[g.id] ? ' bought' : ''}">
        ${tile(buyOf[g.id] ? 'check' : 'gift')}
        <div class="item-body">${giftBody(g)}</div>
        <div class="actions">${buyStatus(g, buyOf)}</div>
      </li>`).join('')}</ul>`
    : emptyState('gift', 'Nenhum pedido ainda', `Quando ${esc(p.name)} pedir algo, você recebe um alerta.`)}`);

  on(el, buyActions);
  return el;
}

let alertsLimit = 20;

async function alerts() {
  const { data: list, count } = ok2(await supabase.from('notifications')
    .select('id, title, body, url, read_at, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(0, alertsLimit - 1));
  const el = section(`
    <div class="head">
      <h2>Alertas</h2>
      ${list.some((n) => !n.read_at) ? '<button class="btn small" data-act="all">Marcar todas como lidas</button>' : ''}
    </div>
    ${list.length ? `<ul class="list">${list.map((n) => `
      <li><button class="item alert${n.read_at ? '' : ' unread'}" data-act="open" data-id="${esc(n.id)}">
        ${tile('bell')}
        <span class="item-body">
          <strong>${esc(n.title)}</strong>
          <span>${esc(n.body)}</span>
          <small>${fmtDate(n.created_at)}${n.read_at ? '' : ' <span class="chip">nova</span>'}</small>
        </span>
      </button></li>`).join('')}</ul>${moreButton('more', list.length, count)}`
    : emptyState('bell', 'Nenhum alerta por enquanto', 'Quando alguém da família fizer um pedido novo, o aviso aparece aqui.')}`);
  on(el, {
    more: () => { alertsLimit += 20; return render(); },
    open: async (id) => {
      const n = list.find((x) => String(x.id) === id);
      if (!n.read_at) ok(await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id));
      go(n.url?.startsWith('#') ? n.url : '#/alertas');
    },
    all: async () => {
      ok(await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null));
      render();
    },
  });
  return el;
}

const PUSH_TEXT = {
  unsupported: 'Este navegador não suporta notificações.',
  'needs-install': 'No iPhone: toque em Compartilhar → Adicionar à Tela de Início, depois abra o app pelo ícone para ativar as notificações.',
  denied: 'As notificações estão bloqueadas. Libere nas configurações do navegador para este site.',
  default: 'Receba um aviso quando alguém da família fizer um pedido novo.',
};

// Permission "granted" survives unsubscribing, so check the real subscription.
const subscribedHere = async () => !!(await navigator.serviceWorker
  ?.getRegistration().then((r) => r?.pushManager.getSubscription()).catch(() => null));

// ---------- install / notifications nudge ----------
// Push only really works installed (iPhone: only installed), so we keep asking until it's done.
// "Agora não" shrinks the card to a one-line reminder for a day; it never fully disappears.

const DAY = 24 * 60 * 60 * 1000;
const snoozed = () => { try { return Date.now() - Number(localStorage.getItem('mimo_nudge')) < DAY; } catch { return false; } };
const setSnooze = (on) => { try { on ? localStorage.setItem('mimo_nudge', Date.now()) : localStorage.removeItem('mimo_nudge'); } catch { /* private mode */ } };

const steps = (items) => `<ol class="howto">${items.map((t) => `<li><span>${t}</span></li>`).join('')}</ol>`;
const later = '<button class="btn link" data-act="snooze">Agora não</button>';

function installCard() {
  const intro = '<h2>Coloque o Me Dá Mimo no seu celular</h2><p>Fica um ícone na tela, abre como app e <strong>avisa você</strong> quando alguém da família fizer um pedido.</p>';
  if (inAppBrowser()) return `<div class="nudge">${intro}
    ${steps([`Toque nos três pontinhos ${ico('dots')} no canto da tela.`, 'Escolha <strong>Abrir no navegador</strong> (Chrome ou Safari).', 'Lá aparece o botão para instalar.'])}
    <div class="actions"><button class="btn primary" data-act="copyLink">Copiar o link</button>${later}</div></div>`;
  if (canPrompt()) return `<div class="nudge">${intro}
    <div class="actions"><button class="btn primary big" data-act="install">${ico('phone')} Instalar agora</button>${later}</div></div>`;
  if (platform() === 'ios') return `<div class="nudge">${intro}
    ${steps([`Toque no botão <strong>Compartilhar</strong> <span class="key">${ico('share')}</span> (no Safari, fica embaixo).`,
      `Role e toque em <strong>Adicionar à Tela de Início</strong> <span class="key">${ico('addsq')}</span>.`,
      'Toque em <strong>Adicionar</strong> e abra o Me Dá Mimo pelo ícone novo.'])}
    <div class="actions">${later}</div></div>`;
  if (platform() === 'android') return `<div class="nudge">${intro}
    ${steps([`Toque no menu <span class="key">${ico('dots')}</span> do navegador (no canto de cima).`,
      'Escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.', 'Confirme e abra o Me Dá Mimo pelo ícone novo.'])}
    <div class="actions">${later}</div></div>`;
  return `<div class="nudge">${intro}
    <p>O melhor é abrir este site <strong>no seu celular</strong>. No computador, use o ícone de instalar na barra de endereço.</p>
    <div class="actions">${later}</div></div>`;
}

const PUSH_DENIED = {
  ios: 'No iPhone: Ajustes → Notificações → Me Dá Mimo → Permitir Notificações.',
  android: 'No Android: segure o ícone do Me Dá Mimo → Informações do app → Notificações → Permitir.',
  desktop: 'Clique no cadeado ao lado do endereço e permita as notificações.',
};

async function nudge(box) {
  let html = '';
  if (!installed()) {
    html = snoozed() ? `<button class="nudge-slim" data-act="unsnooze">${ico('phone')}<span>Instale o app para receber os avisos da família</span><strong>Ver como</strong></button>` : installCard();
  } else {
    const state = pushState();
    if (state === 'denied') html = `<div class="nudge"><h2>Os avisos estão bloqueados</h2><p>Sem eles você não fica sabendo dos pedidos da família.</p><p class="muted">${PUSH_DENIED[platform()]}</p></div>`;
    else if (state !== 'unsupported' && !(state === 'granted' && await subscribedHere())) {
      html = snoozed() ? `<button class="nudge-slim" data-act="notify">${ico('bell')}<span>Ative os avisos para saber dos pedidos</span><strong>Ativar</strong></button>`
        : `<div class="nudge"><h2>Falta só ativar os avisos 🔔</h2><p>Assim você fica sabendo na hora quando alguém da família fizer um pedido.</p>
          <div class="actions"><button class="btn primary big" data-act="notify">${ico('bell')} Ativar avisos</button>${later}</div></div>`;
    }
  }
  box.innerHTML = html;
  if (box.wired) return;
  box.wired = true;
  on(box, {
    install: async () => { if (await promptInstall()) toast('Pronto! Abra o Me Dá Mimo pelo ícone 🎄'); return nudge(box); },
    snooze: () => { setSnooze(true); return nudge(box); },
    unsnooze: () => { setSnooze(false); return nudge(box); },
    notify: async () => { try { await enablePush(supabase); toast('Avisos ativados! 🔔'); } finally { await nudge(box); } },
    copyLink: async () => { await navigator.clipboard.writeText(location.origin + location.pathname); toast('Link copiado! Cole no Chrome ou Safari.'); },
  });
}
addEventListener('mimo:installable', () => { const box = $('#nudge'); if (box) nudge(box); });

async function pushBox(box) {
  const state = pushState();
  const subscribed = state === 'granted' && await subscribedHere();
  const text = state === 'granted' ? (subscribed ? 'Notificações ativadas neste aparelho. ✔' : 'Notificações desativadas neste aparelho.') : PUSH_TEXT[state];
  const button = subscribed ? '<button class="btn" data-act="pushOff">Desativar notificações</button>'
    : state === 'default' || state === 'granted' ? '<button class="btn primary" data-act="pushOn">Ativar notificações</button>' : '';
  box.innerHTML = `<p>${esc(text)}</p>${button}`;
}

async function profile() {
  const alias = me.username
    ? ok(await supabase.from('login_aliases').select('email').maybeSingle())?.email ?? '' : null;
  const el = section(`
    <h2>Perfil</h2>
    <div class="panel profile-head">
      <span class="tile initial big" aria-hidden="true">${initial(me.name)}</span>
      <div><span>Conectado como</span><strong>${esc(me.username ?? user.email)}</strong></div>
    </div>
    <form id="f-name" class="card stack">
      <label>Seu nome
        <input name="name" required maxlength="60" pattern=".*\\S.*" autocomplete="name" value="${esc(me.name)}">
      </label>
      <button type="submit" class="btn primary">Salvar nome</button>
    </form>
    ${alias === null ? '' : `<form id="f-alias" class="card stack">
      <h3>E-mail (opcional)</h3>
      <p class="muted small">Se quiser, entre também com o seu e-mail. A senha é a mesma.</p>
      <label>Seu e-mail
        <input name="email" type="email" autocomplete="email" inputmode="email" value="${esc(alias)}" required>
      </label>
      <button type="submit" class="btn primary">Salvar e-mail</button>
    </form>`}
    <div class="card stack">
      <h3>Notificações</h3>
      <div id="push" class="stack"></div>
    </div>
    <div class="card stack">
      <h3>Ajuda</h3>
      <p class="muted small">Veja de novo o passo a passo do app.</p>
      <button class="btn" data-act="tour">Ver o tour de novo</button>
    </div>
    <p class="end"><button class="btn danger" data-act="logout">Sair da conta</button></p>`);
  const box = $('#push', el);
  await pushBox(box);

  const form = $('#f-name', el);
  form.onsubmit = submit(form, async (f) => {
    const name = f.name.trim();
    ok(await supabase.from('profiles').update({ name }).eq('id', me.id));
    me.name = name;
    toast('Nome salvo!');
  });
  const aliasForm = $('#f-alias', el);
  if (aliasForm) aliasForm.onsubmit = submit(aliasForm, async (f) => {
    ok(await supabase.rpc('set_login_email', { e: f.email }));
    toast('Pronto! Agora você também entra com esse e-mail.');
  });

  on(el, {
    pushOn: async () => {
      try { await enablePush(supabase); } finally { await pushBox(box); }
    },
    pushOff: async () => {
      try { await disablePush(supabase); } finally { await pushBox(box); }
    },
    tour: () => { remember(TOUR_KEY, null); go('#/'); },
    logout: async () => {
      // Shared devices: stop sending this user's alerts here.
      await disablePush(supabase).catch(() => {});
      ok(await supabase.auth.signOut());
    },
  });
  return el;
}

// ---------- boot ----------

async function start() {
  me = null;
  if (user) {
    const { data } = await supabase.from('profiles').select('id, name, username').eq('id', user.id).maybeSingle();
    me = data ?? { id: user.id, name: user.user_metadata?.name ?? '' };
  }
  render(true);
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    recovering = true;
    if (booted) setTimeout(() => render(true)); // same user: the early return below would skip the screen
  }
  const next = session?.user ?? null;
  if (booted && next?.id === user?.id) return; // token refresh, etc.
  booted = true;
  user = next;
  setTimeout(start); // calling supabase inside this callback can deadlock supabase-js
});

addEventListener('hashchange', () => render(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !user) return;
  if (location.hash === '#/alertas') render();
  else updateBadge();
});

registerSW().catch((e) => console.warn('service worker:', e));
