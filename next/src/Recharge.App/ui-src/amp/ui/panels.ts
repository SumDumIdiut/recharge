/** The editor's panels: tool palette, brush picker with real tile thumbnails, status bar, map rules. DOM only; they read and drive an AmpEditor. */
import type { Atlas } from '../atlas.js';
import { PAINTABLE, contentById } from '../content/index.js';
import { drawMoverBody, norm as normMover, tileBounds } from '../content/mover.js';
import type { Brush, OptionCtx, OptionDef } from '../content/types.js';
import { THUMB_PATH, arrowTiles } from '../content/arrows.js';
import { rotMatrix } from '../content/sink.js';
import { parseKey } from '../core/types.js';
import { parseCourseKey } from '../content/coursedata.js';
import type { AmpEditor } from '../editor.js';
import { TOOLS, TOOL_GROUPS } from '../tools/index.js';
import { openNodeCreator } from '../nodes/creator.js';
import { h } from '../../dom.js';
import { autotilePick, resolveCell, tileSet } from '../tiling.js';
import { drawResolved } from '../tileart.js';
import { BACKDROPS } from '../backdrop.js';
import { decoImage, decoSprite, onDecoLoaded } from '../deco-art.js';
import { VINES, vineImage, onVineLoaded } from '../vine-art.js';
import { MOSS_TABLE, drawMossSprite, mossImage, onMossLoaded } from '../moss-art.js';

export interface Panel { el: HTMLElement; refresh(): void }

/**
 * The tools' icons: small pictures, one thought each - a cursor, a brush, an eraser block, a hollow shape, a bucket,
 * a dropper, gate doors and dots, a person, two people, an elbowed arrow, a drawn route. Stroke on currentColor, so the
 * active state (green) paints them with the button.
 */
const TOOL_ICONS: Record<string, string> = {
  select: '<path d="M6 3 L14 10 L10 11 L12 16 L9.6 17 L7.6 12 L6 15 Z"/>',
  paint: '<path d="M13 3 C14 2 16 4 15 5.5 L11 10 L9 8 L13 3 Z"/><path d="M9 11 C7 12 5.5 14 5.5 16 C5.5 17.2 6.6 17.6 7.6 16.8 C9 15.6 10 13.5 11 10.5 Z"/>',
  erase: '<path d="M4 12 L9.5 6.5 L15.5 12.5 L10 18 L4 12 Z"/><path d="M7.5 9 L13 14.5"/><path d="M3.5 18 H17"/>',
  rect: '<rect x="4" y="5.5" width="12" height="9" stroke-dasharray="3 2"/>',
  fill: '<path d="M4 9 L11 3.5 L14.5 7 L8 13.5 L4 9 Z"/><path d="M13 9 L16 12 L11 17 L7.5 13.5 L13 9"/>',
  pick: '<path d="M12.5 4.5 L15.5 7.5 L13 10 L10 7 Z"/><path d="M10 7 L4.5 12.5 L4 16 L7.5 15.5 L13 10"/>',
  start: '<circle cx="10" cy="16.5" r="1.6" fill="currentColor" stroke="none"/><path d="M10 14 V5 M7 8 L10 5 L13 8"/>',
  end: '<rect x="4" y="10" width="12" height="4"/><circle cx="10" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  reset: '<path d="M14.5 10 A4.5 4.5 0 1 1 10 5.5"/><path d="M10 2.5 L13.5 5.5 L10 8.5"/>',
  spawn: '<circle cx="10" cy="6" r="2.4"/><path d="M5.5 17 C5.5 11.5 14.5 11.5 14.5 17"/>',
  xspawn: '<circle cx="5.5" cy="15" r="2"/><circle cx="14.5" cy="5" r="2"/><circle cx="5.5" cy="15" r="0.8" fill="currentColor" stroke="none"/><circle cx="14.5" cy="5" r="0.8" fill="currentColor" stroke="none"/>',
  arrow: '<path d="M4 15.5 V9 Q4 6.5 6.5 6.5 H13"/><path d="M10 3.5 L13.5 6.5 L10 9.5"/>',
  zippath: '<path d="M4 16 C8 9 12 9 16 4"/><circle cx="4" cy="16" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10.4" r="1.4" fill="currentColor" stroke="none"/><circle cx="16" cy="4" r="1.4" fill="currentColor" stroke="none"/>',
  play: '<path d="M6.5 4.5 L15.5 10 L6.5 15.5 Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="5.5" y="4.5" width="3" height="11" rx="0.6" fill="currentColor" stroke="none"/><rect x="11.5" y="4.5" width="3" height="11" rx="0.6" fill="currentColor" stroke="none"/>',
  line: '<path d="M4.5 15.5 L15.5 4.5"/><circle cx="4.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="4.5" r="1.3" fill="currentColor" stroke="none"/>',
  frame: '<rect x="4" y="5.5" width="12" height="9"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="7" ry="5"/>',
  ellipseFill: '<ellipse cx="10" cy="10" rx="7" ry="5" fill="currentColor" stroke="none"/>',
  replace: '<path d="M4 7.5 H13"/><path d="M11 5.5 L13 7.5 L11 9.5"/><path d="M16 12.5 H7"/><path d="M9 10.5 L7 12.5 L9 14.5"/>',
};

/** The inner SVG markup for a named icon (a dot stands in until one is drawn). Static constants only. */
function iconSvg(id: string, size: number): string {
  const body = TOOL_ICONS[id] || '<circle cx="10" cy="10" r="6"/>';
  return '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

/** One tool's icon span (a named picture). */
function toolIcon(id: string, size: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'amp-tool-icon';
  span.innerHTML = iconSvg(id, size);
  return span;
}

/** A thumbnail of a brush: a 3x3 autotiled block of a tile set, the game's own tile or sprite, a moving platform's tile shape, or a letter. */
export function thumbCanvas(atlas: Atlas, brush: Brush, size = 40): HTMLCanvasElement {
  const cv = h('canvas', { className: 'amp-thumb' });
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, size, size);
  const t = brush.thumb;
  if (t.mover !== undefined) {
    // the platform it places: its tile shape, drawn the way the editor does, fitted into the thumb square
    const m = normMover(t.mover);
    const b = tileBounds(m);
    drawMoverBody({ ctx, atlas }, 0, 0, m, size / Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1), 1);
  } else if (t.set) {
    const set = tileSet(t.set);
    const cell = size / 3;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const r = resolveCell(set, (dx, dy) => { const x = i + dx, y = 2 - j + dy; return x >= 0 && x < 3 && y >= 0 && y < 3; });
      const px = Math.round(i * cell), py = Math.round(j * cell), s = Math.round((i + 1) * cell) - px;
      drawResolved(atlas, ctx, r, px, py, s);
    }
  } else if (t.tile) {
    atlas.draw(ctx, t.tile, 0, 0, size, { matrix: t.matrix ? ([...t.matrix] as [number, number, number, number]) : undefined });
  } else if (t.sprite) {
    const dim = atlas.size(t.sprite);
    if (dim) { const k = Math.min(size / dim[0], size / dim[1]); atlas.stretch(ctx, t.sprite, (size - dim[0] * k) / 2, (size - dim[1] * k) / 2, dim[0] * k, dim[1] * k); }
  } else if (t.deco) {
    const d = decoSprite(t.deco), img = d && decoImage(d.file);
    if (d && img) { const k = Math.min((size - 4) / d.w, (size - 4) / d.h); ctx.drawImage(img, (size - d.w * k) / 2, (size - d.h * k) / 2, d.w * k, d.h * k); }
    else if (d) { const off = onDecoLoaded(() => { if (decoImage(d.file)) { off(); ctx.fillStyle = '#1b1d20'; ctx.fillRect(0, 0, size, size); const im = decoImage(d.file) as HTMLImageElement, k = Math.min((size - 4) / d.w, (size - 4) / d.h); ctx.drawImage(im, (size - d.w * k) / 2, (size - d.h * k) / 2, d.w * k, d.h * k); } }); }
  } else if (t.vine) {
    const v = VINES.find((x) => x.name === t.vine);
    const draw = (): boolean => {
      const img = vineImage(t.vine as string);
      if (!img || !v) return false;
      ctx.fillStyle = '#1b1d20'; ctx.fillRect(0, 0, size, size);
      // the picture's outline is what matters: fit the sprite's whole square
      const k = (size - 2) / v.size;
      ctx.drawImage(img, (size - img.naturalWidth * k) / 2, (size - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
      return true;
    };
    if (!draw()) { const off = onVineLoaded(() => { if (draw()) off(); }); }
  } else if (t.moss) {
    // a 3x3 patch, autotiled, so the fringe shows (a lone full tile is solid black)
    const m = (): boolean => {
      const cell = size / 3;
      let ok = true;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const n = autotilePick(MOSS_TABLE, (x, y) => x >= 0 && x < 3 && y >= 0 && y < 3, i, 2 - j);
        if (n !== null) ok = drawMossSprite(ctx, n, Math.round(i * cell), Math.round(j * cell), Math.round((i + 1) * cell) - Math.round(i * cell)) && ok;
      }
      return ok;
    };
    if (!m()) { const off = onMossLoaded(() => { off(); m(); }); mossImage(); }
  } else if (t.arrow) {
    // the tool's own example: a path with a bend, drawn in the game's arrow tiles on a 7 x 7 grid
    const cell = size / 7;
    for (const [key, a] of arrowTiles(THUMB_PATH)) {
      const c = parseKey(key), m = rotMatrix(a.q);
      atlas.draw(ctx, a.tile, Math.round(c.x * cell), Math.round((6 - c.y) * cell), Math.ceil(cell), { matrix: [m[0], m[1], m[2], m[3]] });
    }
  } else if (t.glyph) {
    ctx.fillStyle = (t.color || '#f9ffe4');
    ctx.font = '700 ' + Math.round(size * 0.6) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.glyph, size / 2, size / 2 + 1);
  }
  return cv;
}

export function toolPalette(editor: AmpEditor): Panel {
  const el = h('div', { className: 'amp-toolbar', attrs: { role: 'toolbar', 'aria-label': 'Tools' } });
  const buttons = new Map<string, HTMLButtonElement>();
  const toolButton = (t: (typeof TOOLS)[number]): HTMLButtonElement => {
    const b = h('button', { className: 'amp-tool', attrs: { type: 'button', title: t.label + ' (' + t.hotkey + ') — ' + t.hint, 'aria-label': t.label } },
      toolIcon(t.id, 20),
      h('span', { className: 'amp-tool-label', text: t.label }),
      h('span', { className: 'amp-tool-key', text: t.hotkey }));
    b.addEventListener('click', () => editor.setTool(t.id));
    buttons.set(t.id, b);
    return b;
  };
  // Grouped sections, in order, with a labelled heading each; any ungrouped tools fall under "Tools".
  const seen = new Set<string>();
  const order = [...TOOL_GROUPS, 'Tools'];
  for (const group of order) {
    const inGroup = TOOLS.filter((t) => (t.group ?? 'Tools') === group);
    if (!inGroup.length) continue;
    el.appendChild(h('div', { className: 'amp-tool-group', text: group }));
    for (const t of inGroup) { el.appendChild(toolButton(t)); seen.add(t.id); }
  }
  for (const t of TOOLS) if (!seen.has(t.id)) el.appendChild(toolButton(t));
  el.appendChild(h('div', { className: 'amp-tool-group', text: 'Play' }));
  const playIcon = toolIcon('play', 20);
  const play = h('button', { className: 'amp-tool amp-play', attrs: { type: 'button', title: 'Playtest (T): run the map with simulated physics', 'aria-label': 'Playtest' } },
    playIcon, h('span', { className: 'amp-tool-label', text: 'Playtest' }), h('span', { className: 'amp-tool-key', text: 'T' }));
  play.addEventListener('click', () => editor.togglePlaytest());
  el.appendChild(play);
  return {
    el,
    refresh: () => {
      for (const [id, b] of buttons) b.classList.toggle('is-active', id === editor.tool.id);
      // the Play button is a toggle: Pause while the sim runs, Play to start or resume; it stays lit while playtest mode is on
      const pt = editor.playtest;
      const running = pt.active && pt.running;
      playIcon.innerHTML = iconSvg(running ? 'pause' : 'play', 20);
      play.classList.toggle('is-active', pt.active);
      play.title = !pt.active ? 'Playtest (T): run the map with simulated physics' : running ? 'Pause playtest (T)' : 'Resume playtest (T)';
      play.setAttribute('aria-label', running ? 'Pause playtest' : pt.active ? 'Resume playtest' : 'Playtest');
    },
  };
}

export function brushPicker(editor: AmpEditor, atlas: Atlas): Panel {
  const el = h('div', { className: 'amp-picker' });
  const list = h('div', { className: 'amp-picker-list' });
  let items: Array<{ content: string; brush: Brush; node: HTMLElement }> = [];
  const applyActive = (): void => { for (const it of items) it.node.classList.toggle('is-active', it.content === editor.state.content && it.brush.id === editor.state.brush); };
  function renderBrushes(): void {
    list.replaceChildren();
    items = [];
    for (const c of PAINTABLE) {
      const groups = new Map<string, Brush[]>();
      for (const b of c.brushes) (groups.get(b.group) || groups.set(b.group, []).get(b.group) as Brush[]).push(b);
      for (const [group, glist] of groups) {
        list.appendChild(h('div', { className: 'amp-group', text: group }));
        const grid = h('div', { className: 'amp-grid' });
        for (const b of glist) {
          const node = h('button', { className: 'amp-brush', attrs: { type: 'button', title: b.label } }, thumbCanvas(atlas, b), h('span', { className: 'amp-brush-name', text: b.label }));
          node.addEventListener('click', () => editor.setBrush(c.id, b.id));
          items.push({ content: c.id, brush: b, node });
          grid.appendChild(node);
        }
        list.appendChild(grid);
      }
    }
    applyActive();
  }
  renderBrushes();
  el.appendChild(list);
  const newNode = h('button', { className: 'amp-new-node', attrs: { type: 'button', title: 'Create a custom node from behaviours' }, text: '+ New node' });
  newNode.addEventListener('click', () => openNodeCreator(() => renderBrushes()));
  el.appendChild(newNode);
  const options = h('div', { className: 'amp-options' });
  const sizeLabel = h('span', { className: 'amp-opt', text: '' });
  const size = h('div', { className: 'amp-row' }, h('span', { text: 'Brush size' }));
  const minus = h('button', { className: 'amp-mini', text: '−', attrs: { type: 'button', title: 'Smaller ([)' } });
  const plus = h('button', { className: 'amp-mini', text: '+', attrs: { type: 'button', title: 'Larger (])' } });
  minus.addEventListener('click', () => editor.setSize(editor.state.size - 1));
  plus.addEventListener('click', () => editor.setSize(editor.state.size + 1));
  size.append(minus, sizeLabel, plus);
  const rot = h('div', { className: 'amp-row' }, h('span', { text: 'Turn' }));
  const ccw = h('button', { className: 'amp-mini', text: '↺', attrs: { type: 'button', title: 'Turn left (,)' } });
  const cw = h('button', { className: 'amp-mini', text: '↻', attrs: { type: 'button', title: 'Turn right (.)' } });
  ccw.addEventListener('click', () => editor.rotate(1));
  cw.addEventListener('click', () => editor.rotate(-1));
  rot.append(ccw, cw);
  options.append(size, rot);
  el.appendChild(options);
  return {
    el,
    refresh() {
      applyActive();
      sizeLabel.textContent = editor.state.size + '×' + editor.state.size;
    },
  };
}

/** Player abilities of the map: the fields the game reads (`player`) and the playtest honours. */
export function rulesPanel(editor: AmpEditor, markDirty: () => void): Panel {
  const el = h('div', { className: 'amp-rules' }, h('div', { className: 'amp-group', text: 'Player rules' }));
  const rules = (): Record<string, unknown> => ((editor.map.raw ||= {}).player ||= {}) as Record<string, unknown>;
  const num = (label: string, key: string, title: string): HTMLInputElement => {
    const input = h('input', { className: 'amp-num', attrs: { type: 'number', min: '0', max: '9', title, 'aria-label': label } });
    input.addEventListener('input', () => { rules()[key] = Math.max(0, Math.min(9, +input.value || 0)); markDirty(); });
    el.appendChild(h('label', { className: 'amp-row' }, h('span', { text: label }), input));
    return input;
  };
  const dashes = num('Dashes', 'dashes', 'Air dashes (0 = no dash)');
  const jumps = num('Air jumps', 'airJumps', 'Extra jumps in the air');
  const wall = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Wall jump' } });
  wall.addEventListener('change', () => { rules().wallJump = wall.checked; markDirty(); });
  el.appendChild(h('label', { className: 'amp-row' }, h('span', { text: 'Wall jump' }), wall));
  // The base level is not editable here: the map is its own self-contained level (the game plays the level's background behind it).
  el.appendChild(h('div', { className: 'amp-hint-line', title: 'Editing the real game level (its tiles, objects and courses) is not part of this editor yet', text: 'Maps here are standalone: the base game level is not shown or editable.' }));
  return {
    el,
    refresh() {
      const p = (editor.map.raw?.player || {}) as Record<string, unknown>;
      dashes.value = String(typeof p.dashes === 'number' ? p.dashes : 0);
      jumps.value = String(typeof p.airJumps === 'number' ? p.airJumps : 0);
      wall.checked = p.wallJump === true;
    },
  };
}

export function statusBar(editor: AmpEditor): Panel {
  const el = h('div', { className: 'amp-statusbar' });
  const hint = h('span', { className: 'amp-hint' });
  const pos = h('span', { className: 'amp-pos' });
  const counts = h('span', { className: 'amp-counts' });
  const zoom = h('span', { className: 'amp-zoom' });
  el.append(hint, h('span', { className: 'amp-spacer' }), pos, counts, zoom);
  return {
    el,
    refresh() {
      hint.textContent = editor.tool.hint + '  ·  Space/right-drag: pan  ·  wheel: zoom  ·  Ctrl+Z / Ctrl+Y: undo / redo';
      const c = editor.hover;
      pos.textContent = c ? 'cell ' + c.x + ', ' + c.y : '';
      const n = editor.counts();
      counts.textContent = 'blocks ' + (n.blocks || 0) + ' · spikes ' + (n.spikes || 0) + ' · vines ' + (n.vines || 0) + ' · moss ' + (n.moss || 0) + ' · objects ' + (n.objects || 0) + ' · movers ' + (n.movers || 0) + ' · triggers ' + (n.triggers || 0) + ' · arrows ' + (n.arrows || 0) + ' · scenery ' + (n.deco || 0);
      zoom.textContent = Math.round(editor.camera.zoom * 100) + '%';
    },
  };
}

// ---- properties: the options of the selected thing, or of the brush ----

function control(def: OptionDef, onChange: (v: unknown) => void): { el: HTMLElement; input: HTMLInputElement | HTMLSelectElement; read(value: unknown, ctx?: OptionCtx): void } {
  let input: HTMLInputElement | HTMLSelectElement;
  if (def.type === 'select') {
    const sel = h('select', { className: 'amp-text', attrs: { 'aria-label': def.label } });
    for (const c of def.choices || []) sel.appendChild(h('option', { text: c.label, attrs: { value: c.value } }));
    sel.addEventListener('change', () => onChange(sel.value));
    input = sel;
  } else {
    const kind = def.type === 'bool' ? 'checkbox' : def.type === 'color' ? 'color' : def.type === 'number' ? 'number' : 'text';
    const inp = h('input', { className: def.type === 'number' ? 'amp-num' : 'amp-text', attrs: { type: kind, 'aria-label': def.label } });
    if (def.type === 'number') {
      if (def.min !== undefined) inp.min = String(def.min);
      if (def.max !== undefined) inp.max = String(def.max);
      inp.step = String(def.step ?? 1);
    }
    inp.addEventListener(def.type === 'bool' ? 'change' : 'input', () => {
      if (def.type === 'bool') return onChange(inp.checked);
      if (def.type === 'number') {
        if (inp.value === '' || !Number.isFinite(+inp.value)) return;
        return onChange(Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, +inp.value)));
      }
      onChange(inp.value);
    });
    input = inp;
  }
  const row = h('label', { className: 'amp-row amp-opt-row', title: def.hint || '' }, h('span', { className: 'amp-opt-label', text: def.label + (def.unit ? ' (' + def.unit + ')' : '') }), input);
  return {
    el: row,
    input,
    read(value, ctx) {
      const v = def.get(value, ctx);
      if (document.activeElement === input) return;
      if (def.type === 'bool') (input as HTMLInputElement).checked = !!v;
      else input.value = String(v ?? '');
    },
  };
}

/** What a selected course part is called ("Course 2 start gate"). */
function partLabel(layer: string, key: string): string {
  if (layer !== 'course') return '';
  const k = parseCourseKey(key);
  if (!k) return '';
  const names: Record<string, string> = { start: 'start gate', end: 'end gate', screen: 'screen', reset: 'timer reset', spawn: 'spawn', xspawn: 'extra spawn ' + k.index };
  return (k.n >= 1 ? 'Course ' + k.n + ' ' : '') + (names[k.part] || k.part);
}

export function propertiesPanel(editor: AmpEditor): Panel {
  const el = h('div', { className: 'amp-props' });
  const title = h('div', { className: 'amp-group' });
  const hint = h('div', { className: 'amp-hint-line' });
  const list = h('div', { className: 'amp-options' });
  const del = h('button', { className: 'amp-wide', text: 'Delete (Del)', attrs: { type: 'button' } });
  del.addEventListener('click', () => editor.deleteSelection());
  const hiddenBox = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Group starts hidden' } }) as HTMLInputElement;
  const hiddenText = h('span');
  const hiddenRow = h('label', { className: 'amp-row', title: 'The group is off when the map starts; a Show or Toggle trigger turns it on.' }, hiddenText, hiddenBox);
  hiddenRow.hidden = true;
  const groupOfSel = (): string => { const v = editor.selected()?.value as { group?: unknown } | undefined; return typeof v?.group === 'string' ? v.group : ''; };
  hiddenBox.addEventListener('change', () => {
    const g = groupOfSel();
    if (!g) return;
    const set = new Set(editor.map.hiddenGroups);
    if (hiddenBox.checked) set.add(g); else set.delete(g);
    editor.map.hiddenGroups = [...set];
    editor.onChange();
  });
  el.append(title, hint, list, hiddenRow, del);
  let sig = '';
  let controls: Array<{ def: OptionDef; read(v: unknown, ctx?: OptionCtx): void }> = [];
  return {
    el,
    refresh() {
      const sel = editor.selected();
      const content = sel ? sel.content : contentById(editor.state.content);
      const value = sel ? sel.value : editor.state.draft;
      const ctx: OptionCtx = sel ? { map: editor.map, layer: sel.layer, key: sel.key } : { map: editor.map };
      const hit = content?.brushOf(value);
      const defs = content ? content.options(value, ctx) : [];
      const next = (sel ? 'S' + sel.layer + sel.key : 'B') + '|' + (content?.id || '') + '|' + defs.map((d) => d.key + (d.type === 'select' ? JSON.stringify(d.choices?.map((c) => c.value)) : '')).join(',');
      title.textContent = sel ? 'Selected: ' + (hit?.brush.label || partLabel(sel.layer, sel.key) || content?.label) : 'Brush options: ' + (hit?.brush.label || content?.label || '');
      hint.textContent = sel ? 'Edit it here. Drag it with Select to move.' : defs.length ? 'What the next one you place will have.' : 'Nothing to set for this one.';
      del.hidden = !sel;
      if (next !== sig) {
        sig = next;
        list.textContent = '';
        controls = defs.map((def) => {
          const c = control(def, (v) => {
            const cur = editor.selected();
            const base = cur ? cur.value : editor.state.draft;
            const cx: OptionCtx = cur ? { map: editor.map, layer: cur.layer, key: cur.key } : { map: editor.map };
            if (def.edits && cur) { editor.editMany(def.edits(base, v, cx)); return; }
            const updated = def.set(base, v, cx);
            if (cur) editor.editSelection(updated); else editor.setDraft(updated);
          });
          list.appendChild(c.el);
          return { def, read: c.read };
        });
      }
      for (const c of controls) c.read(value, ctx);
      const g = sel ? groupOfSel() : '';
      hiddenRow.hidden = !g;
      if (g) { hiddenText.textContent = 'Group "' + g + '" starts hidden'; hiddenBox.checked = editor.map.hiddenGroups.includes(g); }
    },
  };
}

// ---- layers and background ----

const ROLE_LABEL: Record<string, string> = { back: 'behind', main: 'main', front: 'front' };

export function layersPanel(editor: AmpEditor): Panel {
  const el = h('div', { className: 'amp-layers' }, h('div', { className: 'amp-group', text: 'Layers' }));
  const list = h('div', { className: 'amp-layer-list' });
  const add = h('div', { className: 'amp-row amp-layer-add' });
  for (const [role, label] of [['back', '+ Behind'], ['main', '+ Main'], ['front', '+ Front']] as const) {
    const b = h('button', { className: 'amp-mini amp-mini-wide', text: label, attrs: { type: 'button', title: 'Add a ' + ROLE_LABEL[role] + ' layer' } });
    b.addEventListener('click', () => editor.newLayer(role, (role === 'back' ? 'Background' : role === 'main' ? 'Main' : 'Foreground') + ' ' + (editor.map.layerDefs.filter((l) => l.role === role).length + 1)));
    add.appendChild(b);
  }
  el.append(list, add);
  let sig = '';
  return {
    el,
    refresh() {
      const defs = editor.map.layerDefs;
      const next = JSON.stringify(defs) + editor.state.layer;
      if (next === sig) return;
      sig = next;
      list.textContent = '';
      for (let i = defs.length - 1; i >= 0; i--) {
        const l = defs[i];
        const btn = (text: string, title: string, fn: () => void, on = false): HTMLButtonElement => {
          const b = h('button', { className: 'amp-mini' + (on ? ' is-on' : ''), text, attrs: { type: 'button', title } });
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          return b;
        };
        const row = h('div', { className: 'amp-layer' + (l.id === editor.state.layer ? ' is-active' : '') + (l.visible ? '' : ' is-hidden') },
          btn(l.visible ? '◉' : '○', l.visible ? 'Hide this layer' : 'Show this layer', () => editor.toggleLayer(l.id, 'visible'), l.visible),
          btn(l.locked ? '▣' : '□', l.locked ? 'Unlock this layer' : 'Lock this layer (no edits)', () => editor.toggleLayer(l.id, 'locked'), l.locked),
          h('span', { className: 'amp-layer-name', text: l.name, attrs: { title: 'Paint on this layer (double-click to rename)' } }),
          h('span', { className: 'amp-layer-role', text: ROLE_LABEL[l.role] }),
          btn('▲', 'Move up (drawn later)', () => editor.shiftLayer(l.id, 1)),
          btn('▼', 'Move down (drawn earlier)', () => editor.shiftLayer(l.id, -1)),
          btn('✕', 'Delete this layer and everything in it', () => { if (editor.map.layerDefs.filter((x) => x.role === l.role).length > 1) editor.dropLayer(l.id); }));
        row.addEventListener('click', () => editor.setLayer(l.id));
        row.addEventListener('dblclick', () => { const n = window.prompt('Layer name', l.name); if (n) editor.renameLayer(l.id, n); });
        list.appendChild(row);
      }
    },
  };
}

export function backgroundPanel(editor: AmpEditor): Panel {
  const el = h('div', { className: 'amp-bgpanel' }, h('div', { className: 'amp-group', text: 'Background' }));
  const sel = h('select', { className: 'amp-text amp-wide', attrs: { 'aria-label': 'Level background' } });
  for (const b of BACKDROPS) sel.appendChild(h('option', { text: b.label, attrs: { value: b.id } }));
  sel.addEventListener('change', () => { editor.backdrop = sel.value; });
  const par = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Parallax' } });
  par.addEventListener('change', () => { editor.map.parallax = par.checked; editor.redraw(); editor.onChange(); });
  el.append(sel, h('label', { className: 'amp-row', title: 'The background drifts slower than the map as you pan, as in the game.' }, h('span', { text: 'Parallax' }), par));
  return {
    el,
    refresh() {
      if (document.activeElement !== sel) sel.value = editor.backdrop;
      par.checked = editor.map.parallax;
    },
  };
}
