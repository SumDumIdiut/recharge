/** The editor's panels: tool palette, brush picker with real tile thumbnails, status bar, map rules. DOM only; they read and drive an AmpEditor. */
import type { Atlas } from '../atlas.js';
import { PAINTABLE, contentById } from '../content/index.js';
import type { Brush, OptionCtx, OptionDef } from '../content/types.js';
import { THUMB_PATH, arrowTiles } from '../content/arrows.js';
import { rotMatrix } from '../content/sink.js';
import { parseKey } from '../core/types.js';
import { parseCourseKey } from '../content/coursedata.js';
import type { AmpEditor } from '../editor.js';
import { TOOLS } from '../tools/index.js';
import { h } from '../../dom.js';
import { autotilePick, resolveCell, tileSet } from '../tiling.js';
import { drawResolved } from '../tileart.js';
import { BACKDROPS } from '../backdrop.js';
import { decoImage, decoSprite, onDecoLoaded } from '../deco-art.js';
import { VINES, vineImage, onVineLoaded } from '../vine-art.js';
import { MOSS_TABLE, drawMossSprite, mossImage, onMossLoaded } from '../moss-art.js';

export interface Panel { el: HTMLElement; refresh(): void }

const TOOL_GLYPH: Record<string, string> = { select: '↖', paint: '✎', erase: '⌫', rect: '▭', fill: '◧', pick: '⌖', start: '▶', end: '■', reset: '◷', spawn: '◆', xspawn: '◇', arrow: '↗' };

/** A thumbnail of a brush: a 3x3 autotiled block of a tile set, the game's own tile or sprite, or a letter. */
export function thumbCanvas(atlas: Atlas, brush: Brush, size = 40): HTMLCanvasElement {
  const cv = h('canvas', { className: 'amp-thumb' });
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, size, size);
  const t = brush.thumb;
  if (t.set) {
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
  for (const t of TOOLS) {
    const b = h('button', { className: 'amp-tool', attrs: { type: 'button', title: t.label + ' (' + t.hotkey + ') - ' + t.hint, 'aria-label': t.label } },
      h('span', { className: 'amp-tool-glyph', text: TOOL_GLYPH[t.id] || '•' }),
      h('span', { className: 'amp-tool-key', text: t.hotkey }));
    b.addEventListener('click', () => editor.setTool(t.id));
    buttons.set(t.id, b);
    el.appendChild(b);
  }
  const play = h('button', { className: 'amp-tool amp-play', attrs: { type: 'button', title: 'Playtest (T): run the map with simulated physics', 'aria-label': 'Playtest' } },
    h('span', { className: 'amp-tool-glyph', text: '▷' }), h('span', { className: 'amp-tool-key', text: 'T' }));
  play.addEventListener('click', () => editor.startPlaytest());
  el.appendChild(play);
  return { el, refresh: () => { for (const [id, b] of buttons) b.classList.toggle('is-active', id === editor.tool.id); } };
}

export function brushPicker(editor: AmpEditor, atlas: Atlas): Panel {
  const el = h('div', { className: 'amp-picker' });
  const items: Array<{ content: string; brush: Brush; node: HTMLElement }> = [];
  for (const c of PAINTABLE) {
    const groups = new Map<string, Brush[]>();
    for (const b of c.brushes) (groups.get(b.group) || groups.set(b.group, []).get(b.group) as Brush[]).push(b);
    for (const [group, list] of groups) {
      el.appendChild(h('div', { className: 'amp-group', text: group }));
      const grid = h('div', { className: 'amp-grid' });
      for (const b of list) {
        const node = h('button', { className: 'amp-brush', attrs: { type: 'button', title: b.label } }, thumbCanvas(atlas, b), h('span', { className: 'amp-brush-name', text: b.label }));
        node.addEventListener('click', () => editor.setBrush(c.id, b.id));
        items.push({ content: c.id, brush: b, node });
        grid.appendChild(node);
      }
      el.appendChild(grid);
    }
  }
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
      for (const it of items) it.node.classList.toggle('is-active', it.content === editor.state.content && it.brush.id === editor.state.brush);
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
  const overlay = h('input', { attrs: { type: 'checkbox', disabled: 'disabled', 'aria-label': 'Base level behind the map' } });
  el.appendChild(h('label', { className: 'amp-row is-off', title: 'Not built yet: the base game level behind the map' }, h('span', { text: 'Base level (soon)' }), overlay));
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
  el.append(title, hint, list, del);
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
