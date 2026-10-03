import { loadBase } from './base.js';
import { Doc } from './doc.js';
import { GL } from './render/gl.js';
import { WorldRenderer, partsOf } from './render/world.js';
import { TileRules } from './rules.js';
import { Tools } from './tools.js';
import { Panels } from './ui.js';
import { readDraft, Saver } from './persist.js';
import { fromMap, canConvert } from './convert.js';
import { Markers } from './markers.js';
import { MapFiles, fetchInstalledAssets } from './io.js';
import { redrawArrow, relayArrow } from './arrows.js';
import { Minimap, KEYS } from './minimap.js';

const MIN_SCALE = 0.01, MAX_SCALE = 6;
// Draw orders of the level's tile layers around which "behind" picks go.
const BLOCKS_ORDER = 4, LOWEST_TILES = -15;

let ed = null;

// Amplifier, the map editor, filling the app's window (the main menu opens it; leaving it shows
// the app again).
export async function openAmplifier() {
  if (ed) { ed.open(); return ed; }
  ed = new Editor();
  await ed.start();
  return ed;
}

class Editor {
  constructor() {
    this.cam = { x: 2500, y: 0, scale: 0.5 };
    this.selection = new Set();
    this.brush = null;
    this.snap = 16;
    try { const v = localStorage.getItem('mapEditorSnap'); if (v != null) this.snap = Number(v) || 0; } catch {}
    this.lockedLayers = new Set();
    this.handlers = new Map();
    this.root = document.createElement('div');
    this.root.className = 'mm2';
    this.root.innerHTML = `
      <canvas class="mm2-gl"></canvas>
      <canvas class="mm2-ui"></canvas>
      <div class="mm2-bar">
        <button class="gd-round" data-act="close" title="Back to the app (Esc)">◀</button>
        <button class="gd-round" data-act="undo" title="Undo (Ctrl+Z)"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
        <button class="gd-round" data-act="redo" title="Redo (Ctrl+Y)"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
        <button class="gd-round gd-pink" data-act="sim" title="Play: zip movers run, credits play (T)">▶</button>
      </div>
      <div class="mm2-bar mm2-right">
        <button class="gd-btn" data-act="layers" title="Layers">Layers</button>
        <button class="gd-btn" data-act="mapmenu" title="Map: save, test in game, open, settings">Map</button>
        <button class="gd-btn gd-green" data-act="save" title="Save to your maps (Ctrl+S)">Save</button>
      </div>
      <div class="mm2-status mm2-panel"></div>
      <div class="mm2-loading"><div class="mm2-loading-bar"><i></i></div><span>Loading…</span></div>`;
    this.gl = this.root.querySelector('.mm2-gl');
    this.ui = this.root.querySelector('.mm2-ui');
    this.status = this.root.querySelector('.mm2-status');
    this.dirty = true;
    this.frameMs = 0;
  }

  on(ev, fn) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev).add(fn); }
  emit(ev) { for (const fn of this.handlers.get(ev) || []) fn(); }

  async start() {
    if (!document.querySelector('link[data-mm2]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = new URL('./v2.css', import.meta.url).href; link.dataset.mm2 = '';
      document.head.appendChild(link);
    }
    document.body.appendChild(this.root);
    this.open();
    if (!GL.supported()) { this.fail('Amplifier needs WebGL2, which this window doesn\'t have.'); return; }
    let loaded;
    try { loaded = await loadBase((f, label) => this.progress(f, label)); } catch (e) { this.fail('Couldn\'t load the level: ' + e.message); return; }
    this.base = loaded.data;
    this.images = loaded.images;
    this.glx = new GL(this.gl);
    this.renderer = new WorldRenderer(this.glx, this.base, this.images);
    this.renderer.onLoad = () => { this.doc.rev++; this.dirty = true; };
    this.rules = new TileRules(this.base);
    this.doc = new Doc(this.base);
    this.progress(1, 'Opening your draft');
    await new Promise((r) => setTimeout(r));
    let saved = null;
    try { saved = await readDraft(); } catch (e) { console.warn('no v2 draft', e); }
    if (saved) this.doc.load(saved); else this.doc.importLevel('start');
    this.attachDoc();
    this.markers = new Markers(this);
    this.files = new MapFiles(this);
    this.tools = new Tools(this);
    this.panels = new Panels(this);
    this.minimap = new Minimap(this);
    this.root.insertAdjacentHTML('beforeend', `<div class="mm2-keys mm2-panel" hidden><div class="mm2-title2">Keys<span>K or ? to close</span></div>${KEYS.map(([k, v]) => `<div class="mm2-key"><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>`);
    this.root.querySelector('.mm2-loading').hidden = true;
    this.bind();
    this.resize();
    this.home();
    this.loop();
    globalThis.__mm2 = this;
  }

  // A (new) document in the editor: drawn, saved, its changes followed.
  attachDoc() {
    // Guide arrows from before the arrows were laid as the level lays them.
    if ((this.doc.meta.arrows || 0) < 2) {
      const j = this.doc.tiles.journal;
      this.doc.tiles.journal = null;
      for (const e of this.doc.entities) if (e.kind === 'arrow') relayArrow(this.doc.tiles, e.cells);
      this.doc.tiles.journal = j;
      this.doc.meta.arrows = 2;
    }
    this.renderer.setDoc(this.doc);
    if (!this.saver || this.saver.doc !== this.doc) this.saver = new Saver(this.doc);
    this.saver.replaced();
    this.doc.onChange((what) => {
      if (what.tiles) this.tilesChanged();
      for (const id of [...this.selection]) if (!this.markers.pos(id)) this.selection.delete(id);
      this.dirty = true;
      this.emit('doc');
    });
  }
  // Tiles changed (paint, erase, undo): their chunks are drawn again.
  tilesChanged() {
    this.renderer.tilesChanged(this.doc.tiles.takeUnsent().map(([k]) => k));
    this.dirty = true;
  }
  afterHistory(label, verb) {
    this.tilesChanged();
    this.flash(label ? `${verb} ${label.toLowerCase()}` : verb === 'Undid' ? 'Nothing to undo' : 'Nothing to redo');
  }

  // ---- the selection and what's done to it ----
  select(ids) { this.selection = new Set(ids); this.dirty = true; this.emit('selection'); }
  deleteSelection() {
    if (!this.selection.size) return;
    const n = this.selection.size;
    this.doc.change('Delete', () => {
      // Course markers last, resets from the highest index down so the rest keep theirs.
      const ids = [...this.selection].sort((a, b) => (a.startsWith('m:') - b.startsWith('m:')) || (Number(b.split(':')[3]) || 0) - (Number(a.split(':')[3]) || 0));
      for (const id of ids) {
        if (id.startsWith('m:')) { this.markers.remove(id); continue; }
        const e = this.doc.get(id);
        if (e?.kind === 'arrow') redrawArrow(this.doc.tiles, e.cells, null);
        this.doc.remove(id);
      }
    });
    this.select([]);
    this.flash(`Deleted ${n} thing${n === 1 ? '' : 's'}`);
  }
  duplicate() {
    if (!this.selection.size) return;
    const made = [];
    this.doc.change('Duplicate', () => {
      for (const id of this.selection) {
        const e = !id.startsWith('m:') && this.doc.get(id);
        if (!e || e.kind === 'arrow') continue;
        const { id: _, ...rest } = JSON.parse(JSON.stringify(e));
        // A copy is a thing of its own: links to other things stay with the original.
        delete rest.uid; delete rest.tp;
        made.push(this.doc.add({ ...rest, x: e.x + 32, y: e.y - 32 }).id);
      }
    });
    this.select(made);
  }
  // Draw order: the parts keep their own order among themselves, shifted together (dz).
  partOrders(e) {
    const item = partsOf(this.base, e);
    const os = (item?.parts || []).filter((p) => !p.is || p.is === 'group').map((p) => p.o);
    return os.length ? [Math.min(...os), Math.max(...os)] : [0, 0];
  }
  restack(how) {
    // A course screen's order is its course's (it has one part, at order 0).
    const ents = [...this.selection].map((id) => {
      if (!id.startsWith('m:')) return this.doc.get(id);
      const [, cid, which] = id.split(':');
      return which === 'screen' ? this.doc.courses.find((c) => c.id === cid) : null;
    }).filter(Boolean);
    if (!ents.length) return;
    const all = this.doc.entities.map((e) => { const [lo, hi] = this.partOrders(e); return [lo + (e.dz || 0), hi + (e.dz || 0)]; });
    const top = Math.max(...all.map((r) => r[1]), 8), bottom = Math.min(...all.map((r) => r[0]), LOWEST_TILES);
    this.doc.change('Draw order', () => {
      for (const e of ents) {
        const screen = !e.kind, [lo, hi] = screen ? [0, 0] : this.partOrders(e), dz = e.dz || 0;
        if (screen) this.doc.touchMeta(); else this.doc.touch(e);
        let next = dz;
        if (how === 'up') next = dz + 1;
        else if (how === 'down') next = dz - 1;
        else if (how === 'front') next = top + 1 - hi;
        else if (how === 'back') next = bottom - 1 - lo;
        else if (how === 'behindBlocks') next = BLOCKS_ORDER - 1 - hi;
        else if (how === 'behindWalls') next = LOWEST_TILES - 1 - hi;
        if (next) e.dz = next; else delete e.dz;
      }
    });
  }

  // Simulate: zip movers run and the credits play, as in the game.
  toggleSimulate() {
    const r = this.renderer;
    r.simulate = !r.simulate;
    r.simStart = performance.now() / 1000;
    this.doc.rev++;
    this.dirty = true;
    this.root.querySelector('[data-act="sim"]')?.classList.toggle('on', r.simulate);
    this.flash(r.simulate ? 'Simulating: zip movers run, credits play (T)' : 'Simulation off');
  }

  // ---- placing from the palette ----
  // A cell's centre (the level's grid: 32 units, 9 up).
  // Where a thing placed at w goes: on the snap grid (tile centres for a whole tile, the tile grid's
  // lines for less), or right at w with snap off.
  snapCell(w) {
    const S = this.snap, o = S >= 32 ? 16 : 0;
    if (!S) return { x: Math.round(w.x), y: Math.round(w.y) };
    return { x: Math.round((w.x - o) / S) * S + o, y: Math.round((w.y - 9 - o) / S) * S + 9 + o };
  }
  placeAt(w, exact = false) {
    const p = this.place, d = this.doc, at = exact ? { x: w.x, y: w.y } : this.snapCell(w);
    if (!p) return;
    const nearest = () => d.courses.filter((c) => c.start).sort((a, b) => Math.hypot(a.start.x - at.x, a.start.y - at.y) - Math.hypot(b.start.x - at.x, b.start.y - at.y))[0];
    let made = null;
    d.change('Place', () => {
      if (p.kind === 'object') {
        const item = this.base.catalog[p.cat][p.i];
        const e = { kind: 'object', cat: p.cat, i: p.i, n: item.name, x: at.x, y: at.y };
        if (item.upgradeBox || item.name === 'Teleporter') e.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (item.name === 'Course checkpoint' && this.activeCourse) e.course = this.activeCourse;
        made = d.add(e).id;
      } else if (p.kind === 'unit') made = d.add({ kind: 'unit', lv: p.lv, x: at.x, y: at.y }).id;
      else if (p.kind === 'sprite') made = d.add({ kind: 'sprite', ...(p.game ? { game: p.game } : { image: p.image }), x: w.x, y: w.y, scale: 1 }).id;
      else if (p.kind === 'fspike') made = d.add({ kind: 'spike', c: p.c, q: 0, x: at.x, y: at.y }).id;
      else if (p.kind === 'text') made = d.add({ kind: 'text', x: at.x, y: at.y, t: 'Text', w: 280, h: 56 }).id;
      else if (p.kind === 'spawn') made = d.add({ kind: 'spawn', x: at.x, y: at.y + 24 }).id;
      else if (p.kind === 'trigger') {
        const t = { kind: 'trigger', t: p.t, x: at.x, y: at.y, w: 256, h: 256 };
        if (p.t === 'move') Object.assign(t, { dx: 0, dy: 256, time: 1 });
        if (p.t === 'teleport' || p.t === 'respawn') Object.assign(t, { tx: 512, ty: 0 });
        if (p.t === 'zoom') t.size = 1.5;
        if (p.t === 'message') Object.assign(t, { text: 'Hello!', seconds: 3 });
        if (['show', 'hide', 'toggle', 'move'].includes(p.t)) t.group = '1';
        made = d.add(t).id;
      } else if (p.kind === 'vine') {
        const li = this.doc.tiles.layer(p.layer), x = Math.floor((at.x - li.ox) / li.size), y = Math.floor((at.y - li.oy) / li.size);
        d.tiles.setAt(p.layer, x, y, p.tile, [1, 0, 0, 1]);
      } else {
        d.touchMeta();
        if (p.kind === 'spawnMain') { d.meta.spawn = { x: at.x, y: at.y + 24 }; made = 'm:spawn'; }
        else if (p.kind === 'start') {
          const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), start: { x: at.x, y: at.y + 109 }, end: null, reward: { currency: 'Cash', amount: 0 } };
          d.courses.push(c); this.activeCourse = c.id; made = `m:${c.id}:start`;
        } else {
          const c = d.courses.find((x) => x.id === this.activeCourse) || nearest();
          if (!c) { this.flash('Place a start gate first: an end, reset or screen belongs to a course.'); return; }
          if (p.kind === 'end') { c.end = { x: at.x, y: at.y + 16 }; made = `m:${c.id}:end`; }
          else if (p.kind === 'reset') { c.resets = [...(c.resets || []), { x: at.x, y: at.y }]; made = `m:${c.id}:reset:${c.resets.length - 1}`; }
        }
      }
    });
    if (p.kind === 'vine') this.tilesChanged();
    if (made) this.select([made]);
  }

  // ---- whole maps ----
  startFromLevel(state) {
    if (!confirm('Start over from the whole level? Your current map is replaced (you can still undo while the editor is open).')) return;
    this.doc.importLevel(state);
    this.select([]);
    this.saver.replaced();
    this.tilesChanged();
    this.renderer.setDoc(null); this.renderer.setDoc(this.doc);
    this.flash('The whole level is your map now');
  }
  async installedMaps() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return [];
    try { return (await invoke('list_maps')).filter((m) => m.id !== 'map-maker-test'); } catch { return []; }
  }
  async openInstalled(id) {
    const invoke = window.__TAURI__?.core?.invoke;
    try {
      const map = JSON.parse(await invoke('read_map', { id }));
      if (await this.openMapJson(map, id)) this.flash(`Opened ${map.name || id}`);
    } catch (e) { this.flash('Couldn\'t open that map: ' + e); }
  }
  // A map file into the editor (replacing what's open); savedId: the installed map it is.
  async openMapJson(map, savedId = null) {
    const why = canConvert(map);
    if (why) { this.flash(why); return false; }
    fromMap(this.doc, map, savedId);
    this.select([]);
    this.saver.replaced();
    this.renderer.setDoc(null); this.renderer.setDoc(this.doc);
    this.files.lastSaved = null;
    this.home();
    if (savedId) fetchInstalledAssets(this.doc, savedId).then(() => { this.renderer.extraTex?.clear(); this.doc.rev++; this.dirty = true; });
    return true;
  }

  // ---- window ----
  open() { this.root.hidden = false; document.documentElement.classList.add('mm2-open'); this.dirty = true; }
  close() {
    this.root.hidden = true;
    document.documentElement.classList.remove('mm2-open');
  }
  progress(f, label) {
    const el = this.root.querySelector('.mm2-loading');
    el.querySelector('i').style.width = Math.round(f * 100) + '%';
    el.querySelector('span').textContent = label;
  }
  fail(msg) { this.progress(0, msg); this.root.querySelector('.mm2-loading').classList.add('mm2-error'); }
  flash(msg) { this.panels?.flash(msg); }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.gl, this.ui]) { c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr); }
    this.dirty = true;
  }
  // The view on the map's spawn, else its first course, else where its tiles are.
  home() {
    const d = this.doc, p = d.meta.spawn || d.courses[0]?.start;
    if (p) { this.cam.x = p.x; this.cam.y = p.y; return; }
    const b = d.tiles.bounds();
    if (b) { this.cam.x = (b[0] + b[2]) / 2; this.cam.y = (b[1] + b[3]) / 2; }
  }

  // Screen (CSS px) <-> world.
  toWorld(sx, sy) { return { x: this.cam.x + (sx - this.gl.clientWidth / 2) / this.cam.scale, y: this.cam.y - (sy - this.gl.clientHeight / 2) / this.cam.scale }; }
  toScreen(wx, wy) { return { x: (wx - this.cam.x) * this.cam.scale + this.gl.clientWidth / 2, y: this.gl.clientHeight / 2 - (wy - this.cam.y) * this.cam.scale }; }

  bind() {
    const c = this.ui;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const at = this.toWorld(e.offsetX, e.offsetY);
      this.cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.cam.scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))));
      const now = this.toWorld(e.offsetX, e.offsetY);
      this.cam.x += at.x - now.x; this.cam.y += at.y - now.y;
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); this.tools.down(e, this.toWorld(e.offsetX, e.offsetY)); this.dirty = true; });
    c.addEventListener('pointermove', (e) => { this.hover = this.toWorld(e.offsetX, e.offsetY); this.tools.move(e, this.hover); });
    c.addEventListener('pointerup', () => this.tools.up());
    c.addEventListener('pointercancel', () => this.tools.up());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this.onKey = (e) => {
      if (this.root.hidden || e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'Control' || e.key === 'Meta') { this.tools.ctrl = true; this.dirty = true; }
      if (e.key === 'Escape') { if (this.tools.tool === 'place') this.tools.setTool('select'); else if (this.selection.size || this.tools.region) { this.tools.region = null; this.select([]); } else this.close(); return; }
      if (e.key === ' ') { this.tools.space = true; e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.files.save(); return; }
      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 't') { this.toggleSimulate(); return; }
      if (!e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === 'k' || e.key === '?')) { const k = this.root.querySelector('.mm2-keys'); k.hidden = !k.hidden; return; }
      if (this.tools.key(e)) this.dirty = true;
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.tools.space = false;
      if (e.key === 'Control' || e.key === 'Meta') { this.tools.ctrl = false; this.tools.guides = null; this.dirty = true; }
    });
    new ResizeObserver(() => this.resize()).observe(this.gl);
    this.root.querySelector('[data-act="close"]').addEventListener('click', () => this.close());
    this.root.querySelector('[data-act="sim"]').addEventListener('click', () => this.toggleSimulate());
    this.root.querySelector('[data-act="undo"]').addEventListener('click', () => this.afterHistory(this.doc.undo(), 'Undid'));
    this.root.querySelector('[data-act="redo"]').addEventListener('click', () => this.afterHistory(this.doc.redo(), 'Redid'));
    this.root.querySelector('[data-act="layers"]').addEventListener('click', () => this.panels.tab('layers'));
    this.root.querySelector('[data-act="mapmenu"]').addEventListener('click', () => this.panels.tab('map'));
    this.root.querySelector('[data-act="save"]').addEventListener('click', () => this.files.save());
    window.addEventListener('beforeunload', () => this.saver.now());
  }

  // The thing the place tool would put down at w, as an entity (null for markers and zones).
  ghostOf(w, exact = false) {
    const p = this.place, at = exact ? w : this.snapCell(w), id = 'ghost', cfg = { alpha: 0.6 };
    if (!p) return null;
    if (p.kind === 'object') return { id, kind: 'object', cat: p.cat, i: p.i, n: this.base.catalog[p.cat][p.i]?.name, x: at.x, y: at.y, cfg };
    if (p.kind === 'unit') return { id, kind: 'unit', lv: p.lv, x: at.x, y: at.y, cfg };
    if (p.kind === 'sprite') return { id, kind: 'sprite', ...(p.game ? { game: p.game } : { image: p.image }), x: w.x, y: w.y, scale: 1, alpha: 0.6 };
    if (p.kind === 'fspike') return { id, kind: 'spike', c: p.c, q: 0, x: at.x, y: at.y };
    if (p.kind === 'text') return { id, kind: 'text', x: at.x, y: at.y, t: 'Text', w: 280, h: 56, alpha: 0.6 };
    return null;
  }
  draw() {
    const dpr = window.devicePixelRatio || 1, t0 = performance.now();
    const T = this.tools;
    if (T.tool === 'place' && T.hover && !T.drag) { const g = T.placing(T.hover); this.renderer.ghost = this.ghostOf(g.at, g.exact); }
    else this.renderer.ghost = null;
    this.renderer.draw({ x: this.cam.x, y: this.cam.y, scale: this.cam.scale * dpr, dpr }, this.gl.width, this.gl.height);
    const g = this.ui.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.ui.clientWidth, this.ui.clientHeight);
    this.tools.overlay(g);
    this.minimap?.draw();
    this.frameMs = performance.now() - t0;
    const h = this.hover ? `${Math.round(this.hover.x)}, ${Math.round(this.hover.y)} · ` : '';
    this.status.textContent = `${h}${Math.round(this.cam.scale * 100)}% · ${this.frameMs.toFixed(1)} ms`;
  }
  loop() {
    let last = 0;
    const tick = (t) => {
      if (!this.root.isConnected) return;
      // Animated sprites move ten times a second; otherwise only changes draw.
      if (!this.root.hidden && (this.dirty || t - last > (this.renderer?.simulate ? 16 : 100))) { this.dirty = false; last = t; this.draw(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
