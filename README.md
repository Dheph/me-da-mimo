<p align="center">
  <img src="icons/logo.png" alt="Logo do Me Dá Mimo: caixa de presente com laço dourado" width="120">
</p>

<h1 align="center">Me Dá Mimo</h1>

<p align="center">
  Lista de presentes de Natal em família: sem presente repetido e sem estragar a surpresa.<br>
  <a href="https://dheph.github.io/me-da-mimo/"><strong>Abrir o app →</strong></a>
</p>

<p align="center">
  <img src="docs/screenshots/inicio-publico.jpg" alt="Página inicial" width="200">
  <img src="docs/screenshots/painel.jpg" alt="Painel com o botão Adicionar meu pedido" width="200">
  <img src="docs/screenshots/presentes-para-dar.jpg" alt="Presentes para dar, com filtros e busca" width="200">
</p>

## Como funciona

1. **Quem organiza cria a família.** Em "Criar conta", escolha *Admin da família* e dê um nome a ela.
2. **O admin adiciona as pessoas pelo e-mail.** Quem já tem conta entra na hora. Quem ainda não tem
   entra sozinho ao criar a conta com aquele e-mail, escolhendo *Membro da família*.
3. **Cada um faz os seus pedidos.** Toque em **Adicionar meu pedido** e diga o que quer ganhar, com o
   link da loja e detalhes como tamanho e cor.
4. **A família fica sabendo.** Todo pedido novo gera um aviso para os outros membros.
5. **Comprou? Marque "Comprei este".** O presente sai da lista de quem vai dar. Quem vai ganhar recebe
   o aviso de que alguém comprou, mas nunca sabe quem foi.

Tudo fica numa tela só: o botão de pedir, a sua família, os **presentes para dar** (com busca, filtro
por pessoa e "que eu comprei") e os **seus pedidos**.

<p align="center">
  <img src="docs/screenshots/criar-conta.jpg" alt="Criar conta escolhendo Admin ou Membro" width="200">
  <img src="docs/screenshots/instalar.jpg" alt="Passo a passo para instalar no celular" width="200">
</p>

## Admin e membros

| | Admin | Membro |
|---|:---:|:---:|
| Faz os próprios pedidos e compra presentes | ✅ | ✅ |
| Adiciona e remove pessoas da família | ✅ | — |
| Sai da família | — | ✅ |

O admin também é membro: tem a própria lista e ganha presente como todo mundo. A mesma pessoa pode
ser admin de uma família e membro de outra.

## Instalar no celular

O Me Dá Mimo funciona no navegador, mas **instalado** ele vira um ícone na tela e manda os avisos. O
próprio app mostra o passo a passo certo para o seu aparelho e lembra você até instalar.

- **Android (Chrome):** toque em **Instalar agora** no app. Se o botão não aparecer, use o menu ⋮ →
  *Instalar app*.
- **iPhone (Safari):** toque em **Compartilhar** → **Adicionar à Tela de Início** → **Adicionar**.
  Depois abra pelo ícone novo. No iPhone os avisos só funcionam assim (iOS 16.4 ou mais novo).
- **Abriu pelo WhatsApp ou Instagram?** Toque nos três pontinhos e escolha *Abrir no navegador*.

Depois de instalado, o app pede para **ativar os avisos**: é assim que você fica sabendo dos pedidos
da família e das compras dos seus presentes.

## Para desenvolver

É um site estático, sem etapa de build: HTML, CSS e JavaScript puros. Ele é publicado no GitHub Pages
e funciona como PWA (instalável e com notificações push).

```bash
python3 -m http.server 8000
```

Depois abra http://localhost:8000.

| Pasta / arquivo | O que tem |
|---|---|
| `index.html`, `app.js`, `style.css` | Telas e navegação |
| `install.js`, `push.js`, `sw.js`, `manifest.webmanifest` | Instalação, avisos e modo app |
| `icons/` | Logo e ícones do app |
| `supabase/` | Banco de dados e função de envio dos avisos |
| `docs/screenshots/` | Imagens deste README |

---

<p align="center">© 2026 Me Dá Mimo · Feito com carinho para o Natal em família</p>
