import { supabase } from './supabase.js';
import { registerSW, pushState, enablePush, disablePush } from './push.js';
import { installed, canPrompt, promptInstall, inAppBrowser, platform } from './install.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const nav = $('#nav');

let user = null; // auth user
let me = null; // { id, name } from profiles
let booted = false;
let seq = 0; // render token: a slow, older render never overwrites a newer one

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
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(friendly(e)); } finally { if (btn) btn.disabled = false; }
}

// Click delegation: <button data-act="name" data-id="…"> calls actions.name(id).
function on(el, actions) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && actions[b.dataset.act]) busy(b, () => actions[b.dataset.act](b.dataset.id));
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
  if (!user) return show(first ? firstAccess(first[1]) : hash === '#/entrar' ? login(false) : hash === '#/criar-conta' ? login(true) : landing(), focus);
  if (first || hash === '#/entrar' || hash === '#/criar-conta') return go('#/');

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
    if (token === seq) show(el, focus);
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
          <li>${tile('users')}<div><h3>O admin cria a família</h3><p>Quem organiza o Natal cria a família e um usuário para cada pessoa. Manda o convite pelo WhatsApp e pronto.</p></div></li>
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
    <p class="muted switch">${signup ? 'Já tem conta? <a href="#/entrar">Entrar</a>' : 'Recebeu usuário e código? <a href="#/primeiro-acesso">Primeiro acesso</a><br>Vai organizar a família? <a href="#/criar-conta">Criar conta</a>'}</p>
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
// Filters survive re-renders (e.g. after "Comprei este") for the whole session.
const give = { owner: '', status: 'open', q: '', limit: PAGE };
let mineLimit = PAGE;

// Escapes LIKE wildcards so a typed "%" or "_" matches literally.
const likeTerm = (q) => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

const moreButton = (act, shown, total) => (total > shown
  ? `<button class="btn more" data-act="${act}">Mostrar mais <span class="muted">(${shown} de ${total})</span></button>` : '');

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
    let q = supabase.from('purchases').select(`created_at, gifts!inner(${cols})`, { count: 'exact' }).eq('buyer_id', me.id);
    if (give.owner) q = q.eq('gifts.owner_id', give.owner);
    if (give.q) q = q.ilike('gifts.title', likeTerm(give.q));
    ({ data: rows, count } = ok2(await q.order('created_at', { ascending: false }).range(0, give.limit - 1)));
    rows = rows.map((r) => r.gifts);
  } else {
    // Anti-join: only gifts nobody bought yet. Owners never reach this (it's other people's gifts).
    let q = supabase.from('gifts').select(`${cols}, purchases(gift_id)`, { count: 'exact' }).neq('owner_id', me.id).is('purchases', null);
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
    .eq('owner_id', me.id).order('created_at', { ascending: false }).range(0, mineLimit - 1));
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

// Everything on one screen: install/notify nudge, add my wish, my family, what I can give, my wishes.
async function home() {
  const [people, fams, counts] = await Promise.all([
    supabase.from('profiles').select('id, name').neq('id', me.id).order('name').then(ok),
    supabase.from('families').select('id, owner_id').order('created_at').then(ok),
    supabase.from('gifts').select('owner_id').neq('owner_id', me.id).then(ok),
  ]);
  if (give.owner && !people.some((p) => p.id === give.owner)) give.owner = '';
  const wishesOf = (id) => counts.filter((g) => g.owner_id === id).length;
  const myFam = fams.find((f) => f.owner_id === me.id);
  const addPeople = myFam ? `<a class="btn small" href="#/familia/${esc(myFam.id)}">${ico('plus')} Adicionar pessoa</a>` : '';

  const el = section(`
    <div id="nudge"></div>
    <p class="hello">Oi, ${esc(me.name)}! 🎄</p>
    <div class="feature">
      <h2>O que você quer ganhar?</h2>
      <p>Conte para a família. Dá para colocar o link da loja, o tamanho e a cor.</p>
      <button class="btn dark big" data-act="add">${ico('plus')} Adicionar meu pedido</button>
    </div>

    <section class="block" aria-labelledby="h-fam">
      <div class="head"><h2 id="h-fam">Minha família</h2>${addPeople}</div>
      ${people.length ? `<p class="muted">Toque numa pessoa para ver todos os pedidos dela.</p>
      <ul class="list people">${people.map((p) => `
        <li><a class="item link-item" href="#/pessoa/${esc(p.id)}">
          <span class="tile initial" aria-hidden="true">${initial(p.name)}</span>
          <span class="item-title">${esc(p.name)}<small>${plural(wishesOf(p.id), 'pedido', 'pedidos')}</small></span>
        </a></li>`).join('')}</ul>`
      : emptyState('users', 'Sua família ainda está vazia', myFam
        ? 'Toque em “Adicionar pessoa” e coloque o e-mail de cada um.'
        : 'Peça para quem organiza a família adicionar o seu e-mail.')}
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
            `<option value="${esc(p.id)}"${p.id === give.owner ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
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
      if (!confirm(`Apagar o pedido "${g.title}"?`)) return;
      ok(await supabase.from('gifts').delete().eq('id', id));
      render();
    },
  });
  await Promise.all([loadGive(giveBox), loadMine(mineBox), nudge($('#nudge', el))]);
  return el;
}

function giftDialog(gift) {
  const dlg = $('#gift-dialog');
  const form = $('#gift-form');
  const error = $('#gift-error');
  $('#gift-dialog-title').textContent = gift ? 'Editar meu pedido' : 'Novo pedido';
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
      ok(gift ? await supabase.from('gifts').update(row).eq('id', gift.id) : await supabase.from('gifts').insert(row));
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
  const fams = ok(await supabase.from('families').select('id, name, owner_id').order('created_at'));
  const el = section(`
    <h2>Família</h2>
    ${fams.length ? `<ul class="list">${fams.map((f) => `
      <li><a class="item link-item" href="#/familia/${esc(f.id)}">
        ${tile('home')}<span class="item-title">${esc(f.name)}</span>${f.owner_id === me.id ? '<span class="tag admin">Admin</span>' : '<span class="tag">Membro</span>'}
      </a></li>`).join('')}</ul>`
    : emptyState('users', 'Você ainda não está em nenhuma família', 'Crie a sua aqui embaixo ou peça para o admin da sua família adicionar seu e-mail.')}
    <form id="f-fam" class="card stack">
      <h3>Criar uma família</h3>
      <p class="muted small">Você vira o admin e pode adicionar as pessoas pelo e-mail.</p>
      <label>Nome da família
        <input name="name" required maxlength="80" pattern=".*\\S.*" placeholder="Ex.: Família Silva">
      </label>
      <button type="submit" class="btn primary">Criar</button>
    </form>`);
  const form = $('#f-fam', el);
  form.onsubmit = submit(form, async (f) => {
    const fam = ok(await supabase.from('families').insert({ name: f.name.trim() }).select('id').single());
    go('#/familia/' + fam.id);
  });
  return el;
}

// Phone: native share sheet (WhatsApp etc.). Elsewhere: clipboard, so the admin can paste it.
async function shareInvite(text) {
  if (navigator.share) {
    try { return await navigator.share({ text }); } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Convite copiado! Cole no WhatsApp da pessoa.');
  } catch {
    prompt('Copie o convite:', text);
  }
}

async function family(id) {
  const [fam, members, invites, pending, code] = await Promise.all([
    supabase.from('families').select('id, name, owner_id').eq('id', id).maybeSingle().then(ok),
    supabase.from('family_members').select('user_id, joined_at, profiles(name)').eq('family_id', id).order('joined_at').then(ok),
    supabase.from('family_invites').select('email').eq('family_id', id).order('created_at').then(ok),
    supabase.from('pending_users').select('username, name').eq('family_id', id).order('created_at').then(ok),
    supabase.rpc('family_access_code', { fam: id }).then(ok), // null unless I'm the admin
  ]);
  if (!fam) return section('<a class="back" href="#/familias">← Família</a><p class="empty">Família não encontrada.</p>');
  const owner = fam.owner_id === me.id;
  const link = location.origin + location.pathname + '#/criar-conta';
  const inviteText = (p) => `Oi, ${p.name}! 🎄 Entre na família "${fam.name}" no Me Dá Mimo:\n`
    + `${location.origin + location.pathname}#/primeiro-acesso/${p.username}\nUsuário: ${p.username}\nCódigo: ${code}`;
  const nameOf = (m) => m.profiles?.name ?? 'Alguém';

  const el = section(`
    <a class="back" href="#/familias">← Família</a>
    <h2>${esc(fam.name)}</h2>
    <div class="panel">
      <h3>Membros <span class="chip">${members.length}</span></h3>
      <ul class="list">${members.map((m) => `
        <li class="item member">
          <span class="tile initial" aria-hidden="true">${initial(nameOf(m))}</span>
          <a class="item-title" href="${m.user_id === me.id ? '#/' : '#/pessoa/' + esc(m.user_id)}">${esc(nameOf(m))}${m.user_id === me.id ? ' (você)' : ''}</a>
          ${m.user_id === fam.owner_id ? '<span class="tag admin">Admin</span>'
            : `<span class="tag">Membro</span>${owner ? `<button class="btn small danger" data-act="remove" data-id="${esc(m.user_id)}">Remover</button>` : ''}`}
        </li>`).join('')}</ul>
    </div>
    ${owner ? `
      <section class="block" aria-labelledby="h-add">
        <h2 id="h-add">Adicionar pessoa</h2>
        <div class="card stack code-card">
          <span class="muted small">Código da família (vai junto no convite)</span>
          <strong class="code-big">${esc(code)}</strong>
          <button class="btn small" data-act="renew">Gerar código novo</button>
        </div>
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
        ${pending.length ? `<h3>Ainda não fizeram o primeiro acesso <span class="chip">${pending.length}</span></h3>
        <ul class="list">${pending.map((p) => `
          <li class="item">
            <span class="tile initial" aria-hidden="true">${initial(p.name)}</span>
            <span class="item-title">${esc(p.name)}<small>${esc(p.username)}</small></span>
            <div class="actions">
              <button class="btn small primary" data-act="sendInvite" data-id="${esc(p.username)}">Enviar convite</button>
              <button class="btn small danger" data-act="unpend" data-id="${esc(p.username)}">Cancelar</button>
            </div>
          </li>`).join('')}</ul>` : ''}
        <details class="card by-email">
          <summary>Prefere convidar por e-mail?</summary>
          <form id="f-add" class="stack">
            <p class="muted small">Se a pessoa já tem conta, entra na hora. Se não, entra quando criar a conta com este e-mail em <strong>${esc(link)}</strong>.</p>
            <label>E-mail da pessoa
              <input name="email" type="email" required autocomplete="off" inputmode="email">
            </label>
            <button type="submit" class="btn primary">Adicionar por e-mail</button>
          </form>
          ${invites.length ? `<ul class="list">${invites.map((i) => `
            <li class="item">${tile('mail')}<span class="item-title">${esc(i.email)}</span>
              <button class="btn small danger" data-act="uninvite" data-id="${esc(i.email)}">Cancelar</button></li>`).join('')}</ul>` : ''}
        </details>
      </section>
      <p class="end"><button class="btn danger" data-act="destroy">Apagar família</button></p>`
    : '<p class="end"><button class="btn danger" data-act="leave">Sair da família</button></p>'}`);

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
      await shareInvite(inviteText({ name: f.name.trim(), username: u }));
      render();
    });
  }

  const addForm = $('#f-add', el);
  if (addForm) addForm.onsubmit = submit(addForm, async (f) => {
    const result = ok(await supabase.rpc('add_member', { fam: id, member_email: f.email }));
    toast(result === 'added' ? 'Membro adicionado! 🎄' : 'Pronto! Quando criar a conta com esse e-mail, já entra na família.');
    render();
  });

  on(el, {
    sendInvite: (u) => shareInvite(inviteText(pending.find((p) => p.username === u))),
    unpend: async (u) => {
      if (!confirm(`Cancelar o usuário ${u}?`)) return;
      ok(await supabase.from('pending_users').delete().eq('username', u));
      render();
    },
    renew: async () => {
      if (!confirm('Gerar um código novo? O código antigo para de funcionar para quem ainda não fez o primeiro acesso.')) return;
      ok(await supabase.rpc('renew_access_code', { fam: id }));
      toast('Código novo gerado. Reenvie o convite para quem ainda não entrou.');
      render();
    },
    uninvite: async (email) => {
      ok(await supabase.from('family_invites').delete().eq('family_id', id).eq('email', email));
      render();
    },
    remove: async (uid) => {
      if (!confirm(`Remover ${nameOf(members.find((m) => m.user_id === uid))} da família?`)) return;
      ok(await supabase.from('family_members').delete().eq('family_id', id).eq('user_id', uid));
      render();
    },
    destroy: async () => {
      if (!confirm(`Apagar a família "${fam.name}"? Isso não pode ser desfeito.`)) return;
      ok(await supabase.from('families').delete().eq('id', id));
      go('#/familias');
    },
    leave: async () => {
      if (!confirm(`Sair da família "${fam.name}"?`)) return;
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
  const [p, gifts] = await Promise.all([
    supabase.from('profiles').select('name').eq('id', id).maybeSingle().then(ok),
    // shortcut: one person's list capped at 100, add paging if someone ever asks for more
    supabase.from('gifts').select('id, title, url, note').eq('owner_id', id).order('created_at').limit(100).then(ok),
  ]);
  if (!p) return section('<a class="back" href="#/">← Início</a><p class="empty">Pessoa não encontrada.</p>');
  const buyOf = await purchasesOf(gifts);

  const el = section(`
    <a class="back" href="#/">← Início</a>
    <div class="feature-title">
      <h2>Pedidos de ${esc(p.name)}</h2>
      <span class="chip">${gifts.length}</span>
    </div>
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

supabase.auth.onAuthStateChange((_event, session) => {
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
