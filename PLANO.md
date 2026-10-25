# Me Dá Mimo — Plano do projeto

Lista de presentes de Natal em família. PWA hospedado no GitHub Pages, com notificações push.

---

## 1. Escopo (MVP)

| # | Funcionalidade | Detalhe |
|---|---|---|
| 1 | Login simples | A pessoa informa só o **nome**. Sessão anônima persistida no aparelho. E-mail opcional para recuperar a conta em outro aparelho. |
| 2 | Registro de família | Qualquer usuário cria uma família (ex.: "Família Lage") e vira **administrador** dela. Uma pessoa pode estar em várias famílias. |
| 3 | Convite por link | O administrador gera um link (`…/#/entrar/<codigo>`) e envia por WhatsApp. Quem abre informa o nome, entra e **já vê as pessoas e os presentes**. |
| 4 | Gestão de membros | O administrador remove membros, aprova pedidos (se a família exigir aprovação) e pode gerar um novo link (o antigo deixa de valer). |
| 5 | Lista de desejos | Cada pessoa adiciona presentes: título, **link da loja**, observação, faixa de preço e prioridade. A lista aparece em todas as famílias da pessoa. |
| 6 | Alerta de novo presente | Quando alguém adiciona um presente, os outros membros das famílias dele recebem notificação. |
| 7 | Registro de compra | Quem compra marca "Comprei". O item aparece como comprado para os outros membros, o que evita presente repetido. Só uma pessoa consegue marcar cada item. |
| 8 | Alerta para quem ganha | O beneficiário recebe a notificação de que um presente foi comprado (ver decisão D2 sobre a surpresa). |
| 9 | PWA | App instalável, funciona offline para leitura, com push notifications e uma central de avisos dentro do app. |

**Fica para depois:** prévia automática do link (imagem/preço da loja), amigo secreto, vaquinha para presente caro e lista de Natal por ano.

---

## 2. Arquitetura

O GitHub Pages só serve arquivos estáticos. Por isso os dados, o login e o envio de push ficam num backend gerenciado. A recomendação é o **Supabase (plano gratuito)**.

```
┌──────────────────────────┐        ┌───────────────────────────────────────┐
│  GitHub Pages (estático) │        │ Supabase (free)                       │
│  React + Vite PWA        │◄──────►│  Auth: login anônimo + nome           │
│  Service Worker (push)   │  HTTPS │  Postgres + RLS (regras de acesso)    │
└────────────▲─────────────┘        │  Database Webhooks ──► Edge Function  │
             │                      │                        "notify"       │
             │  Web Push (VAPID)    └──────────────────────────────┬────────┘
             └─────────────────── serviço de push do navegador ◄──┘
```

**Por que Supabase e não Firebase:** para mandar push do servidor, o Firebase exige Cloud Functions, que só existem no plano pago (Blaze). O Supabase oferece Edge Functions, webhooks do banco e login anônimo no plano gratuito. As regras de acesso (RLS) ficam em SQL, versionadas no repositório.

### Stack
- **Frontend:** Vite + React + TypeScript, `vite-plugin-pwa` (modo `injectManifest`, para ter um service worker próprio que trata o push), `@supabase/supabase-js`.
- **Roteamento:** `HashRouter` (`/#/...`). Assim os links de convite funcionam no GitHub Pages sem truque de 404.
- **Estilo:** CSS simples com tema natalino e layout mobile-first (quase todo mundo vai abrir pelo celular).
- **Backend:** Supabase com migrations SQL em `supabase/migrations`, Edge Function `notify` em Deno usando `npm:web-push`.
- **Deploy:** GitHub Actions faz `npm ci && npm run build` e publica no Pages a cada push na `main`.

---

## 3. Modelo de dados

```sql
profiles          (id uuid PK = auth.uid, name text, email text null, created_at)
families          (id uuid PK, name text, owner_id uuid → profiles,
                   invite_code text unique, require_approval bool default false,
                   created_at)
family_members    (family_id → families, user_id → profiles,
                   role text check (role in ('owner','member')),
                   status text check (status in ('pending','active')),
                   joined_at, PK (family_id, user_id))
gifts             (id uuid PK, owner_id → profiles, title text, url text,
                   notes text, price_range text, priority int,
                   created_at, archived_at)
purchases         (id uuid PK, gift_id → gifts UNIQUE, buyer_id → profiles,
                   purchased_at, note text)
push_subscriptions(id uuid PK, user_id → profiles, endpoint text unique,
                   p256dh text, auth text, user_agent text, created_at)
notifications     (id uuid PK, user_id → profiles, type text, title text,
                   body text, link text, read_at, created_at)
```

O `UNIQUE (gift_id)` em `purchases` garante que duas pessoas não marquem o mesmo presente.

### Regras de acesso (RLS)
Uma função auxiliar `shares_family(a uuid, b uuid)` (security definer) responde se duas pessoas têm alguma família em comum com status `active`.

- **profiles:** leitura liberada para quem compartilha família. Cada um edita só o próprio perfil.
- **families:** leitura para membros. Só o `owner` atualiza ou apaga.
- **family_members:** leitura para membros da família. O `owner` aprova e remove. O próprio usuário pode sair.
- **gifts:** leitura para quem compartilha família com o dono. Só o dono cria, edita e apaga.
- **purchases:** leitura para membros, **exceto o beneficiário** quando a família está em modo surpresa (D2). Quem pode criar é qualquer membro, menos o dono do presente. Só o comprador desfaz.
- **notifications / push_subscriptions:** cada um acessa só os seus.

### Funções RPC
- `join_family(code text)`: valida o código e insere o usuário como `active` (ou `pending` se a família exige aprovação). Retorna a família.
- `regenerate_invite(family_id)`: gera um código novo (só o owner).
- `mark_purchased(gift_id, note)` / `unmark_purchased(gift_id)`.

---

## 4. Notificações

### Eventos

| Evento (webhook do banco) | Quem recebe | Mensagem |
|---|---|---|
| `INSERT gifts` | Membros ativos das famílias do dono, menos ele | "🎁 Ana adicionou *Fone Bluetooth* à lista" |
| `INSERT purchases` | Beneficiário | "🎄 Alguém comprou um presente da sua lista!" (sem revelar qual, em modo surpresa) |
| `INSERT purchases` | Outros membros | Sem push. Só atualiza a tela (evita spam). |
| `INSERT family_members` (pending) | Owner | "João pediu para entrar na Família Lage" |
| `UPDATE family_members` → active | Membros da família | "João entrou na Família Lage" |

### Fluxo técnico
1. Na primeira vez, o app pede permissão. O navegador gera uma `PushSubscription` com a chave pública VAPID, e o app salva essa assinatura em `push_subscriptions`.
2. Um Database Webhook chama a Edge Function `notify` com o registro novo.
3. A função calcula os destinatários, grava em `notifications` (central de avisos dentro do app) e envia o Web Push para cada assinatura. Assinaturas que respondem `404` ou `410` são apagadas.
4. O service worker recebe o `push`, mostra a notificação e, no `notificationclick`, abre o app na tela certa.

### Limitações importantes
- **iPhone (iOS 16.4+):** push só funciona se o site for **adicionado à Tela de Início** e aberto por lá. O app vai mostrar um passo a passo de "Instalar" quando detectar Safari no iOS.
- **Permissão:** pedir só depois de um gesto do usuário (botão "Ativar avisos") e nunca logo ao abrir o app.
- **Sem push** (permissão negada ou navegador antigo): a central de avisos dentro do app continua funcionando.

---

## 5. Telas

1. **Boas-vindas / Login:** campo "Como você se chama?" e o botão "Entrar". Se veio de um convite, mostra também "Você foi convidado para *Família X*".
2. **Início:** famílias da pessoa. Botões "Criar família" e "Minha lista".
3. **Família:** grade de membros (avatar com a inicial e quantidade de presentes). Tocar num membro abre a lista dele.
4. **Lista de um membro:** cards com título, loja (domínio do link), preço, prioridade e o botão **"Comprei 🎁"** ou o selo "Comprado por Maria".
5. **Minha lista:** adicionar, editar e arquivar presentes. Em modo surpresa, a pessoa não vê o que já foi comprado.
6. **Administrar família** (só owner): copiar e compartilhar o link (Web Share API → WhatsApp), gerar novo link, aprovar pendentes, remover membros e ativar/desativar "exigir aprovação" e o modo surpresa.
7. **Avisos:** histórico de notificações e o botão "Ativar notificações".
8. **Perfil:** trocar o nome, vincular e-mail (para recuperar a conta) e sair.

---

## 6. Estrutura do repositório

```
me-da-mimo/
├─ .github/workflows/deploy.yml     # build + deploy no GitHub Pages
├─ public/                          # ícones PWA (192, 512, maskable), favicon
├─ src/
│  ├─ main.tsx, App.tsx, routes.tsx
│  ├─ lib/supabase.ts, lib/push.ts
│  ├─ hooks/ (useAuth, useFamilies, useGifts, useNotifications)
│  ├─ pages/ (Login, Home, Family, MemberList, MyList, FamilyAdmin, Inbox, Profile, Join)
│  ├─ components/
│  └─ sw.ts                         # service worker: cache + push + click
├─ supabase/
│  ├─ migrations/0001_init.sql      # tabelas, RLS, funções
│  └─ functions/notify/index.ts     # Edge Function de push
├─ vite.config.ts                   # base: '/me-da-mimo/', PWA manifest
└─ README.md                        # como configurar Supabase + VAPID + Pages
```

**Configuração:**
- **Secrets no GitHub:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`. As três podem ficar no bundle, porque quem protege os dados é a RLS.
- **Secrets no Supabase:** `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

---

## 7. Etapas

Faltam cerca de 2 meses para o Natal. A meta é colocar o MVP no ar até o **fim de novembro**, para dar tempo de a família usar.

| Fase | Entrega | Pronto quando |
|---|---|---|
| **0. Base** | Scaffold Vite/React/TS, PWA manifest, deploy no Pages via Actions, projeto Supabase | Site abre em `dheph.github.io/me-da-mimo` e é instalável |
| **1. Login e famílias** | Login anônimo com nome, criar família, link de convite, `join_family`, gestão de membros | Duas pessoas em celulares diferentes entram na mesma família pelo link |
| **2. Presentes** | CRUD de presentes, lista por membro, marcar e desmarcar compra, modo surpresa | Ninguém consegue comprar o mesmo item duas vezes. O beneficiário não vê o que foi comprado. |
| **3. Notificações** | Central de avisos, inscrição push, Edge Function `notify`, webhooks, instrução de instalação no iOS | Push chega no Android e no iPhone com o app instalado |
| **4. Acabamento** | Tema de Natal, estados vazios, offline (cache das listas), e-mail opcional para recuperar conta, testes das regras RLS | Família testa por uma semana sem bugs bloqueantes |
| **5. Extras** (opcional) | Prévia do link (Edge Function que lê og:image/og:title), amigo secreto, vaquinha | — |

---

## 8. Decisões em aberto

| # | Decisão | Recomendação |
|---|---|---|
| **D1** | Login só com nome é frágil: se a pessoa limpar o navegador ou trocar de celular, perde a conta. | Nome para entrar, mais **e-mail opcional** (link mágico) para recuperar a conta. Alternativa: um "código de recuperação" de 6 dígitos mostrado no perfil. |
| **D2** | O beneficiário deve saber **qual** presente foi comprado? Isso estraga a surpresa. | **Modo surpresa ligado por padrão.** O alerta diz só "alguém comprou um presente seu" e o item some da visão dele. O owner pode desligar o modo surpresa na família. |
| **D3** | Link de convite entra direto ou precisa de aprovação? | **Entra direto** (o link foi enviado pelo owner), com a opção "exigir aprovação" na família, e o link pode ser regenerado se vazar. |
| **D4** | Backend | Supabase gratuito (ver seção 2). |
