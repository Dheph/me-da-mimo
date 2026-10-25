# Me Dá Mimo 🎁

Lista de presentes de Natal em família — sem presente repetido e sem estragar a surpresa.

**No ar:** https://dheph.github.io/me-da-mimo/

## Como funciona

1. **O admin cria a conta e a família** (em "Criar conta" → *Admin da família*).
2. **O admin adiciona as pessoas pelo e-mail.** Quem já tem conta entra na hora; quem não tem entra
   automaticamente ao criar a conta com aquele e-mail (link `#/criar-conta`, opção *Membro da família*).
3. **Cada um monta a própria lista**, com link da loja e observação. O admin também é membro e tem lista.
4. **A família recebe um alerta** quando alguém adiciona um presente.
5. **Quem compra toca em "Comprei este".** O presenteado recebe o aviso de que alguém comprou, mas
   nunca vê quem foi. Os outros membros veem, para não comprar repetido.

Funciona como app no celular (PWA): "Adicionar à Tela de Início". No iPhone, as notificações push só
funcionam com o app instalado assim (iOS 16.4+).

## Perfis

| | Admin | Membro |
|---|---|---|
| Tem a própria lista e compra presentes | ✅ | ✅ |
| Adiciona e remove membros, apaga a família | ✅ | — |
| Sai da família | — (apaga a família) | ✅ |

"Admin" é quem criou a família; uma pessoa pode ser admin de uma família e membro de outra.

## Stack

Site estático, sem build, no GitHub Pages + Supabase (Postgres, Auth, Edge Functions).

| Arquivo | Papel |
|---|---|
| `index.html`, `app.js`, `style.css` | App (rotas por hash, telas) |
| `supabase.js`, `config.js` | Cliente Supabase (URL + anon key, públicas) |
| `push.js`, `sw.js`, `manifest.webmanifest`, `icons/` | PWA e Web Push |
| `supabase/migrations/` | Schema, RLS e triggers (aplicar em ordem) |
| `supabase/functions/push/` | Edge function que envia o push (chaves VAPID no Vault) |

Toda regra de acesso está no banco (RLS + funções `security definer`): o frontend só usa a anon key.

## Rodar local

```bash
python3 -m http.server 8000
```

Abra http://localhost:8000. O app fala direto com o Supabase de produção.

## Configuração do Supabase (já feita)

- Authentication → URL Configuration: Site URL `https://dheph.github.io/me-da-mimo/`, Redirect `https://dheph.github.io/me-da-mimo/**`.
- Authentication → Sign In / Providers → Email: **Confirm email desligado** (a v1 não envia e-mail).
  Para religar, configure antes um SMTP próprio — o padrão do Supabase envia poucos e-mails por hora.

## Segurança

- Nunca versione `service_role`, `sb_secret_…`, `.env` ou chaves privadas. A anon key em `config.js` é pública por design.
- Ative o hook que bloqueia segredos em commits (uma vez por clone):

  ```bash
  git config core.hooksPath .githooks
  ```

## Limitações conhecidas (v1)

- Sem confirmação de e-mail: quem se cadastrar com o e-mail de outra pessoa entra na família dela.
- Sem "Esqueci a senha" no app — redefinir pelo Dashboard do Supabase (Authentication → Users).

© 2026 Me Dá Mimo
