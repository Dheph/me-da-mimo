# Me Dá Mimo 🎁

Lista de presentes de Natal em família. PWA estático (GitHub Pages) + Supabase.

https://dheph.github.io/me-da-mimo/

- Login com nome + e-mail (código de 6 dígitos, sem senha).
- Crie uma família e mande o link de convite; quem abre entra direto. O dono remove membros.
- Cada um monta a própria lista (com link). A família recebe alerta quando entra presente novo.
- Quem compra marca "Comprei este"; o dono recebe o alerta, mas nunca vê quem comprou.
- Notificações push (no iPhone, só com o app adicionado à Tela de Início).

## Estrutura
- `index.html`, `app.js`, `style.css`, `supabase.js`, `config.js` — app (sem build).
- `push.js`, `sw.js`, `manifest.webmanifest`, `icons/` — PWA e push.
- `supabase/migrations/` — schema + RLS. `supabase/functions/push/` — edge function que envia o Web Push.

## Configuração única no Supabase (Dashboard → Authentication)
1. ✅ **URL Configuration** → Site URL `https://dheph.github.io/me-da-mimo/` e Redirect URL `https://dheph.github.io/me-da-mimo/**`.
2. **SMTP próprio** (ex.: Resend) em Emails → SMTP Settings. Sem ele o Supabase não deixa editar templates e envia poucos e-mails por hora.
3. Depois do SMTP: em "Magic link or OTP" e "Confirm sign up", incluir `Seu código: {{ .Token }}`. Até lá o login é só pelo link do e-mail,
   que precisa ser aberto no mesmo navegador onde o e-mail foi pedido (no iPhone com o app instalado isso não acontece — por isso o código).

## Rodar local
Qualquer servidor estático na pasta, ex.: `python3 -m http.server`.
