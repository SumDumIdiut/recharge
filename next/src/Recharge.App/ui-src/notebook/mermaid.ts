// Mermaid (vendored in ./vendor/mermaid, loaded the first time a note has a diagram) and the full-screen diagram viewer.
import { repairMermaid } from './markdown.js';

type Mermaid = {
  initialize(config: unknown): void;
  render(id: string, source: string): Promise<{ svg: string }>;
};

const SCRIPT = 'notebook/vendor/mermaid/mermaid.min.js';

let loading: Promise<Mermaid> | null = null;
let observer: IntersectionObserver | null = null;
let chain: Promise<void> = Promise.resolve();
let counter = 0;
let generation = 0;

function loadMermaid(): Promise<Mermaid> {
  if (loading) return loading;
  const attempt = new Promise<Mermaid>((resolve, reject) => {
    const have = (window as unknown as { mermaid?: Mermaid }).mermaid;
    if (have) { resolve(have); return; }
    const script = document.createElement('script');
    script.src = new URL(SCRIPT, document.baseURI).href;
    script.onload = () => {
      const m = (window as unknown as { mermaid?: Mermaid }).mermaid;
      if (m) resolve(m); else reject(new Error('mermaid missing'));
    };
    script.onerror = () => reject(new Error('mermaid failed to load'));
    document.head.appendChild(script);
  }).then((m) => { configure(m); return m; });
  attempt.catch(() => { loading = null; });
  loading = attempt;
  return attempt;
}

function configure(m: Mermaid): void {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  const text = v('--text', '#f9ffe4'), green = v('--green', '#41f88d'), magenta = v('--magenta', '#c63ed8');
  const panel = v('--panel', '#1c1c1c'), bg = v('--bg', '#141414');
  const font = getComputedStyle(document.body).fontFamily || 'VT323, monospace';
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: font,
    themeVariables: {
      background: bg, darkMode: true, fontFamily: font, fontSize: '17px',
      primaryColor: panel, primaryTextColor: text, primaryBorderColor: green,
      secondaryColor: bg, secondaryTextColor: text, secondaryBorderColor: magenta,
      tertiaryColor: bg, tertiaryTextColor: text, tertiaryBorderColor: green,
      lineColor: green, textColor: text, mainBkg: panel, nodeBorder: green, nodeTextColor: text,
      clusterBkg: bg, clusterBorder: magenta, edgeLabelBackground: bg, titleColor: text,
      noteBkgColor: panel, noteTextColor: text, noteBorderColor: magenta,
      actorBkg: panel, actorBorder: green, actorTextColor: text, actorLineColor: green, signalColor: text, signalTextColor: text,
      labelBoxBkgColor: panel, labelBoxBorderColor: magenta, labelTextColor: text, loopTextColor: text,
      activationBkgColor: bg, activationBorderColor: green, sequenceNumberColor: bg,
      pie1: green, pie2: magenta, pie3: text, pie4: panel,
    },
  });
}

/** Draw the `.nb-mermaid` boxes under root as they scroll into view of `scroller`. */
export function queueDiagrams(root: HTMLElement, scroller: HTMLElement): void {
  disposeDiagrams();
  const mine = generation;
  const boxes = root.querySelectorAll<HTMLElement>('.nb-mermaid');
  if (!boxes.length) return;
  loadMermaid().catch(() => { /* each box reports its own failure */ });
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer?.unobserve(entry.target);
      chain = chain.then(() => (mine === generation ? renderDiagram(entry.target as HTMLElement) : undefined)).catch(() => { /* shown in the box */ });
    }
  }, { root: scroller, rootMargin: '400px 0px' });
  boxes.forEach((box) => { box.dataset.state = 'idle'; observer?.observe(box); });
}

/** Resolves once the diagrams at or near the top of the page are drawn (or failed), or after `ms`. */
export async function diagramsSettled(root: HTMLElement, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const waiting = Array.from(root.querySelectorAll<HTMLElement>('.nb-mermaid')).some((box) => {
      const state = box.dataset.state;
      return (state === 'idle' || state === 'busy') && box.getBoundingClientRect().top < innerHeight + 300;
    });
    if (!waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

export function disposeDiagrams(): void {
  generation++;
  observer?.disconnect();
  observer = null;
  closeFullscreen();
}

async function renderDiagram(box: HTMLElement): Promise<void> {
  if (!box.isConnected || box.dataset.state === 'done') return;
  const source = box.querySelector('.nb-mermaid-src')?.textContent || '';
  box.dataset.state = 'busy';
  const id = 'nbm' + (++counter);
  const cleanup = (): void => { document.getElementById('d' + id)?.remove(); document.getElementById(id)?.remove(); };
  try {
    const m = await loadMermaid();
    let svg: string;
    try {
      ({ svg } = await m.render(id, source));
    } catch {
      cleanup();
      ({ svg } = await m.render(id + 'r', repairMermaid(source))); // a ';' or an escaped quote trips some sources
    }
    if (!box.isConnected) return;
    box.innerHTML = svg; // mermaid runs at securityLevel "strict": its SVG has no scripts
    box.dataset.state = 'done';
  } catch {
    cleanup();
    if (!box.isConnected) return;
    box.dataset.state = 'error';
    box.replaceChildren();
    const note = document.createElement('div');
    note.className = 'nb-mermaid-note';
    note.textContent = 'This diagram could not be drawn - showing its source.';
    const pre = document.createElement('pre');
    pre.className = 'nb-mermaid-src';
    pre.textContent = source;
    box.append(note, pre);
  }
}

// ---- full-screen viewer: wheel zooms, drag pans, double-click fits, Esc closes ----
let viewer: { overlay: HTMLElement; off(): void } | null = null;

export function closeFullscreen(): void {
  if (!viewer) return;
  const { overlay, off } = viewer;
  viewer = null;
  off();
  overlay.remove();
}

export function openFullscreen(box: HTMLElement): void {
  const source = box.querySelector('svg');
  if (!source) return;
  closeFullscreen();
  const svg = source.cloneNode(true) as SVGSVGElement;
  const vb = source.viewBox && source.viewBox.baseVal;
  const rect = source.getBoundingClientRect();
  const w = (vb && vb.width) || rect.width || 800;
  const h = (vb && vb.height) || rect.height || 600;
  svg.removeAttribute('style');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const overlay = document.createElement('div');
  overlay.className = 'nb-fs-overlay';
  const stage = document.createElement('div');
  stage.className = 'nb-fs-stage';
  stage.appendChild(svg);
  const close = document.createElement('button');
  close.className = 'btn btn-secondary nb-fs-close';
  close.type = 'button';
  close.textContent = 'Close';
  const hint = document.createElement('div');
  hint.className = 'nb-fs-hint';
  hint.textContent = 'Scroll to zoom · drag to pan · double-click to fit · Esc to close';
  overlay.append(stage, close, hint);
  document.body.appendChild(overlay);

  let fit = 1, k = 1, x = 0, y = 0, moved = false;
  let drag: { sx: number; sy: number; x: number; y: number } | null = null;
  const apply = (): void => { stage.style.transform = `translate(${x}px, ${y}px) scale(${fit * k})`; };
  const reset = (): void => {
    const margin = 48;
    fit = Math.max(0.01, Math.min((innerWidth - 2 * margin) / w, (innerHeight - 2 * margin) / h));
    k = 1;
    x = (innerWidth - w * fit) / 2;
    y = (innerHeight - h * fit) / 2;
    apply();
  };
  reset();
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const nk = Math.min(8, Math.max(0.5, k * Math.exp(-e.deltaY * 0.0015)));
    const f = nk / k;
    x = e.clientX - (e.clientX - x) * f;
    y = e.clientY - (e.clientY - y) * f;
    k = nk;
    apply();
  };
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.target === close) return;
    drag = { sx: e.clientX, sy: e.clientY, x, y };
    moved = false;
  };
  const onMove = (e: PointerEvent): void => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!moved && Math.hypot(dx, dy) > 4) { moved = true; overlay.classList.add('nb-fs-drag'); }
    if (moved) { x = drag.x + dx; y = drag.y + dy; apply(); }
  };
  const onUp = (): void => { drag = null; overlay.classList.remove('nb-fs-drag'); };
  const onClick = (e: MouseEvent): void => { if (e.target === overlay && !moved) closeFullscreen(); moved = false; };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFullscreen(); }
  };
  const onClose = (): void => closeFullscreen();
  overlay.addEventListener('wheel', onWheel, { passive: false });
  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('click', onClick);
  overlay.addEventListener('dblclick', reset);
  close.addEventListener('click', onClose);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('keydown', onKey, true);
  addEventListener('resize', reset);
  viewer = {
    overlay,
    off(): void {
      overlay.removeEventListener('wheel', onWheel);
      overlay.removeEventListener('pointerdown', onDown);
      overlay.removeEventListener('click', onClick);
      overlay.removeEventListener('dblclick', reset);
      close.removeEventListener('click', onClose);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', reset);
    },
  };
}
