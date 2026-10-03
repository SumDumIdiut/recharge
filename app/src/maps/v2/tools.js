// What the pointer and keys do, per tool, and what's drawn over the map for them.
//   select (Edit): click a thing; drag it (and the rest of the selection) to move; drag empty space to box
//           a part of the map: the things in it and its tiles, to move (drag inside), copy, paste or delete.
//           Ctrl while moving or placing lines it up with the things around it.
//   brush:  paint the chosen tileset (fits itself to the tiles around it, rules.js).
//   erase:  take away the thing or the top tile under the pointer (tiles around refit).
// Panning: middle or right drag, or Space + drag, with any tool.
import { layerInfo } from './base.js';
import { ARROW_LAYER, redrawArrow, extendTo } from './arrows.js';
import { partsOf, zipOf } from './render/world.js';
import { familyOf } from './rules.js';

const ERASE_PAUSE = 250;
const bare = (n) => n.replace(/@-?\d+$/, '');

export class Tools {
  constructor(ed) {
    this.ed = ed;
    this.tool = 'select';
    this.drag = null;
    this.hover = null;
    this.space = false;
  }

  get doc() { return this.ed.doc; }

  setTool(t) {
    if (t === 'region') t = 'select';
    if (t !== 'select' && t !== 'paste') this.region = null;
    this.tool = t; this.ed.emit('tool'); this.ed.panels?.syncPicked?.(); this.ed.dirty = true; }

  // ---- pointer ----
  down(e, w) {
    const ed = this.ed;
    if (e.button === 1 || e.button === 2 || this.space) { this.drag = { pan: true, x: e.clientX, y: e.clientY }; return; }
    if (e.button !== 0) return;
    if (this.tool === 'select') {
      // A selected zip mover's end: drag it to set where it goes.
      for (const id of ed.selection) {
        const z = this.zipEnd(id);
        if (z && Math.hypot((w.x - z.x) * ed.cam.scale, (w.y - z.y) * ed.cam.scale) < 10) { this.doc.begin('Zip path'); this.doc.touch(id); this.drag = { zip: id }; return; }
      }
      // Inside a boxed part: the whole of it moves, tiles and all.
      const r = this.region;
      if (r && !e.shiftKey && w.x >= r.x0 && w.x <= r.x1 && w.y >= r.y0 && w.y <= r.y1) { this.drag = { regionMove: true, from: w, dx: 0, dy: 0 }; return; }
      const id = ed.markers.at(w.x, w.y) || ed.renderer.entityAt(w.x, w.y);
      if (id) {
        if (e.shiftKey) { ed.select(ed.selection.has(id) ? [...ed.selection].filter((x) => x !== id) : [...ed.selection, id]); return; }
        this.region = null;
        if (!ed.selection.has(id)) ed.select([id]);
        const ids = [...ed.selection];
        this.doc.begin('Move');
        ids.forEach((i) => { if (!i.startsWith('m:')) this.doc.touch(i); });
        this.drag = { move: true, lead: id, from: w, b0: this.boxOf(id), start: ids.map((i) => { const p = ed.markers.pos(i); return p ? [i, p.x, p.y] : null; }).filter(Boolean), moved: false };
        return;
      }
      if (!e.shiftKey) { ed.select([]); this.region = null; }
      this.drag = { box: true, from: w, to: w, add: e.shiftKey };
      return;
    }
    if (this.tool === 'place') { const g = this.placing(w); ed.placeAt(g.at, g.exact); return; }
    if (this.tool === 'arrow') {
      const g = this.arrowCell(w), same = (p) => p && p[0] === g[0] && p[1] === g[1];
      let a = this.doc.entities.find((x) => x.kind === 'arrow' && same(x.cells[x.cells.length - 1]));
      let rev = false;
      if (!a) { a = this.doc.entities.find((x) => x.kind === 'arrow' && same(x.cells[0])); rev = !!a; }
      this.doc.begin('Arrow');
      if (a && e.altKey) { redrawArrow(this.doc.tiles, a.cells, null); this.doc.remove(a.id); this.doc.commit(); ed.tilesChanged(); return; }
      if (a) { this.doc.touch(a); if (rev) { const old = a.cells.map((c) => [...c]); a.cells.reverse(); redrawArrow(this.doc.tiles, old, a.cells); } }
      else a = this.doc.add({ kind: 'arrow', cells: [g], x: w.x, y: w.y });
      this.drag = { arrow: a.id };
      return;
    }
    if (this.tool === 'paste') { this.pasteAt(w); return; }
    if (this.tool === 'brush' || this.tool === 'erase') {
      this.doc.begin(this.tool === 'brush' ? 'Paint' : 'Erase');
      this.drag = { stroke: true, done: new Set() };
      this.strokeAt(w);
    }
  }

  move(e, w) {
    const ed = this.ed, d = this.drag;
    this.hover = w;
    this.ctrl = e.ctrlKey || e.metaKey;
    this.guides = null;
    if (!d) { ed.dirty = true; return; }
    if (d.pan) {
      ed.cam.x -= (e.clientX - d.x) / ed.cam.scale;
      ed.cam.y += (e.clientY - d.y) / ed.cam.scale;
      d.x = e.clientX; d.y = e.clientY;
    } else if (d.move) {
      let dx = w.x - d.from.x, dy = w.y - d.from.y;
      if (this.ctrl && d.b0) {
        const a = this.align([d.b0[0] + dx, d.b0[1] + dy, d.b0[2] + dx, d.b0[3] + dy], new Set(d.start.map(([i]) => i)));
        dx += a.dx; dy += a.dy; this.guides = a.guides;
      } else if (!e.altKey && ed.snap) [dx, dy] = this.snapMove(d, dx, dy);
      for (const [id, x, y] of d.start) {
        if (id.startsWith('m:')) { ed.markers.set(id, { x: x + dx, y: y + dy }); continue; }
        const en = this.doc.get(id);
        if (en) { en.x = x + dx; en.y = y + dy; }
      }
      d.moved = d.moved || dx !== 0 || dy !== 0;
      this.doc.rev++;
    } else if (d.box) d.to = w;
    else if (d.regionMove) { d.dx = Math.round((w.x - d.from.x) / 32) * 32; d.dy = Math.round((w.y - d.from.y) / 32) * 32; }
    else if (d.stroke) this.strokeAt(w);
    else if (d.zip) {
      const en = this.doc.get(d.zip), c = en.cfg || {}, k = c.scale || 1, a = -((c.rot || 0) * Math.PI) / 180;
      // Into the zip mover's own unturned, unscaled units; on a 16-unit step unless Alt is held.
      let dx = w.x - en.x, dy = w.y - en.y;
      [dx, dy] = [Math.cos(a) * dx - Math.sin(a) * dy, Math.sin(a) * dx + Math.cos(a) * dy];
      dx /= k * (c.sx || 1) * (c.fx ? -1 : 1); dy /= k * (c.sy || 1) * (c.fy ? -1 : 1);
      if (!e.altKey) { dx = Math.round(dx / 16) * 16; dy = Math.round(dy / 16) * 16; }
      en.cfg = { ...c, zip: { ...(c.zip || {}), end: [dx, dy] } };
      this.doc.rev++;
    }
    else if (d.arrow) {
      const a = this.doc.get(d.arrow), old = a.cells.map((c) => [...c]);
      extendTo(a.cells, this.arrowCell(w));
      if (JSON.stringify(old) !== JSON.stringify(a.cells)) { redrawArrow(this.doc.tiles, old, a.cells); a.x = w.x; a.y = w.y; ed.tilesChanged(); }
    }
    ed.dirty = true;
  }

  // A move that lands the grabbed thing on the snap grid (tile centres for a whole tile, the
  // tile grid's own lines for less).
  snapMove(d, dx, dy) {
    const S = this.ed.snap, [, x, y] = d.start.find(([i]) => i === d.lead) || d.start[0] || [0, 0, 0];
    const ox = S >= 32 ? 16 : 0, oy = 9 + ox;
    return [Math.round((x + dx - ox) / S) * S + ox - x, Math.round((y + dy - oy) / S) * S + oy - y];
  }
  // A thing's box (a course marker's too).
  boxOf(id) {
    const m = id.startsWith('m:') && this.ed.markers.list().find((q) => q.id === id);
    if (m) return [m.x + m.box.dx - m.box.w / 2, m.y + m.box.dy - m.box.h / 2, m.x + m.box.dx + m.box.w / 2, m.y + m.box.dy + m.box.h / 2];
    return this.ed.renderer.boundsOf(id);
  }
  // Ctrl: the box b moved onto the nearest edge or centre line of the things around it (within a few
  // pixels on screen), each way. { dx, dy, guides: [{ x | y, from, to }] }
  align(b, skip) {
    const k = this.ed.cam.scale, tol = 10 / k, reach = Math.max(600, 3 * Math.max(b[2] - b[0], b[3] - b[1]));
    const mx = [b[0], (b[0] + b[2]) / 2, b[2]], my = [b[1], (b[1] + b[3]) / 2, b[3]];
    // Nearer things win over a slightly closer line on a far one.
    let bx = null, by = null;
    for (const [id, c] of this.ed.renderer.allBounds()) {
      const gap = Math.max(0, c[0] - b[2], b[0] - c[2], c[1] - b[3], b[1] - c[3]);
      if (skip.has(id) || id === 'ghost' || gap > reach) continue;
      for (const m of mx) for (const t of [c[0], (c[0] + c[2]) / 2, c[2]]) { const dd = t - m, sc = Math.abs(dd) * k + gap * k * 0.05; if (Math.abs(dd) <= tol && (!bx || sc < bx.sc)) bx = { d: dd, t, c, sc }; }
      for (const m of my) for (const t of [c[1], (c[1] + c[3]) / 2, c[3]]) { const dd = t - m, sc = Math.abs(dd) * k + gap * k * 0.05; if (Math.abs(dd) <= tol && (!by || sc < by.sc)) by = { d: dd, t, c, sc }; }
    }
    const dx = bx?.d || 0, dy = by?.d || 0, guides = [];
    if (bx) guides.push({ x: bx.t, from: Math.min(b[1] + dy, bx.c[1]), to: Math.max(b[3] + dy, bx.c[3]) });
    if (by) guides.push({ y: by.t, from: Math.min(b[0] + dx, by.c[0]), to: Math.max(b[2] + dx, by.c[2]) });
    return { dx, dy, guides };
  }
  // Where the place tool puts its thing for the pointer at w: on the snap grid, or with Ctrl lined up.
  placing(w) {
    const ed = this.ed, at = ed.snapCell(w);
    if (!this.ctrl) return { at, exact: false };
    const ghost = ed.ghostOf(w, true), b = ghost && ed.renderer.boundsOfScene([ghost]);
    if (!b) return { at, exact: false };
    const a = this.align(b, new Set());
    this.guides = a.guides;
    return { at: { x: ghost.x + a.dx, y: ghost.y + a.dy }, exact: true };
  }

  up() {
    const ed = this.ed, d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.regionMove) this.moveRegion(d.dx, d.dy);
    else if (d.move) this.doc.commit();
    else if (d.box) {
      const [x0, x1] = [Math.min(d.from.x, d.to.x), Math.max(d.from.x, d.to.x)], [y0, y1] = [Math.min(d.from.y, d.to.y), Math.max(d.from.y, d.to.y)];
      if (x1 - x0 > 2 / ed.cam.scale || y1 - y0 > 2 / ed.cam.scale) {
        const inside = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        const hit = [...this.doc.entities.filter(inside).map((en) => en.id), ...ed.markers.list().filter((m) => m.id.startsWith('m:') && inside(m)).map((m) => m.id)];
        // The tiles in it too (on the tile grid), unless boxes take things only.
        const c = (v) => Math.round(v / 32) * 32, cy = (v) => Math.round((v - 9) / 32) * 32 + 9;
        const r = { x0: c(x0), y0: cy(y0), x1: c(x1), y1: cy(y1) };
        this.region = !d.add && ed.boxTiles !== false && r.x1 > r.x0 && r.y1 > r.y0 && this.regionCells(r).length ? r : null;
        ed.select(d.add ? [...new Set([...ed.selection, ...hit])] : hit);
      }
    } else if (d.stroke) { this.doc.commit(); ed.tilesChanged(); }
    else if (d.zip) this.doc.commit();
    else if (d.arrow) {
      const a = this.doc.get(d.arrow);
      // A click without a path is no arrow.
      if (a && a.cells.length < 2) this.doc.remove(a.id);
      this.doc.commit(); ed.tilesChanged();
    }
    ed.dirty = true;
  }

  // One spot of a brush or eraser stroke.
  strokeAt(w) {
    const ed = this.ed, d = this.drag;
    if (this.tool === 'brush') {
      const b = ed.brush;
      if (!b) { ed.flash('Pick a tileset in the palette first.'); return; }
      if (ed.lockedLayers.has(b.layer)) { ed.flash('That layer is locked (Layers tab).'); return; }
      const li = layerInfo(ed.base, b.layer), x = Math.floor((w.x - li.ox) / li.size), y = Math.floor((w.y - li.oy) / li.size);
      const cells = [];
      for (let dx = 0; dx < b.size; dx++) for (let dy = 0; dy < b.size; dy++) {
        const k = (x + dx) + ',' + (y + dy);
        if (!d.done.has(k)) { d.done.add(k); cells.push([x + dx, y + dy]); }
      }
      if (cells.length) { ed.rules.paint(this.doc.tiles, b.layer, cells, { family: b.family, prefer: b.prefer }); ed.tilesChanged(); }
      return;
    }
    // erase: a thing first (one at a time: a pause before the next), else the top tile
    const id = ed.markers.at(w.x, w.y) || ed.renderer.entityAt(w.x, w.y);
    if (id) {
      const now = performance.now();
      if (d.lastThing && now - d.lastThing < ERASE_PAUSE) return;
      d.lastThing = now;
      if (id.startsWith('m:')) ed.markers.remove(id); else this.doc.remove(id);
      ed.selection.delete(id); this.doc.rev++;
      return;
    }
    const t = ed.renderer.tileAt(w.x, w.y, ed.lockLayer || null);
    if (!t || ed.lockedLayers.has(t.layer) || d.done.has(t.layer + '|' + t.x + ',' + t.y)) return;
    const cells = this.eraseCells(t);
    for (const [x, y] of cells) d.done.add(t.layer + '|' + x + ',' + y);
    ed.rules.paint(this.doc.tiles, t.layer, cells, { erase: true });
    ed.tilesChanged();
  }
  // The cells one erase takes at tile t: a big picture's whole copy (wall panels, frescos,
  // the backdrop, a banner), else just the one.
  eraseCells(t) {
    const st = this.doc.tiles, name = st.tileName(st.cell(t.layer, t.x, t.y)), pic = this.picture(familyOf(name));
    const at = pic?.pos.get(bare(name));
    if (!at) return [[t.x, t.y]];
    const ox = t.x - at[0], oy = t.y - at[1], out = [];
    for (const [n, [i, j]] of pic.pos) { const v = st.cell(t.layer, ox + i, oy + j); if (v && bare(st.tileName(v)) === n) out.push([ox + i, oy + j]); }
    return out;
  }
  // A tileset that is one big picture (its only piece, more than a few cells): { pos: tile -> [i, j] }.
  picture(family) {
    this.pictures ||= new Map();
    if (!this.pictures.has(family)) {
      const ps = this.ed.base.art.pieces?.[family.replace(/_$/, '')] || [], p = ps.length === 1 && Math.max(ps[0].w, ps[0].h) > 3 ? ps[0] : null, pos = new Map();
      if (p) for (let i = 0; i < p.cells.length; i += 4) pos.set(p.cells[i + 2], [p.cells[i], p.cells[i + 1]]);
      this.pictures.set(family, p ? { pos } : null);
    }
    return this.pictures.get(family);
  }

  // Where a selected zip mover's track ends, in the world, or null.
  zipEnd(id) {
    const e = !id.startsWith('m:') && this.doc.get(id), item = e && partsOf(this.ed.base, e), z = item && zipOf(item, e);
    if (!z) return null;
    const c = e.cfg || {}, k = c.scale || 1, a = ((c.rot || 0) * Math.PI) / 180;
    const lx = z.end[0] * k * (c.sx || 1) * (c.fx ? -1 : 1), ly = z.end[1] * k * (c.sy || 1) * (c.fy ? -1 : 1);
    return { x: e.x + Math.cos(a) * lx - Math.sin(a) * ly, y: e.y + Math.sin(a) * lx + Math.cos(a) * ly, sx: e.x, sy: e.y };
  }

  arrowCell(w) {
    const g = this.doc.tiles.layer(ARROW_LAYER);
    return [Math.floor((Math.floor(w.x / 32) * 32 + 16 - g.ox) / g.size), Math.floor((Math.floor((w.y - 9) / 32) * 32 + 25 - g.oy) / g.size)];
  }

  // ---- areas: copy, clear, paste ----
  regionCells(r = this.region) {
    const out = [];
    for (const { l } of this.ed.renderer.layerList()) {
      if (this.ed.lockedLayers?.has(l.name)) continue;
      const x0 = Math.ceil((r.x0 - l.ox) / l.size - 0.5), x1 = Math.floor((r.x1 - l.ox) / l.size - 0.5);
      const y0 = Math.ceil((r.y0 - l.oy) / l.size - 0.5), y1 = Math.floor((r.y1 - l.oy) / l.size - 0.5);
      this.doc.tiles.forRect(l.name, x0, y0, x1, y1, (x, y, v) => out.push([l, x, y, v]));
    }
    return out;
  }
  // { tiles: [layer, dx, dy, name, m, extra], things: [entity copies at dx, dy] } from the area's corner.
  copyRegion() {
    const r = this.region, st = this.doc.tiles;
    const tiles = this.regionCells().map(([l, x, y, v]) => [l.name, l.ox + (x + 0.5) * l.size - r.x0, l.oy + (y + 0.5) * l.size - r.y0, st.tileName(v), st.matrix(v), st.extra.get(l.name + '|' + x + ',' + y)]);
    const things = [...this.ed.selection].map((id) => this.doc.get(id)).filter(Boolean).map((e) => { const { id, ...rest } = JSON.parse(JSON.stringify(e)); return { ...rest, x: e.x - r.x0, y: e.y - r.y0 }; });
    return { tiles, things, w: r.x1 - r.x0, h: r.y1 - r.y0 };
  }
  clearRegion() {
    const byLayer = new Map();
    for (const [l, x, y] of this.regionCells()) { if (!byLayer.has(l.name)) byLayer.set(l.name, []); byLayer.get(l.name).push([x, y]); }
    for (const [layer, cells] of byLayer) this.ed.rules.paint(this.doc.tiles, layer, cells, { erase: true });
    for (const id of this.ed.selection) this.doc.remove(id);
  }
  pasteBuffer(buf, ox, oy) {
    const st = this.doc.tiles, made = [];
    for (const [layer, dx, dy, name, m, extra] of buf.tiles) {
      const l = st.layer(layer), x = Math.floor((ox + dx - l.ox) / l.size), y = Math.floor((oy + dy - l.oy) / l.size);
      st.setAt(layer, x, y, name, m, extra);
    }
    for (const t of buf.things) {
      const e = { ...JSON.parse(JSON.stringify(t)), x: ox + t.x, y: oy + t.y };
      // A copy is a thing of its own: its links to others stay with the original.
      if (e.uid) e.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      delete e.tp;
      made.push(this.doc.add(e).id);
    }
    return made;
  }
  pasteAt(w) {
    const buf = this.ed.clip;
    if (!buf) return;
    const ox = Math.round((w.x - buf.w / 2) / 32) * 32, oy = Math.round((w.y - buf.h / 2 - 9) / 32) * 32 + 9;
    let made = [];
    this.doc.change('Paste', () => { made = this.pasteBuffer(buf, ox, oy); });
    this.ed.tilesChanged();
    this.region = { x0: ox, y0: oy, x1: ox + buf.w, y1: oy + buf.h };
    this.ed.select(made);
  }

  // The boxed part moved by (dx, dy), on the tile grid: its tiles and the things in it.
  moveRegion(dx, dy) {
    const r = this.region;
    if (!r || (!dx && !dy)) return;
    const buf = this.copyRegion(), marks = [...this.ed.selection].filter((id) => id.startsWith('m:'));
    let made = [];
    this.doc.change('Move area', () => {
      this.clearRegion();
      made = this.pasteBuffer(buf, r.x0 + dx, r.y0 + dy);
      // Course gates, resets and screens in it go along.
      for (const id of marks) { const p = this.ed.markers.pos(id); if (p) this.ed.markers.set(id, { x: p.x + dx, y: p.y + dy }); }
    });
    this.region = { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
    this.ed.tilesChanged();
    this.ed.select([...made, ...marks]);
  }
  // The selected things (no tiles) as a clipboard, from their corner.
  copySelection() {
    const ents = [...this.ed.selection].map((id) => !id.startsWith('m:') && this.doc.get(id)).filter(Boolean);
    if (!ents.length) return null;
    const x0 = Math.min(...ents.map((e) => e.x)), y0 = Math.min(...ents.map((e) => e.y));
    const things = ents.map((e) => { const { id, ...rest } = JSON.parse(JSON.stringify(e)); return { ...rest, x: e.x - x0, y: e.y - y0 }; });
    return { tiles: [], things, w: Math.max(...ents.map((e) => e.x)) - x0, h: Math.max(...ents.map((e) => e.y)) - y0 };
  }
  copy(cut = false) {
    const ed = this.ed, buf = this.region ? this.copyRegion() : this.copySelection();
    if (!buf) return false;
    ed.clip = buf;
    if (cut) this.erase();
    ed.flash(cut ? 'Cut' : 'Copied');
    return true;
  }
  // Delete: the boxed part (tiles and things), else the selected things.
  erase() {
    const ed = this.ed;
    if (this.region) { this.doc.change('Delete area', () => this.clearRegion()); ed.tilesChanged(); this.region = null; ed.select([]); }
    else ed.deleteSelection();
  }
  // Moves the selection (or the boxed part, a tile at a time) by (dx, dy).
  nudge(dx, dy) {
    const ed = this.ed;
    if (this.region) { const s = (v) => (v ? Math.sign(v) * Math.max(32, Math.round(Math.abs(v) / 32) * 32) : 0); this.moveRegion(s(dx), s(dy)); return; }
    if (!ed.selection.size) return;
    this.doc.change('Move', () => {
      for (const id of ed.selection) {
        const p = ed.markers.pos(id);
        if (!p) continue;
        if (id.startsWith('m:')) ed.markers.set(id, { x: p.x + dx, y: p.y + dy });
        else { this.doc.touch(p); p.x += dx; p.y += dy; }
      }
    });
  }
  // Each selected thing changed by fn (things that can't be skipped).
  transform(label, fn) {
    const ed = this.ed;
    if (!ed.selection.size) return;
    this.doc.change(label, () => {
      for (const id of ed.selection) {
        const en = !id.startsWith('m:') && this.doc.get(id);
        if (!en || !['unit', 'object', 'sprite', 'text', 'spike'].includes(en.kind)) continue;
        this.doc.touch(en);
        fn(en, en.kind === 'unit' || en.kind === 'object' ? (en.cfg = { ...(en.cfg || {}) }) : null);
      }
    });
  }
  // Turned clockwise by deg.
  turn(deg) {
    const norm = (v) => ((v % 360) + 360) % 360;
    this.transform('Turn', (en, c) => {
      if (c) { const r = norm((c.rot || 0) - deg); if (r) c.rot = r; else delete c.rot; }
      else if (en.kind === 'spike' && deg % 90 === 0) en.q = ((((en.q || 0) + deg / 90) % 4) + 4) % 4;
      else en.r = norm((en.r || 0) - deg);
    });
  }
  flip(axis) {
    const f = axis === 'x' ? 'fx' : 'fy';
    this.transform('Flip', (en, c) => { const o = c || (en.kind === 'text' ? null : en); if (!o) return; if (o[f]) delete o[f]; else o[f] = true; });
  }
  // Size times k (0: back to its own size).
  resize(k) {
    this.transform('Resize', (en, c) => {
      const o = c || en, f = en.kind === 'spike' ? 's' : 'scale', v = k ? Math.round((o[f] || 1) * k * 1000) / 1000 : 1;
      if (en.kind === 'text') return;
      if (Math.abs(v - 1) < 1e-6) delete o[f]; else o[f] = Math.max(0.05, v);
    });
  }

  // ---- keys ----
  key(e) {
    const ed = this.ed, k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); const l = e.shiftKey ? this.doc.redo() : this.doc.undo(); ed.afterHistory(l, e.shiftKey ? 'Redid' : 'Undid'); return true; }
    if (mod && k === 'y') { e.preventDefault(); ed.afterHistory(this.doc.redo(), 'Redid'); return true; }
    if (mod && k === 'd') { e.preventDefault(); ed.duplicate(); return true; }
    if (mod && (k === 'c' || k === 'x')) { if (this.copy(k === 'x')) { e.preventDefault(); return true; } return false; }
    if (mod && k === 'v' && ed.clip) { e.preventDefault(); this.setTool('paste'); ed.flash('Click where it goes (Esc to stop)'); return true; }
    if (mod) return false;
    if (k === 'v' || k === 'q') { this.setTool('select'); return true; }
    if (k === 'b') { ed.panels.mode('build'); return true; }
    if (k === 'e') { this.setTool('erase'); return true; }
    if (k === 'm') { this.setTool('select'); return true; }
    if (k === 'delete' || k === 'backspace') { this.erase(); return true; }
    if (k === 'r' && ed.selection.size) { this.turn(e.shiftKey ? -90 : 90); return true; }
    if (k === 'f' && ed.selection.size) { this.flip(e.shiftKey ? 'y' : 'x'); return true; }
    if (k.startsWith('arrow') && (ed.selection.size || this.region)) {
      e.preventDefault();
      const step = e.altKey ? 1 : e.shiftKey ? 32 : ed.snap || 1, dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy = k === 'arrowup' ? step : k === 'arrowdown' ? -step : 0;
      this.nudge(dx, dy);
      return true;
    }
    if (k === ']' || k === '[') { ed.restack(k === ']' ? (e.shiftKey ? 'front' : 'up') : (e.shiftKey ? 'back' : 'down')); return true; }
    return false;
  }

  // ---- drawn over the map (CSS pixels on the ui canvas) ----
  overlay(g) {
    const ed = this.ed, S = (x, y) => ed.toScreen(x, y);
    ed.markers.draw(g);
    g.save();
    g.lineWidth = 1.5;
    const marks = new Map(ed.markers.list().map((m) => [m.id, m]));
    for (const id of ed.selection) {
      const m = marks.get(id);
      const b = m ? [m.x + m.box.dx - m.box.w / 2, m.y + m.box.dy - m.box.h / 2, m.x + m.box.dx + m.box.w / 2, m.y + m.box.dy + m.box.h / 2]
        : ed.renderer.boundsOf(id) || (() => { const en = this.doc.get(id); return en ? [en.x - 16, en.y - 16, en.x + 16, en.y + 16] : null; })();
      if (!b) continue;
      const a = S(b[0], b[3]), c = S(b[2], b[1]);
      g.strokeStyle = '#41f88d';
      g.setLineDash([5, 4]);
      g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
    }
    g.setLineDash([]);
    for (const id of ed.selection) {
      const z = this.zipEnd(id);
      if (!z) continue;
      const a = S(z.sx, z.sy), b = S(z.x, z.y);
      g.strokeStyle = 'rgba(249, 255, 228, 0.6)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.setLineDash([]);
      for (const [p, col] of [[a, '#41f88d'], [b, '#c63ed8']]) { g.beginPath(); g.arc(p.x, p.y, 6, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.strokeStyle = '#111'; g.stroke(); }
    }
    const d = this.drag;
    if (d?.box) {
      const a = S(Math.min(d.from.x, d.to.x), Math.max(d.from.y, d.to.y)), c = S(Math.max(d.from.x, d.to.x), Math.min(d.from.y, d.to.y));
      g.fillStyle = 'rgba(65, 248, 141, 0.08)'; g.strokeStyle = 'rgba(65, 248, 141, 0.7)';
      g.fillRect(a.x, a.y, c.x - a.x, c.y - a.y); g.strokeRect(a.x + 0.5, a.y + 0.5, c.x - a.x, c.y - a.y);
    }
    const r = this.region;
    if (r && (this.tool === 'select' || this.tool === 'paste')) {
      const off = d?.regionMove ? [d.dx, d.dy] : [0, 0], a = S(r.x0 + off[0], r.y1 + off[1]), c = S(r.x1 + off[0], r.y0 + off[1]);
      g.strokeStyle = '#7ad7f0'; g.fillStyle = 'rgba(122, 215, 240, 0.07)'; g.setLineDash([6, 4]);
      g.fillRect(a.x, a.y, c.x - a.x, c.y - a.y); g.strokeRect(a.x + 0.5, a.y + 0.5, c.x - a.x, c.y - a.y); g.setLineDash([]);
    }
    // Ctrl: the lines it's lined up on.
    for (const gd of this.guides || []) {
      const a = gd.x != null ? S(gd.x, gd.from) : S(gd.from, gd.y), c = gd.x != null ? S(gd.x, gd.to) : S(gd.to, gd.y);
      g.strokeStyle = '#c63ed8'; g.lineWidth = 1.5; g.setLineDash([6, 4]);
      g.beginPath(); g.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5); g.lineTo(Math.round(c.x) + 0.5, Math.round(c.y) + 0.5); g.stroke();
      g.setLineDash([]);
    }
    if (this.tool === 'paste' && this.hover && ed.clip) {
      const b = ed.clip, ox = Math.round((this.hover.x - b.w / 2) / 32) * 32, oy = Math.round((this.hover.y - b.h / 2 - 9) / 32) * 32 + 9;
      const a = S(ox, oy + b.h), c = S(ox + b.w, oy);
      g.strokeStyle = '#41f88d'; g.setLineDash([6, 4]); g.strokeRect(a.x + 0.5, a.y + 0.5, c.x - a.x, c.y - a.y); g.setLineDash([]);
    }
    if (this.hover && (this.tool === 'brush' || this.tool === 'erase') && !d?.pan) {
      const b = ed.brush, t = this.tool === 'erase' ? ed.renderer.tileAt(this.hover.x, this.hover.y, ed.lockLayer || null) : null, layer = this.tool === 'brush' ? b?.layer : t?.layer;
      if (layer) {
        const li = layerInfo(ed.base, layer);
        let x = Math.floor((this.hover.x - li.ox) / li.size), y = Math.floor((this.hover.y - li.oy) / li.size), w = this.tool === 'brush' ? b.size : 1, h = w;
        if (t) { const cs = this.eraseCells(t); x = Math.min(...cs.map((q) => q[0])); y = Math.min(...cs.map((q) => q[1])); w = Math.max(...cs.map((q) => q[0])) - x + 1; h = Math.max(...cs.map((q) => q[1])) - y + 1; }
        const a = S(li.ox + x * li.size, li.oy + (y + h) * li.size), c = S(li.ox + (x + w) * li.size, li.oy + y * li.size);
        g.strokeStyle = this.tool === 'brush' ? 'rgba(65, 248, 141, 0.9)' : 'rgba(255, 107, 107, 0.9)';
        g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
      }
    } else if (this.hover && this.tool === 'place' && !d && ed.place) {
      // What's about to go down: its outline where it'll land.
      const at = ed.snapCell(this.hover), p = ed.place, r = p.kind === 'trigger' ? 128 : p.kind === 'vine' ? 16 : 24;
      const b = ed.renderer.ghostBounds || [at.x - r, at.y - r, at.x + r, at.y + r];
      const a = S(b[0], b[3]), c = S(b[2], b[1]), x = Math.round(a.x) - 2.5, y = Math.round(a.y) - 2.5, w = Math.round(c.x - a.x) + 5, h = Math.round(c.y - a.y) + 5;
      g.fillStyle = 'rgba(65, 248, 141, 0.1)'; g.fillRect(x, y, w, h);
      g.lineWidth = 4; g.strokeStyle = 'rgba(0, 0, 0, 0.55)'; g.strokeRect(x, y, w, h);
      g.lineWidth = 2; g.strokeStyle = '#41f88d'; g.strokeRect(x, y, w, h);
      g.lineWidth = 1;
    } else if (this.hover && this.tool === 'select' && !d) {
      const id = ed.renderer.entityAt(this.hover.x, this.hover.y);
      const b = id && !ed.selection.has(id) && ed.renderer.boundsOf(id);
      if (b) {
        const a = S(b[0], b[3]), c = S(b[2], b[1]);
        g.strokeStyle = 'rgba(249, 255, 228, 0.45)';
        g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
      }
    }
    g.restore();
  }
}
