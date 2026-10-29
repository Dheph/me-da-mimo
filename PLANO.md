# Me Dá Mimo — Plano do projeto

Lista de presentes de Natal em família. PWA hospedado no GitHub Pages, com notificações push.

---

## 1. Escopo (MVP)

| # | Funcionalidade | Detalhe |
|---|---|---|
| 1 | Login com usuário e senha | Cada pessoa tem um **usuário** (ex.: `renan.lag`) e uma senha criada por ela. O e-mail é opcional e só serve para recuperar a conta. |
| 2 | Registro de família | Quem cria a família faz o próprio cadastro (usuário, nome e senha) e vira **administrador** dela. Uma pessoa pode estar em várias famílias. |
| 3 | Adm cria usuários | Na área "Adicionar membro", o adm informa o nome e o usuário. O sistema valida o usuário e gera um **código de ativação**, que fica visível ali e pode ser renovado. |
| 4 | Convite | O adm copia o convite (link + usuário + código) e envia por WhatsApp. No primeiro acesso, a pessoa entra com usuário + código e **cria a senha**. Depois disso, já vê as pessoas e os presentes da família. |
| 5 | Gestão de membros | O adm remove membros, renova códigos e convida para a família quem já tem conta. |
| 6 | Lista de desejos | Cada pessoa adiciona presentes: título, **link da loja**, observação, faixa de preço e prioridade. A lista aparece em todas as famílias da pessoa. |
| 7 | Alerta de novo presente | Quando alguém adiciona um presente, os outros membros das famílias dele recebem notificação. |
| 8 | Trava de compra | Quem compra marca "Comprei". Para os **outros membros**, o item fica travado como "Já comprado" e ninguém mais consegue marcá-lo. |
| 9 | Surpresa garantida | O **dono do presente nunca fica sabendo** que um item dele foi comprado: não recebe alerta, não vê selo e não vê contagem. A regra vale para todas as famílias e não pode ser desligada. |
| 10 | PWA | App instalável, funciona offline para leitura, com push notifications e uma central de avisos dentro do app. |

**Fica para depois:** prévia automática do link (imagem/preço da loja), amigo secreto, vaquinha para presente caro e lista de Natal por ano.

---

## 2. Arquitetura

O GitHub Pages só serve arquivos estáticos. Por isso os dados, o login e o envio de push ficam num backend gerenciado. A recomendação é o **Supabase (plano gratuito)**.

```
┌──────────────────────────┐        ┌───────────────────────────────────────┐
│  GitHub Pages (estático) │        │ Supabase (free)                       │
│  React + Vite PWA        │◄──────►│  Auth: usuário + senha                │
│  Service Worker (push)   │  HTTPS │  Postgres + RLS (regras de acesso)    │
└────────────▲─────────────┘        │  Edge Functions: signup, activate,    │
             │                      │                  notify               │
             │  Web Push (VAPID)    │  Database Webhooks ──► notify         │
             └──────────────────────┴───────────────────────────────────────┘
```

**Por que Supabase e não Firebase:** para mandar push do servidor, o Firebase exige Cloud Functions, que só existem no plano pago (Blaze). O Supabase oferece Edge Functions, webhooks do banco e a API de administração de usuários no plano gratuito. As regras de acesso (RLS) ficam em SQL, versionadas no repositório.

### Stack
- **Frontend:** Vite + React + TypeScript, `vite-plugin-pwa` (modo `injectManifest`, para ter um service worker próprio que trata o push), `@supabase/supabase-js`.
- **Roteamento:** `HashRouter` (`/#/...`). Assim os links de convite funcionam no GitHub Pages sem truque de 404.
- **Estilo:** CSS simples com tema natalino e layout mobile-first (quase todo mundo vai abrir pelo celular).
- **Backend:** Supabase com migrations SQL em `supabase/migrations` e Edge Functions em Deno (`npm:web-push` para o push).
- **Deploy:** GitHub Actions faz `npm ci && npm run build` e publica no Pages a cada push na `main`.

---

## 3. Login e contas

### Como o usuário vira login no Supabase
O Supabase Auth exige e-mail, mas a pessoa digita só o usuário. A solução é o app converter o usuário num **e-mail interno**, por exemplo `renan.lag@login.medamimo.app`. Esse endereço nunca recebe mensagens e a pessoa não chega a vê-lo. O login chama `signInWithPassword` com esse e-mail interno e a senha.

O **cadastro público fica desligado** no Supabase. Contas só nascem pelas Edge Functions `signup` e `activate`, que usam a API de administração. Assim ninguém pega um usuário reservado para outra pessoa.

O e-mail real, quando a pessoa cadastra, fica salvo em `profiles.email` e serve só para recuperar a senha.

### Regras do nome de usuário
- Só minúsculas, números e pontos: `^[a-z0-9]+(\.[a-z0-9]+)*$`, com 3 a 30 caracteres.
- Acentos e espaços são normalizados enquanto o adm digita (`Renan Lagé` → `renan.lage`).
- Precisa ser **único** entre as contas existentes e os convites pendentes. A tabela `usernames` reserva o nome no momento em que o convite é criado.
- A validação acontece **ao vivo** pela RPC `check_username(u)`, que responde se o nome está livre e, se não estiver, sugere alternativas (`renan.lag2`, `renan.lage`, `renan.l`).

### Código de ativação
- Tem 6 caracteres de um alfabeto sem letras ou números ambíguos (sem 0/O, 1/I/L) e é mostrado no formato `K7P-Q2M`.
- Vale **7 dias** e só pode ser usado uma vez.
- Fica visível para o adm na área de membros, ao lado do membro pendente, com os botões **Copiar convite** e **Renovar código**. Renovar invalida o código anterior.
- Depois de 5 tentativas erradas, o código trava e o adm precisa renovar.

### Fluxos

**A) Criador da família (primeiro acesso de todos)**
`Criar minha família` → nome, usuário, senha e nome da família → Edge Function `signup` cria a conta, o perfil e a família (com a pessoa como owner) → login automático.

**B) Adm adiciona um membro novo**
1. Família → Membros → **Adicionar membro** → informa o nome ("Renan") e o usuário (`renan.lag`, validado ao vivo).
2. A RPC `create_member_invite` reserva o usuário e gera o código, que aparece na lista como "Aguardando primeiro acesso".
3. **Copiar convite** (ou compartilhar via Web Share API) gera a mensagem:
   ```
   🎄 Oi, Renan! Você foi convidado(a) para a Família Lage no Me Dá Mimo.
   Acesse: https://dheph.github.io/me-da-mimo/#/primeiro-acesso?u=renan.lag
   Usuário: renan.lag
   Código: K7P-Q2M (válido até 05/11)
   ```

**C) Primeiro acesso do membro**
1. O link abre a tela **Primeiro acesso** com o usuário já preenchido. A pessoa digita o código.
2. `activate` (modo `check`) valida usuário + código, sem consumir o código.
3. Tela **Criar senha** (mínimo de 8 caracteres e confirmação).
4. `activate` (modo `complete`) cria a conta, o perfil e a participação ativa na família, e consome o código.
5. Login automático, e a pessoa cai direto na tela da família com as pessoas e os presentes.
6. Na primeira entrada, o app oferece de forma opcional: "Adicionar e-mail para recuperar a senha" e "Ativar notificações".

**D) Logins seguintes**
Tela de login com **usuário + senha**.

**E) Esqueci a senha**
- O adm abre o membro e clica em **Gerar código de redefinição**. A pessoa refaz o fluxo C (usuário + código → nova senha). Isso funciona sempre, mesmo sem e-mail.
- Se a pessoa cadastrou e-mail, pode usar "Esqueci a senha" para receber um link de redefinição. Isso fica para a fase 4 e depende de um serviço de envio de e-mail, como o Resend gratuito.

**F) Adicionar à família alguém que já tem conta**
O adm digita o usuário existente e a pessoa recebe um convite "Entrar na Família X?" com as opções Aceitar ou Recusar.

---

## 4. Modelo de dados

```sql
usernames         (username citext PK, user_id uuid null → profiles)
                  -- reserva nomes de contas e de convites pendentes
profiles          (id uuid PK = auth.uid, username citext unique → usernames,
                   name text, email text null, created_at)
families          (id uuid PK, name text, owner_id → profiles, created_at)
family_members    (family_id → families, user_id → profiles,
                   role text check (role in ('owner','member')),
                   status text check (status in ('invited','active')),
                   joined_at, PK (family_id, user_id))
account_codes     (id uuid PK, family_id → families, username citext → usernames,
                   name text, kind text check (kind in ('activate','reset')),
                   code text, expires_at, attempts int default 0,
                   created_by → profiles, used_at null, created_at)
                  -- só o owner da família lê; um código vivo por username
gifts             (id uuid PK, owner_id → profiles, title text, url text,
                   notes text, price_range text, priority int,
                   created_at, updated_at, archived_at)
purchases         (id uuid PK, gift_id → gifts UNIQUE, buyer_id → profiles,
                   purchased_at, note text)
push_subscriptions(id uuid PK, user_id → profiles, endpoint text unique,
                   p256dh text, auth text, user_agent text, created_at)
notifications     (id uuid PK, user_id → profiles, type text, title text,
                   body text, link text, read_at, created_at)
```

O `UNIQUE (gift_id)` em `purchases` é a trava no banco: mesmo que duas pessoas cliquem ao mesmo tempo, só uma compra é registrada.

### Regras de acesso (RLS)
Uma função auxiliar `shares_family(a uuid, b uuid)` (security definer) responde se duas pessoas têm alguma família em comum com status `active`.

- **profiles:** leitura liberada para quem compartilha família. Cada um edita só o próprio nome e e-mail. O e-mail é visível só para o próprio usuário.
- **families:** leitura para membros. Só o `owner` atualiza ou apaga.
- **family_members:** leitura para membros da família. O `owner` adiciona e remove. O próprio usuário pode sair.
- **account_codes:** acesso **só do owner** da família, apenas por RPC. Não há leitura pública.
- **gifts:** leitura para quem compartilha família com o dono. Só o dono cria, edita e arquiva.
- **purchases:** leitura para quem compartilha família com o dono do presente **e não é o dono** (`gifts.owner_id <> auth.uid()`). Qualquer membro pode criar uma compra, menos o dono do presente. Só o comprador desfaz.
- **notifications / push_subscriptions:** cada um acessa só os seus.

### Blindagem da surpresa
A regra de RLS em `purchases` já esconde a compra do dono do presente, mas há outros caminhos por onde a informação pode vazar. Todos ficam fechados:

- **Consultas:** a tela "Minha lista" lê só `gifts` e nunca faz join com `purchases`. Também não existe view nem RPC que conte compras por pessoa.
- **Realtime:** o canal de `purchases` respeita RLS, então o dono não recebe esses eventos.
- **Notificações:** a função `notify` exclui o dono do presente de qualquer aviso sobre compra.
- **Edição e remoção:** se o dono editar ou arquivar um item já comprado, a tela dele se comporta exatamente igual. Quem é avisado é o **comprador**: "Ana editou/removeu *Fone Bluetooth*, que você marcou como comprado".
- **Proteção da trava:** se o dono tentar marcar o próprio item, a RPC recusa com a mesma mensagem genérica, sem confirmar nada.

### Funções
- **RPC:** `check_username(u)`, `create_member_invite(family_id, name, username)`, `renew_code(code_id)`, `create_reset_code(family_id, user_id)`, `invite_existing_user(family_id, username)`, `respond_family_invite(family_id, accept)`, `mark_purchased(gift_id, note)`, `unmark_purchased(gift_id)`.
- **Edge Functions (service role):**
  - `signup`: cria o criador da família.
  - `activate`: tem os modos `check` e `complete`. No primeiro acesso cria a conta; na redefinição troca a senha.
  - `notify`: envia os pushes.

---

## 5. Notificações

### Eventos

| Evento | Quem recebe | Mensagem |
|---|---|---|
| `INSERT gifts` | Membros ativos das famílias do dono, menos ele | "🎁 Ana adicionou *Fone Bluetooth* à lista" |
| `INSERT purchases` | **Ninguém** recebe push. A tela dos outros membros (menos o dono) atualiza em tempo real com o item travado. | — |
| `UPDATE/archive gifts` de item comprado | Só o comprador | "Ana alterou *Fone Bluetooth*, que você marcou como comprado" |
| Membro ativou a conta | Owner da família | "Renan ativou o acesso à Família Lage" |
| Convite para conta existente | Usuário convidado | "Você foi convidado para a Família Lage" |

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

## 6. Telas

1. **Entrar:** usuário + senha. Links "Primeiro acesso (tenho um código)" e "Criar minha família".
2. **Primeiro acesso:** usuário (pré-preenchido pelo link) + código → **Criar senha**.
3. **Criar minha família:** nome, usuário (validado ao vivo), senha e nome da família.
4. **Início:** famílias da pessoa, convites pendentes, botão "Minha lista".
5. **Família:** grade de membros (avatar com a inicial e quantidade de presentes). Tocar num membro abre a lista dele.
6. **Lista de um membro:** cards com título, loja (domínio do link), preço e prioridade. Itens livres mostram o botão **"Comprei 🎁"**. Itens comprados aparecem travados com "Já comprado por Maria" (e "Desfazer" só para a Maria).
7. **Minha lista:** adicionar, editar e arquivar presentes. **Nunca** mostra o status de compra.
8. **Membros (adm):**
   - Seção "Adicionar membro": nome + usuário com validação ao vivo e sugestões.
   - Membros pendentes: código, validade e os botões **Copiar convite** e **Renovar código**.
   - Membros ativos: remover, gerar código de redefinição.
   - Convidar quem já tem conta (por usuário).
9. **Avisos:** histórico de notificações e o botão "Ativar notificações".
10. **Perfil:** trocar o nome, trocar a senha, adicionar/alterar e-mail e sair.

---

## 7. Estrutura do repositório

```
me-da-mimo/
├─ .github/workflows/deploy.yml     # build + deploy no GitHub Pages
├─ public/                          # ícones PWA (192, 512, maskable), favicon
├─ src/
│  ├─ main.tsx, App.tsx, routes.tsx
│  ├─ lib/supabase.ts, lib/push.ts, lib/username.ts
│  ├─ hooks/ (useAuth, useFamilies, useGifts, useNotifications)
│  ├─ pages/ (Login, FirstAccess, CreatePassword, Signup, Home, Family,
│  │          MemberList, MyList, Members, Inbox, Profile)
│  ├─ components/
│  └─ sw.ts                         # service worker: cache + push + click
├─ supabase/
│  ├─ migrations/0001_init.sql      # tabelas, RLS, RPCs
│  ├─ functions/signup/index.ts
│  ├─ functions/activate/index.ts
│  ├─ functions/notify/index.ts
│  └─ tests/rls.sql                 # testes da blindagem da surpresa
├─ vite.config.ts                   # base: '/me-da-mimo/', PWA manifest
└─ README.md                        # como configurar Supabase + VAPID + Pages
```

**Configuração:**
- **Secrets no GitHub:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`. As três podem ficar no bundle, porque quem protege os dados é a RLS.
- **Secrets no Supabase:** `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.
- **Supabase Auth:** cadastro público desligado e confirmação de e-mail desligada (o e-mail de login é interno).

---

## 8. Etapas

Faltam cerca de 2 meses para o Natal. A meta é colocar o MVP no ar até o **fim de novembro**, para dar tempo de a família usar.

| Fase | Entrega | Pronto quando |
|---|---|---|
| **0. Base** | Scaffold Vite/React/TS, PWA manifest, deploy no Pages via Actions, projeto Supabase | Site abre em `dheph.github.io/me-da-mimo` e é instalável |
| **1. Contas e famílias** | `signup`, login, validação de usuário, criação de membro com código, convite copiável, `activate` (primeiro acesso + criar senha), renovar código, remover membro | O adm cria `renan.lag`, envia o convite e o Renan entra noutro celular, cria a senha e vê a família |
| **2. Presentes** | CRUD de presentes, lista por membro, trava de compra, blindagem da surpresa com testes de RLS | Duas pessoas não conseguem comprar o mesmo item, e o dono não consegue descobrir a compra nem pela API |
| **3. Notificações** | Central de avisos, inscrição push, Edge Function `notify`, webhooks, instrução de instalação no iOS | Push chega no Android e no iPhone com o app instalado, e nunca chega aviso de compra para o dono |
| **4. Acabamento** | Tema de Natal, estados vazios, offline (cache das listas), e-mail opcional + "Esqueci a senha", convite para conta existente | Família testa por uma semana sem bugs bloqueantes |
| **5. Extras** (opcional) | Prévia do link (Edge Function que lê og:image/og:title), amigo secreto, vaquinha | — |

---

## 9. Decisões

| # | Tema | Status |
|---|---|---|
| D1 | Login | ✅ Usuário + senha. O adm cria o usuário com um código renovável; no primeiro acesso a pessoa cria a senha. E-mail opcional. |
| D2 | Surpresa | ✅ O dono do presente nunca sabe da compra. Os outros membros veem a trava. |
| D3 | Entrada na família | ✅ Pelo código criado pelo adm (contas novas) ou por convite aceito (contas existentes). |
| D4 | Backend | ✅ Supabase gratuito. |
| D5 | Validade do código | ✅ 7 dias, uso único, trava após 5 erros (o adm renova). |
| D6 | Quem pode criar família | ✅ Qualquer pessoa, pela tela "Criar minha família". |
