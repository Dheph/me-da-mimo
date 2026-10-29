// Tour guiado: escurece a tela, recorta o alvo de cada passo e mostra um balão explicativo.
// Uso: startTour([{ target: '#nav', title: 'Menu', text: 'Aqui você troca de tela.' }], { onDone })

const PAD = 8; // folga do recorte em volta do alvo
const GAP = 12; // distância entre recorte e balão
const MARGIN = 16; // margem mínima do balão até a borda da tela

let state = null;

export const tourRunning = () => state !== null;

const find = (sel) => {
  const el = document.querySelector(sel);
  return el && el.getBoundingClientRect().width > 0 ? el : null;
};

const div = (cls) => Object.assign(document.createElement('div'), { className: cls });

export function startTour(steps, { onDone } = {}) {
  if (state) return;
  const list = steps.filter((s) => find(s.target));
  if (!list.length) return onDone?.();

  const block = div('tour-block'); // captura cliques no fundo
  const hole = div('tour-hole');
  const card = div('tour-card');
  card.tabIndex = -1; // clique no balão não joga o foco para o <body>
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tour-title');
  card.setAttribute('aria-describedby', 'tour-text');
  card.innerHTML = `
    <p class="tour-count"></p>
    <h2 class="tour-title" id="tour-title"></h2>
    <p class="tour-text" id="tour-text"></p>
    <div class="tour-actions">
      <button type="button" class="btn link">Pular</button>
      <button type="button" class="btn primary">Próximo</button>
    </div>`;
  const [count, title, text] = card.children;
  const [skipBtn, nextBtn] = card.querySelectorAll('button');

  let raf = 0;
  const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };

  function place() {
    if (!state?.el) return;
    const r = state.el.getBoundingClientRect();
    Object.assign(hole.style, {
      top: `${r.top - PAD}px`, left: `${r.left - PAD}px`,
      width: `${r.width + PAD * 2}px`, height: `${r.height + PAD * 2}px`,
    });
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = Math.min(400, vw - MARGIN * 2);
    card.style.width = `${w}px`;
    const h = card.offsetHeight;
    const below = r.bottom + PAD + GAP;
    const above = r.top - PAD - GAP - h;
    // Abaixo se couber; senão acima; se nenhum couber, o lado com mais espaço (depois limitado à tela).
    let top = below + h <= vh - MARGIN || (above < MARGIN && vh - r.bottom > r.top) ? below : above;
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - h));
    const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, vw - MARGIN - w));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function show(i) {
    // O DOM pode ter mudado desde o início: pula alvos que sumiram.
    while (i < list.length && !find(list[i].target)) i++;
    if (i >= list.length) return end();
    const s = list[i];
    state.i = i;
    state.el = find(s.target);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    state.el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    count.textContent = `Passo ${i + 1} de ${list.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    nextBtn.textContent = i === list.length - 1 ? 'Entendi!' : 'Próximo';
    place();
    nextBtn.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    // Enter num botão já dispara o clique nativo dele (inclusive "Pular").
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest?.('button'))) {
      e.preventDefault();
      show(state.i + 1);
    } else if (e.key === 'Tab') {
      // Prende o foco no balão: com 2 botões, Tab e Shift+Tab só alternam.
      e.preventDefault();
      (document.activeElement === nextBtn ? skipBtn : nextBtn).focus();
    }
  }

  function end() {
    if (!state) return;
    const { prev } = state;
    state = null;
    cancelAnimationFrame(raf);
    window.removeEventListener('scroll', onMove, true);
    window.removeEventListener('resize', onMove);
    document.removeEventListener('keydown', onKey, true);
    block.remove(); hole.remove(); card.remove();
    if (prev?.isConnected) prev.focus({ preventScroll: true });
    onDone?.();
  }

  state = { i: 0, el: null, prev: document.activeElement };
  skipBtn.addEventListener('click', end);
  nextBtn.addEventListener('click', () => show(state.i + 1));
  block.addEventListener('mousedown', (e) => e.preventDefault()); // mantém o foco no balão
  window.addEventListener('scroll', onMove, { capture: true, passive: true });
  window.addEventListener('resize', onMove);
  document.addEventListener('keydown', onKey, true);
  document.body.append(block, hole, card);
  show(0);
}
