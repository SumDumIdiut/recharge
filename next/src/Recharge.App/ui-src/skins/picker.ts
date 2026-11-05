// The Skins page's picker: a stage that plays the chosen skin's animations from its sheet, and a grid of every installed skin.
// One click previews a skin on the stage, "Wear" (or a double click) puts it on: live when the game is linked, else on next launch.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { call, describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { emptyState } from '../components/emptyState.js';
import { skeletonCards } from '../components/skeleton.js';
import { itemRoute, type Item } from '../lib/library.js';
import { applySkin, appliedMessage, currentSkinFolder, gameRunning } from '../lib/skinApply.js';
import { fitRect, rowFrames, skinCanvas, SKIN_ROWS, type Rect } from '../lib/skinThumb.js';
import { blobUrlFromReply } from '../create/format.js';

interface Sheet { image: HTMLImageElement; keyed: HTMLCanvasElement; rows: Rect[][] }

const FPS = 10;
const sheets = new Map<string, Promise<Sheet | null>>();

/** A skin folder's sheet, loaded once through the bridge and cut into its animation rows. Null without a sheet. */
function loadSheet(folder: string): Promise<Sheet | null> {
  let pending = sheets.get(folder);
  if (!pending) {
    // A skin whose template sheet is empty keeps its art in doublejump.png, so that is the second try.
    pending = readSheet(folder).then((sheet) => (sheet && sheet.rows.some((r) => r.length > 0) ? sheet : readSheet(folder, 'doublejump.png').then((alt) => (alt && alt.rows.some((r) => r.length > 0) ? alt : sheet))));
    sheets.set(folder, pending);
  }
  return pending;
}

function readSheet(folder: string, file?: string): Promise<Sheet | null> {
    return call<{ mime?: string; data?: string | null }>('create.skinSheet', file ? { folder, file } : { folder }).then((reply) => {
      const url = blobUrlFromReply(reply);
      if (!url) return null;
      return new Promise<Sheet | null>((resolve) => {
        const image = new Image();
        image.onload = () => {
          const w = image.naturalWidth, hgt = image.naturalHeight;
          const keyed = document.createElement('canvas');
          keyed.width = w; keyed.height = hgt;
          const ctx = keyed.getContext('2d', { willReadFrequently: true });
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(image, 0, 0);
          try {
            const px = ctx.getImageData(0, 0, w, hgt);
            const rows = SKIN_ROWS.map((_, r) => rowFrames(px.data, w, hgt, r));
            ctx.putImageData(px, 0, 0);
            resolve({ image, keyed, rows });
          } catch {
            resolve(null);
          }
        };
        image.onerror = () => resolve(null);
        image.src = url;
      });
    }, () => null);
}

export interface SkinPicker {
  element: HTMLElement;
  /** The installed skins to offer (already searched and sorted), and whether the list is still loading. */
  update(items: Item[], loading: boolean): void;
  dispose(): void;
}

export function skinPicker(): SkinPicker {
  const root = h('div', { className: 'skin-picker' });
  let items: Item[] = [];
  let worn: string | null | undefined; // undefined until the config has been read
  let selected: string | null | undefined; // the folder on the stage; null is the game's own look
  let row = 1; // Run
  let disposed = false;
  let running = false;

  // ---------- the stage ----------
  const canvas = h('canvas', { className: 'sp-canvas' }) as HTMLCanvasElement;
  const stageArt = h('div', { className: 'sp-stage-art' }, canvas, h('div', { className: 'sp-floor' }));
  const eyebrow = h('div', { className: 'sp-eyebrow' });
  const title = h('h2', { className: 'sp-title' });
  const note = h('p', { className: 'sp-note dim' });
  const rowChips = h('div', { className: 'sp-rows', attrs: { role: 'group', 'aria-label': 'Animation' } });
  const actions = h('div', { className: 'sp-actions' });
  const info = h('div', { className: 'sp-stage-info' }, eyebrow, title, note, rowChips, actions);
  const stage = h('section', { className: 'sp-stage panel' }, stageArt, info);
  const head = h('div', { className: 'sp-head' });
  const grid = h('div', { className: 'sp-grid', attrs: { role: 'listbox', 'aria-label': 'Your skins' } });
  // The empty state sits outside the grid: inside it, it would be squeezed into one tile-wide column.
  const empty = h('div', { className: 'sp-empty' });
  root.append(stage, head, grid, empty);

  let sheet: Sheet | null = null;
  let frame = 0;
  let last = 0;
  let raf = 0;

  function draw(): void {
    const box = stageArt.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(box.width * dpr)), ch = Math.max(1, Math.round(box.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!sheet) return;
    const frames = sheet.rows[row].length ? sheet.rows[row] : sheet.rows.find((r) => r.length) ?? [];
    if (frames.length === 0) return;
    const src = frames[frame % frames.length];
    ctx.imageSmoothingEnabled = false;
    // Stand the character on the floor line, a little above the bottom.
    const f = fitRect(src, cw, ch * 0.86, Math.round(ch * 0.04));
    ctx.drawImage(sheet.keyed, src.x, src.y, src.w, src.h, Math.round(f.dx), Math.round(f.dy + ch * 0.02), Math.round(f.dw), Math.round(f.dh));
  }

  function tick(now: number): void {
    if (disposed) return;
    if (!root.isConnected) { raf = requestAnimationFrame(tick); return; }
    if (now - last >= 1000 / FPS) { last = now; frame++; draw(); }
    raf = requestAnimationFrame(tick);
  }

  function paintRows(): void {
    rowChips.replaceChildren();
    if (!sheet) return;
    SKIN_ROWS.forEach((name, r) => {
      const has = sheet!.rows[r].length > 0;
      const chip = h('button', { className: 'chip' + (r === row ? ' is-on' : ''), text: name, attrs: { type: 'button', 'aria-pressed': String(r === row) } });
      if (!has) { chip.setAttribute('disabled', 'disabled'); chip.title = 'This skin has no ' + name.toLowerCase() + ' frames'; }
      chip.addEventListener('click', () => { row = r; frame = 0; paintRows(); draw(); });
      rowChips.append(chip);
    });
  }

  function nameOf(folder: string | null): string {
    if (folder === null) return 'Default look';
    return items.find((i) => i.installed?.folder === folder)?.name || folder;
  }

  function paintStage(): void {
    const folder = selected ?? null;
    const wearing = worn !== undefined && (worn ?? null) === folder;
    eyebrow.textContent = wearing ? 'Wearing now' : 'Preview';
    eyebrow.classList.toggle('is-worn', wearing);
    title.textContent = nameOf(folder);
    const item = folder ? items.find((i) => i.installed?.folder === folder) : undefined;
    note.textContent = folder === null ? "The game's own character, no skin." : item && item.author && !item.local ? 'by ' + item.author : 'A skin in your skins folder.';
    actions.replaceChildren();
    if (wearing) {
      actions.append(h('span', { className: 'sp-worn' }, icon('check', 16), h('span', { text: running ? 'Wearing in the game' : 'Worn on the next launch' })));
    } else {
      actions.append(button(running ? 'Wear now' : 'Wear on next launch', { kind: 'primary', icon: 'check', onClick: () => void wear(folder) }));
    }
    if (item) {
      const details = h('a', { className: 'btn btn-ghost', attrs: { href: itemRoute(item) } }, icon('info', 18), h('span', { text: 'Details' }));
      actions.append(details);
      actions.append(button('Show folder', { kind: 'ghost', icon: 'folder', onClick: () => void call('open.folder', { kind: 'skin', folder }).catch((e) => toast(describeError(e), 'error')) }));
    }
    stage.classList.toggle('is-vanilla', folder === null);
  }

  function show(folder: string | null): void {
    selected = folder;
    sheet = null;
    frame = 0;
    paintStage();
    paintRows();
    draw();
    paintSelection();
    if (folder === null) return;
    void loadSheet(folder).then((s) => {
      if (disposed || selected !== folder) return;
      sheet = s;
      if (s && !s.rows[row].length) row = Math.max(0, s.rows.findIndex((r) => r.length));
      if (!s) note.textContent = 'This skin has no character sheet (it may only change sounds or effects).';
      paintRows();
      draw();
    });
  }

  async function wear(folder: string | null): Promise<void> {
    try {
      const mode = await applySkin(folder);
      worn = folder;
      toast(appliedMessage(mode, nameOf(folder)), 'success');
    } catch (error) {
      toast('Could not wear it: ' + describeError(error), 'error');
    }
    paintStage();
    paintGrid();
  }

  // ---------- the grid ----------
  const thumbs = new Map<string, HTMLElement>();

  function tile(folder: string | null, name: string, item?: Item): HTMLElement {
    const key = folder ?? '';
    const art = h('div', { className: 'sp-tile-art' });
    const node = h('button', { className: 'sp-tile', attrs: { type: 'button', role: 'option', title: name } }, art, h('span', { className: 'sp-tile-name', text: name }));
    node.dataset.folder = key;
    if (folder === null) art.append(h('div', { className: 'sp-vanilla' }, icon('user', 34)));
    else {
      const cached = thumbs.get(key);
      if (cached) art.append(cached);
      else {
        void loadSheet(folder).then((s) => {
          if (!s) { art.append(h('div', { className: 'sp-vanilla is-empty' }, icon('skins', 30))); return; }
          const c = skinCanvas(s.image, 120, 120);
          if (c) { thumbs.set(key, c); art.append(c); }
          else art.append(h('div', { className: 'sp-vanilla is-empty', title: 'No character frames in this sheet' }, icon('skins', 30)));
        });
      }
    }
    if (item?.status === 'update') node.append(h('span', { className: 'badge badge-update sp-tile-badge', text: 'Update' }));
    node.addEventListener('click', () => show(folder));
    node.addEventListener('dblclick', () => void wear(folder));
    return node;
  }

  function paintSelection(): void {
    for (const node of Array.from(grid.children) as HTMLElement[]) {
      const folder = node.dataset.folder || null;
      node.classList.toggle('is-selected', folder === (selected ?? null));
      node.setAttribute('aria-selected', String(folder === (selected ?? null)));
      node.classList.toggle('is-worn', worn !== undefined && folder === (worn ?? null));
    }
  }

  function paintGrid(): void {
    const skins = items.filter((i) => i.installed?.folder);
    head.replaceChildren(h('h2', { className: 'sp-heading', text: 'Your skins' }), h('span', { className: 'sp-count', text: String(skins.length) }));
    grid.replaceChildren(tile(null, 'Default look'), ...skins.map((i) => tile(i.installed!.folder!, i.name, i)));
    paintSelection();
  }

  let first = true;
  function update(next: Item[], loading: boolean): void {
    items = next;
    const skins = items.filter((i) => i.installed?.folder);
    if (skins.length === 0) {
      stage.hidden = true;
      head.replaceChildren();
      grid.replaceChildren();
      empty.replaceChildren(loading ? skeletonCards(3) : emptyState('skins', 'No skins yet', 'Get skins from the hub, or drop your own in the skins folder.', { label: 'Open skins folder', kind: 'secondary', onClick: () => void call('open.folder', { kind: 'skins' }).catch(() => {}) }));
      return;
    }
    empty.replaceChildren();
    stage.hidden = false;
    paintGrid();
    if (first) {
      first = false;
      void Promise.all([currentSkinFolder(), gameRunning()]).then(([folder, live]) => {
        if (disposed) return;
        worn = folder && skins.some((i) => i.installed?.folder === folder) ? folder : folder ?? null;
        running = live;
        show(selected === undefined ? worn : selected);
      });
    } else paintStage();
  }

  raf = requestAnimationFrame(tick);
  window.addEventListener('resize', draw);
  return {
    element: root,
    update,
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', draw);
    },
  };
}
