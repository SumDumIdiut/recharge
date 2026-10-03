import { TileStore } from '../tilestore.js';
import { layerInfo } from './base.js';

// Level things maps leave out: the statues' prestige text.
const DROPPED_UNIT = /\/StatuePrestigeText$/;
export const DEFAULT_PLAYER = { dashes: 1, airJumps: 1, wallJump: true, blockSwap: false, omniDash: false, zipMovers: true, refreshers: true, teleporters: true, cash: 0 };
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const newUid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);

// The map being made. Tiles: every tile by the game's own tilemap (TileStore). Entities:
// every thing in it, one list in creation order, each { id, kind, x, y, ...its kind's fields }.
//   unit    a level thing (lv: its unit id), with cfg / dz / group / course / links
//   object  a palette thing (cat, i, n), cfg likewise
//   spike   a spike off the grid (c colour, q turn)
//   text    sign text (t, w, h, c, r)
//   sprite  a game sprite or your image (game | image, scale)
//   trigger a trigger zone (kind's own fields under t)
//   spawn   an extra spawn point
//   arrow   a guide arrow (cells)
// Draw order: each thing's parts at their own order plus dz (the same shift in the game).
export class Doc {
  constructor(base) {
    this.base = base;
    this.meta = { name: '', description: '', uid: newUid(), levelState: null, player: { ...DEFAULT_PLAYER }, ownProgress: false, music: undefined, background: undefined, spawn: null, hiddenGroups: [], autosave: 0, savedId: null };
    this.tiles = this.newTiles();
    this.entities = [];
    this.courses = [];
    this.index = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.rev = 0;
    this.listeners = new Set();
    this.seq = 0;
  }

  get state() { return this.meta.levelState || 'start'; }
  newTiles() {
    const t = new TileStore((name) => layerInfo(this.base, name), () => [1, 0, 0, 1], this.base.mats || [[1, 0, 0, 1]]);
    t.journal = [];
    return t;
  }
  newId(prefix = 'e') { return prefix + (++this.seq).toString(36) + Math.random().toString(36).slice(2, 5); }
  get(id) { return this.index.get(id); }
  reindex() { this.index = new Map(this.entities.map((e) => [e.id, e])); }

  // ---- changes: begin, touch what you'll change, change it, commit ----
  begin(label) {
    if (this.tx) return this.tx;
    this.tx = { label, mark: this.tiles.journal.length, before: new Map(), order: this.entities.map((e) => e.id) };
    return this.tx;
  }
  // Call before changing an entity (or with an id about to be added).
  touch(idOrEntity) {
    const id = typeof idOrEntity === 'string' ? idOrEntity : idOrEntity.id;
    if (!this.tx || this.tx.before.has(id)) return;
    this.tx.before.set(id, clone(this.index.get(id)) ?? null);
  }
  add(e) {
    if (!e.id) e.id = this.newId(e.kind?.[0] || 'e');
    this.touch(e.id);
    this.entities.push(e);
    this.index.set(e.id, e);
    return e;
  }
  remove(id) {
    const e = this.index.get(id);
    if (!e) return;
    this.touch(id);
    this.entities.splice(this.entities.indexOf(e), 1);
    this.index.delete(id);
  }
  touchMeta() { if (this.tx && !this.tx.meta) this.tx.meta = { meta: clone(this.meta), courses: clone(this.courses) }; }

  commit() {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    const tiles = this.tiles.journal.splice(tx.mark);
    const ents = [...tx.before].map(([id, before]) => [id, before, clone(this.index.get(id)) ?? null]).filter(([, b, a]) => JSON.stringify(b) !== JSON.stringify(a));
    const meta = tx.meta && { before: tx.meta, after: { meta: clone(this.meta), courses: clone(this.courses) } };
    if (!tiles.length && !ents.length && !meta) return;
    this.undoStack.push({ label: tx.label, tiles, ents, meta, order: tx.order });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.changed({ tiles: tiles.length > 0, ids: ents.map(([id]) => id), meta: !!meta });
  }
  // Runs fn as one undoable step.
  change(label, fn) {
    const own = !this.tx;
    this.begin(label);
    try { fn(); } finally { if (own) this.commit(); }
  }

  undo() { return this.step(this.undoStack, this.redoStack, 'before'); }
  redo() { return this.step(this.redoStack, this.undoStack, 'after'); }
  step(from, to, side) {
    const s = from.pop();
    if (!s) return null;
    const tiles = this.tiles.revert(s.tiles);
    for (const [id, before, after] of s.ents) this.put(id, side === 'before' ? before : after);
    if (side === 'before' && s.order) this.reorder(s.order);
    if (s.meta) { const v = s.meta[side]; this.meta = clone(v.meta); this.courses = clone(v.courses); }
    to.push({ ...s, tiles });
    this.changed({ tiles: s.tiles.length > 0, ids: s.ents.map(([id]) => id), meta: !!s.meta });
    return s.label;
  }
  put(id, v) {
    const e = this.index.get(id);
    if (!v) { if (e) { this.entities.splice(this.entities.indexOf(e), 1); this.index.delete(id); } return; }
    const fresh = clone(v);
    if (e) { this.entities[this.entities.indexOf(e)] = fresh; } else this.entities.push(fresh);
    this.index.set(id, fresh);
  }
  // Entities back in the order they had (an undone delete returns to its place).
  reorder(order) {
    const pos = new Map(order.map((id, i) => [id, i]));
    this.entities.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  }

  changed(what) {
    this.rev++;
    for (const fn of this.listeners) fn(what);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---- whole documents ----
  clear() {
    this.tiles = this.newTiles();
    this.entities = [];
    this.courses = [];
    this.index.clear();
    this.undoStack = [];
    this.redoStack = [];
  }

  // Back from a saved draft (persist.js readDraft).
  load(saved) {
    this.clear();
    Object.assign(this.meta, saved.doc.meta);
    this.entities = saved.doc.entities || [];
    this.courses = saved.doc.courses || [];
    this.cellGroups = saved.doc.cellGroups || {};
    if (saved.meta) this.tiles.load(saved.meta, saved.chunks);
    this.tiles.journal = [];
    this.reindex();
    this.seq = this.entities.length;
    this.changed({ tiles: true, all: true, meta: true });
  }

  // The whole level as the map's own: its tiles, and each of its things where it is.
  importLevel(state = 'start') {
    const b = this.base;
    this.clear();
    this.meta.levelState = state;
    this.tiles.journal = null;
    for (const l of b.art.levelTiles || []) if (l.state === 'always' || l.state === state) this.tiles.addRuns(l.name, l.names, l.runs, b.mats);
    this.tiles.journal = [];
    for (const u of b.scene.units || []) {
      if (!u || (u.state !== 'always' && u.state !== state) || DROPPED_UNIT.test(u.path)) continue;
      const e = { id: 'u' + u.id, kind: 'unit', lv: u.id, x: u.x, y: u.y };
      if (u.tele) { e.uid = 'lv' + u.id; e.tp = {}; for (const [dir, t] of Object.entries(u.tele)) e.tp[dir] = 'p:lv' + t; }
      this.entities.push(e);
    }
    this.courses = (b.courses || []).filter((c) => c.end).map((c) => ({
      id: 'L' + c.n, ...(c.copy ? { level: c.n } : {}),
      start: { x: c.start.x, y: c.start.y }, end: { x: c.end.x, y: c.end.y },
      ...(c.screen ? { screen: { x: c.screen[0], y: c.screen[1] } } : {}),
      resets: (c.resets || []).map((r) => ({ x: r.x, y: r.y, ...(r.box ? { box: r.box } : {}) })),
      reward: { currency: 'Cash', amount: 0 },
    }));
    const ids = new Set(this.courses.map((c) => c.id));
    const LOCAL_BOX = /\/localUpgrades\//;
    for (const e of this.entities) {
      const u = b.scene.units[e.lv], cid = u?.course && 'L' + u.course;
      if (cid && ids.has(cid) && (u.name === 'Course checkpoint' || LOCAL_BOX.test(u.path + '/'))) e.course = cid;
    }
    // The level's area doors as triggers: walking in loads that area (its background, lights, music).
    const track = (z) => (z.zone === 1 ? (state === 'overgrown' ? 'Overgrowth' : 'Area1Track1') : z.music);
    for (const z of b.scene.zoneTriggers || []) {
      if (z.state !== 'always' && z.state !== state) continue;
      const music = track(z);
      this.entities.push({ id: this.newId('g'), kind: 'trigger', t: 'media', x: z.x, y: z.y, w: z.w, h: z.h, zone: z.zone, background: 'level', ...(music && music !== 'none' ? { music: 'game:' + music } : {}) });
    }
    this.reindex();
    this.changed({ tiles: true, all: true, meta: true });
  }
}
