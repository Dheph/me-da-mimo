# Me Dá Mimo 🎁

Lista de presentes de Natal em família. PWA estático (GitHub Pages) + Supabase.

https://dheph.github.io/me-da-mimo/

- Login com e-mail e senha (sem confirmação por e-mail).
- Quem cria a família adiciona membros pelo e-mail: quem já tem conta entra na hora; quem não tem entra ao criar a conta com aquele e-mail (link `#/criar-conta`). O dono remove membros.
- Cada um monta a própria lista (com link). A família recebe alerta quando entra presente novo.
- Quem compra marca "Comprei este"; o dono recebe o alerta, mas nunca vê quem comprou.
- Notificações push (no iPhone, só com o app adicionado à Tela de Início).

## Estrutura
- `index.html`, `app.js`, `style.css`, `supabase.js`, `config.js` — app (sem build).
- `push.js`, `sw.js`, `manifest.webmanifest`, `icons/` — PWA e push.
- `supabase/migrations/` — schema + RLS. `supabase/functions/push/` — edge function que envia o Web Push.

## Configuração no Supabase (Dashboard → Authentication)
- URL Configuration: Site URL `https://dheph.github.io/me-da-mimo/`, Redirect `https://dheph.github.io/me-da-mimo/**`.
- Sign In / Providers → Email: "Confirm email" desligado (v1 sem e-mails; religar exige SMTP próprio por causa do limite de envio).

## Rodar local
Qualquer servidor estático na pasta, ex.: `python3 -m http.server`.
