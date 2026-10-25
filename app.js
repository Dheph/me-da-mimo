import { supabase } from './supabase.js';
import { registerSW, pushState, enablePush, disablePush } from './push.js';

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
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
};
const ico = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const tile = (name, extra = '') => `<span class="tile${extra}" aria-hidden="true">${ico(name)}</span>`;
const initial = (name) => esc((String(name ?? '').trim()[0] ?? '?').toUpperCase());
const emptyState = (icon, title, text) => `<div class="empty">${tile(icon, ' big')}<p><strong>${title}</strong>${text}</p></div>`;

// ---------- router ----------

const routes = [
  [/^(#\/?)?$/, myList, 'home'],
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
  if (!user) return show(hash === '#/entrar' ? login(false) : hash === '#/criar-conta' ? login(true) : landing(), focus);
  if (hash === '#/entrar' || hash === '#/criar-conta') return go('#/');

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
          <p class="lead">Cada pessoa da família monta sua lista de mimos. Quem vai presentear escolhe um, marca que comprou, e a surpresa continua guardada até a noite de Natal.</p>
          <div class="actions">
            <a class="btn primary big" href="#/criar-conta">Criar minha família</a>
            <a class="btn big" href="#/entrar">Já tenho conta</a>
          </div>
          <p class="muted small">É grátis e funciona direto no navegador do celular.</p>
        </div>
        <div class="hero-art" aria-hidden="true">
          <img src="icons/logo.png" alt="" width="148" height="148">
          <div class="mock">
            <div class="mock-item">${tile('gift')}<span><strong>Livro de receitas</strong><small>Capa dura, se tiver</small></span></div>
            <div class="mock-item">${tile('bag')}<span><strong>Pantufa quentinha</strong><small class="seal">Alguém já comprou 🎉</small></span></div>
          </div>
        </div>
      </div>

      <section class="panel how" aria-labelledby="how-title">
        <h2 id="how-title">Como funciona</h2>
        <ol class="steps">
          <li>${tile('users')}<div><h3>O admin cria a família</h3><p>Quem organiza o Natal cria a família e adiciona cada pessoa pelo e-mail.</p></div></li>
          <li>${tile('list')}<div><h3>Cada um monta sua lista</h3><p>Coloque o que você quer ganhar, com o link da loja e detalhes como tamanho, cor ou modelo.</p></div></li>
          <li>${tile('bell')}<div><h3>A família fica sabendo</h3><p>Entrou presente novo numa lista? Todo mundo da família recebe um alerta.</p></div></li>
          <li>${tile('check')}<div><h3>Comprou, marcou “Comprei”</h3><p>O presenteado recebe o aviso de que alguém comprou, sem saber quem foi. A surpresa fica guardada.</p></div></li>
        </ol>
      </section>

      <section class="roles-info" aria-labelledby="roles-title">
        <h2 id="roles-title">Um organiza, todo mundo participa</h2>
        <div class="duo">
          <div class="card">${tile('crown')}<h3>Admin da família</h3><p>Cria a família, adiciona e remove pessoas. E também é membro: tem a própria lista e ganha presente como todo mundo.</p></div>
          <div class="card">${tile('mail')}<h3>Membro</h3><p>Não precisa configurar nada. Crie sua conta com o mesmo e-mail que o admin cadastrou e você já entra na família.</p></div>
        </div>
      </section>

      <section aria-labelledby="perks-title">
        <h2 id="perks-title">Feito para o Natal em família</h2>
        <ul class="perks">
          <li>${tile('repeat')}<div><h3>Sem presente repetido</h3><p>Quando alguém marca que comprou, o resto da família já vê que aquele item foi.</p></div></li>
          <li>${tile('lock')}<div><h3>Segredo garantido</h3><p>Você fica sabendo que ganhou algo da sua lista, nunca quem comprou.</p></div></li>
          <li>${tile('phone')}<div><h3>Funciona como app</h3><p>Abra no celular e adicione à tela inicial. Sem baixar nada da loja.</p></div></li>
          <li>${tile('bell')}<div><h3>Avisos na hora</h3><p>Receba notificação quando entrar presente novo ou alguém comprar um mimo seu.</p></div></li>
        </ul>
      </section>

      <section class="faq" aria-labelledby="faq-title">
        <h2 id="faq-title">Perguntas frequentes</h2>
        <div class="stack">
          <details><summary>É grátis?</summary><p>Sim. É só criar a conta e começar a montar a lista.</p></details>
          <details><summary>Quem vê quem comprou cada presente?</summary><p>O resto da família vê, para ninguém comprar a mesma coisa. Quem vai ganhar só vê o selo “Alguém já comprou”, sem o nome.</p></details>
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
      <label>E-mail
        <input name="email" type="email" required autocomplete="email" inputmode="email">
      </label>
      <label>Senha
        <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}">
      </label>
      <button type="submit" class="btn primary big">${signup ? 'Criar conta' : 'Entrar'}</button>
    </form>
    <p class="muted switch">${signup ? 'Já tem conta? <a href="#/entrar">Entrar</a>' : 'Primeira vez? <a href="#/criar-conta">Criar conta</a>'}</p>
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
    if (!signup) return ok(await supabase.auth.signInWithPassword({ email, password: f.password }));
    // The DB trigger creates the family (admin) or joins the inviting ones (member).
    const meta = { name: f.name.trim(), ...(f.role === 'admin' && { family_name: f.family.trim() }) };
    const data = ok(await supabase.auth.signUp({ email, password: f.password, options: { data: meta } }));
    if (!data.session) toast('Conta criada! Confirme pelo link no seu e-mail e depois entre.');
  });
  return el;
}

async function myList() {
  const gifts = ok(await supabase.from('gifts').select('id, title, url, note, purchased').eq('owner_id', me.id).order('created_at'));
  const el = section(`
    <div class="feature">
      <div class="feature-title">
        <h2>Minha lista</h2>
        <span class="chip">${gifts.length} ${gifts.length === 1 ? 'mimo' : 'mimos'}</span>
      </div>
      <p>Olá, ${esc(me.name)}! O que você quer ganhar neste Natal?</p>
      <button class="btn dark" data-act="add">${ico('plus')} Adicionar presente</button>
    </div>
    ${gifts.length ? `<ul class="list">${gifts.map((g) => `
      <li class="item gift">
        ${tile('gift')}
        <div class="item-body">
          ${giftBody(g)}
          ${g.purchased ? '<p class="seal">Alguém já comprou 🎉</p>' : ''}
        </div>
        <div class="actions">
          <button class="btn small" data-act="edit" data-id="${esc(g.id)}">Editar</button>
          <button class="btn small danger" data-act="del" data-id="${esc(g.id)}">Apagar</button>
        </div>
      </li>`).join('')}</ul>`
    : emptyState('gift', 'Sua lista ainda está vazia', 'Comece pelo que você mais quer ganhar. Dá para colocar o link da loja e o tamanho.')}`);
  on(el, {
    add: () => giftDialog(),
    edit: (id) => giftDialog(gifts.find((g) => g.id === id)),
    del: async (id) => {
      const g = gifts.find((x) => x.id === id);
      if (!confirm(`Apagar "${g.title}" da sua lista?`)) return;
      ok(await supabase.from('gifts').delete().eq('id', id));
      render();
    },
  });
  return el;
}

function giftDialog(gift) {
  const dlg = $('#gift-dialog');
  const form = $('#gift-form');
  const error = $('#gift-error');
  $('#gift-dialog-title').textContent = gift ? 'Editar presente' : 'Novo presente';
  for (const k of ['title', 'url', 'note']) form.elements[k].value = gift?.[k] ?? '';
  error.textContent = '';
  // Errors show inside the dialog: the toast sits under the modal's top layer.
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const f = Object.fromEntries(new FormData(form));
    const row = { title: f.title.trim(), url: f.url.trim() || null, note: f.note.trim() || null };
    if (!row.title) return (error.textContent = 'Dê um nome ao presente.');
    if (row.url && !validUrl(row.url)) return (error.textContent = 'O link precisa ser um endereço começando com http:// ou https://');
    btn.disabled = true;
    try {
      ok(gift ? await supabase.from('gifts').update(row).eq('id', gift.id) : await supabase.from('gifts').insert(row));
      dlg.close();
      toast(gift ? 'Presente atualizado!' : 'Presente adicionado! 🎁');
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
    <h2>Famílias</h2>
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

async function family(id) {
  const [fam, members, invites] = await Promise.all([
    supabase.from('families').select('id, name, owner_id').eq('id', id).maybeSingle().then(ok),
    supabase.from('family_members').select('user_id, joined_at, profiles(name)').eq('family_id', id).order('joined_at').then(ok),
    supabase.from('family_invites').select('email').eq('family_id', id).order('created_at').then(ok),
  ]);
  if (!fam) return section('<a class="back" href="#/familias">← Famílias</a><p class="empty">Família não encontrada.</p>');
  const owner = fam.owner_id === me.id;
  const link = location.origin + location.pathname + '#/criar-conta';
  const nameOf = (m) => m.profiles?.name ?? 'Alguém';

  const el = section(`
    <a class="back" href="#/familias">← Famílias</a>
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
      ${invites.length ? `<h3>Aguardando criar conta <span class="chip">${invites.length}</span></h3>
      <ul class="list">${invites.map((i) => `
        <li class="item">${tile('mail')}<span class="item-title">${esc(i.email)}</span>
          <button class="btn small danger" data-act="uninvite" data-id="${esc(i.email)}">Cancelar</button></li>`).join('')}</ul>` : ''}
      <form id="f-add" class="card stack">
        <h3>Adicionar membro</h3>
        <p class="muted small">Se a pessoa já tem conta, entra na hora. Se não, entra assim que criar a conta com este e-mail.</p>
        <label>E-mail da pessoa
          <input name="email" type="email" required autocomplete="off" inputmode="email">
        </label>
        <button type="submit" class="btn primary">Adicionar</button>
      </form>
      <div class="card stack">
        <h3>Quem ainda não tem conta</h3>
        <label>Mande este link para criar a conta com o e-mail que você adicionou
          <input id="invite" readonly value="${esc(link)}">
        </label>
        <div class="actions">
          <button class="btn" data-act="copy">Copiar link</button>
          ${navigator.share ? '<button class="btn primary" data-act="share">Compartilhar</button>' : ''}
        </div>
      </div>
      <p class="end"><button class="btn danger" data-act="destroy">Apagar família</button></p>`
    : '<p class="end"><button class="btn danger" data-act="leave">Sair da família</button></p>'}`);

  const addForm = $('#f-add', el);
  if (addForm) addForm.onsubmit = submit(addForm, async (f) => {
    const result = ok(await supabase.rpc('add_member', { fam: id, member_email: f.email }));
    toast(result === 'added' ? 'Membro adicionado! 🎄' : 'Pronto! Quando criar a conta com esse e-mail, já entra na família.');
    render();
  });

  on(el, {
    uninvite: async (email) => {
      ok(await supabase.from('family_invites').delete().eq('family_id', id).eq('email', email));
      render();
    },
    remove: async (uid) => {
      if (!confirm(`Remover ${nameOf(members.find((m) => m.user_id === uid))} da família?`)) return;
      ok(await supabase.from('family_members').delete().eq('family_id', id).eq('user_id', uid));
      render();
    },
    copy: async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copiado!');
      } catch {
        $('#invite', el).select();
        toast('Selecione e copie o link.');
      }
    },
    share: async () => {
      try {
        await navigator.share({ title: 'Me Dá Mimo', text: `Crie sua conta no Me Dá Mimo para entrar na família "${fam.name}" 🎄`, url: link });
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
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
    supabase.from('gifts').select('id, title, url, note, purchased').eq('owner_id', id).order('created_at').then(ok),
  ]);
  if (!p) return section('<a class="back" href="#/familias">← Famílias</a><p class="empty">Pessoa não encontrada.</p>');
  const buys = gifts.length
    ? ok(await supabase.from('purchases').select('gift_id, buyer_id, profiles(name)').in('gift_id', gifts.map((g) => g.id)))
    : [];
  const buyOf = Object.fromEntries(buys.map((b) => [b.gift_id, b]));

  const status = (g) => {
    const b = buyOf[g.id];
    if (!b && !g.purchased) return `<button class="btn primary" data-act="buy" data-id="${esc(g.id)}">${ico('check')} Comprei este</button>`;
    if (b?.buyer_id === me.id) return `<span class="seal">Você comprou ✔</span><button class="btn small" data-act="undo" data-id="${esc(g.id)}">Desfazer</button>`;
    return `<span class="seal">Já comprado por ${esc(b?.profiles?.name ?? 'alguém')}</span>`;
  };

  const el = section(`
    <a class="back" href="#/familias">← Famílias</a>
    <div class="feature-title">
      <h2>Lista de ${esc(p.name)}</h2>
      <span class="chip">${gifts.length} ${gifts.length === 1 ? 'mimo' : 'mimos'}</span>
    </div>
    <p class="muted">Escolha um presente e marque “Comprei este”. ${esc(p.name)} só fica sabendo que alguém comprou, não quem.</p>
    ${gifts.length ? `<ul class="list">${gifts.map((g) => `
      <li class="item gift${g.purchased ? ' bought' : ''}">
        ${tile(g.purchased ? 'check' : 'gift')}
        <div class="item-body">${giftBody(g)}</div>
        <div class="actions">${status(g)}</div>
      </li>`).join('')}</ul>`
    : emptyState('gift', 'Nenhum presente na lista ainda', `Quando ${esc(p.name)} adicionar um mimo, você recebe um alerta.`)}`);

  on(el, {
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
  });
  return el;
}

async function alerts() {
  const list = ok(await supabase.from('notifications')
    .select('id, title, body, url, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100));
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
      </button></li>`).join('')}</ul>`
    : emptyState('bell', 'Nenhum alerta por enquanto', 'Quando alguém da família adicionar um presente ou comprar um mimo seu, o aviso aparece aqui.')}`);
  on(el, {
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
  default: 'Receba um aviso quando a família adicionar presentes ou alguém comprar um mimo seu.',
};

async function pushBox(box) {
  const state = pushState();
  // Permission "granted" survives unsubscribing, so check the real subscription.
  const subscribed = state === 'granted' && !!(await navigator.serviceWorker
    ?.getRegistration().then((r) => r?.pushManager.getSubscription()).catch(() => null));
  const text = state === 'granted' ? (subscribed ? 'Notificações ativadas neste aparelho. ✔' : 'Notificações desativadas neste aparelho.') : PUSH_TEXT[state];
  const button = subscribed ? '<button class="btn" data-act="pushOff">Desativar notificações</button>'
    : state === 'default' || state === 'granted' ? '<button class="btn primary" data-act="pushOn">Ativar notificações</button>' : '';
  box.innerHTML = `<p>${esc(text)}</p>${button}`;
}

async function profile() {
  const el = section(`
    <h2>Perfil</h2>
    <div class="panel profile-head">
      <span class="tile initial big" aria-hidden="true">${initial(me.name)}</span>
      <div><span>Conectado como</span><strong>${esc(user.email)}</strong></div>
    </div>
    <form id="f-name" class="card stack">
      <label>Seu nome
        <input name="name" required maxlength="60" pattern=".*\\S.*" autocomplete="name" value="${esc(me.name)}">
      </label>
      <button type="submit" class="btn primary">Salvar nome</button>
    </form>
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
    const { data } = await supabase.from('profiles').select('id, name').eq('id', user.id).maybeSingle();
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
