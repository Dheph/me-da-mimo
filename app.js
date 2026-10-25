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
  if (!user) return show(login(hash === '#/criar-conta'), focus);
  if (hash === '#/criar-conta') return go('#/');

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

function login(signup) {
  const el = section(`
    <h2>${signup ? 'Criar conta' : 'Entrar'}</h2>
    ${signup ? '<p class="banner">🎄 Use o mesmo e-mail que a sua família cadastrou: você já entra nela.</p>' : ''}
    <form id="f-auth" class="card stack">
      ${signup ? `<label>Seu nome
        <input name="name" required maxlength="60" pattern=".*\\S.*" autocomplete="name">
      </label>` : ''}
      <label>E-mail
        <input name="email" type="email" required autocomplete="email" inputmode="email">
      </label>
      <label>Senha
        <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}">
      </label>
      <button type="submit" class="btn primary">${signup ? 'Criar conta' : 'Entrar'}</button>
    </form>
    <p class="muted">${signup ? 'Já tem conta? <a href="#/">Entrar</a>' : 'Primeira vez? <a href="#/criar-conta">Criar conta</a>'}</p>`);
  const form = $('#f-auth', el);
  // Success fires onAuthStateChange, which renders the app.
  form.onsubmit = submit(form, async (f) => {
    const email = f.email.trim();
    if (!signup) return ok(await supabase.auth.signInWithPassword({ email, password: f.password }));
    const data = ok(await supabase.auth.signUp({ email, password: f.password, options: { data: { name: f.name.trim() } } }));
    if (!data.session) toast('Conta criada! Confirme pelo link no seu e-mail e depois entre.');
  });
  return el;
}

async function myList() {
  const gifts = ok(await supabase.from('gifts').select('id, title, url, note, purchased').eq('owner_id', me.id).order('created_at'));
  const el = section(`
    <div class="head">
      <h2>Minha lista</h2>
      <button class="btn primary" data-act="add">+ Adicionar</button>
    </div>
    <p class="muted">Olá, ${esc(me.name)}! O que você quer ganhar neste Natal?</p>
    ${gifts.length ? `<ul class="list">${gifts.map((g) => `
      <li class="card gift">
        ${giftBody(g)}
        ${g.purchased ? '<p class="seal">Alguém já comprou 🎉</p>' : ''}
        <div class="actions">
          <button class="btn small" data-act="edit" data-id="${esc(g.id)}">Editar</button>
          <button class="btn small danger" data-act="del" data-id="${esc(g.id)}">Apagar</button>
        </div>
      </li>`).join('')}</ul>`
    : '<p class="empty">Sua lista está vazia. Adicione o primeiro mimo! 🎁</p>'}`);
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
      <li><a class="card row" href="#/familia/${esc(f.id)}">
        <span>${esc(f.name)}</span>${f.owner_id === me.id ? '<span class="tag">você criou</span>' : ''}
      </a></li>`).join('')}</ul>`
    : '<p class="empty">Você ainda não está em nenhuma família. Crie uma ou peça um link de convite!</p>'}
    <form id="f-fam" class="card stack">
      <h3>Criar família</h3>
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
    <h3>Membros</h3>
    <ul class="list">${members.map((m) => `
      <li class="card row">
        <a href="${m.user_id === me.id ? '#/' : '#/pessoa/' + esc(m.user_id)}">${esc(nameOf(m))}${m.user_id === me.id ? ' (você)' : ''}</a>
        ${m.user_id === fam.owner_id ? '<span class="tag">dono</span>'
          : owner ? `<button class="btn small danger" data-act="remove" data-id="${esc(m.user_id)}">Remover</button>` : ''}
      </li>`).join('')}</ul>
    ${owner ? `
      ${invites.length ? `<h3>Aguardando criar conta</h3>
      <ul class="list">${invites.map((i) => `
        <li class="card row"><span>${esc(i.email)}</span>
          <button class="btn small danger" data-act="uninvite" data-id="${esc(i.email)}">Cancelar</button></li>`).join('')}</ul>` : ''}
      <form id="f-add" class="card stack">
        <h3>Adicionar membro</h3>
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
      <p><button class="btn danger" data-act="destroy">Apagar família</button></p>`
    : '<p><button class="btn danger" data-act="leave">Sair da família</button></p>'}`);

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
    if (!b && !g.purchased) return `<button class="btn primary" data-act="buy" data-id="${esc(g.id)}">Comprei este</button>`;
    if (b?.buyer_id === me.id) return `<span class="seal">Você comprou ✔</span><button class="btn small" data-act="undo" data-id="${esc(g.id)}">Desfazer</button>`;
    return `<span class="seal">Já comprado por ${esc(b?.profiles?.name ?? 'alguém')}</span>`;
  };

  const el = section(`
    <a class="back" href="#/familias">← Famílias</a>
    <h2>Lista de ${esc(p.name)}</h2>
    ${gifts.length ? `<ul class="list">${gifts.map((g) => `
      <li class="card gift${g.purchased ? ' bought' : ''}">
        ${giftBody(g)}
        <div class="actions">${status(g)}</div>
      </li>`).join('')}</ul>`
    : '<p class="empty">Nenhum presente na lista ainda.</p>'}`);

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
      <li><button class="card alert${n.read_at ? '' : ' unread'}" data-act="open" data-id="${esc(n.id)}">
        <strong>${esc(n.title)}</strong>
        <span>${esc(n.body)}</span>
        <small>${fmtDate(n.created_at)}${n.read_at ? '' : ' · nova'}</small>
      </button></li>`).join('')}</ul>`
    : '<p class="empty">Nenhum alerta por enquanto. 🔔</p>'}`);
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
    <p class="muted">Conectado como ${esc(user.email)}</p>
    <button class="btn danger" data-act="logout">Sair</button>`);
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
