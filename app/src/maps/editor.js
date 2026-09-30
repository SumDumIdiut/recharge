import { TileStore } from './tilestore.js';
import { readDraft, writeDraft } from './draftdb.js';

const DRAFT_KEY = 'rechargeMapMakerDraft';
const START_BOX = { dx: 0, dy: 0, w: 60, h: 250 };
const END_BOX = { dx: 0, dy: -26, w: 240, h: 13 };
const START_LIFT = 125;
const SPAWN_BOX = { dx: 0, dy: 0, w: 32, h: 64 };
const SPAWN_LIFT = 40;
// A course's screen (the board showing its reward, best time and clones),
// placed by the centre of its texts: the game's board is 350 x 150 scaled
// 1.1 x 1.15, sitting just below them.
const SCREEN_BOX = { dx: 3, dy: 3, w: 385, h: 172 };
const END_LIFT = 32;
const CELL = 32;
const OFFSET_Y = 9;
const MIN_SCALE = 0.02;
const MAX_SCALE = 4;

const COLORS = {
  bg: '#101010',
  grid: 'rgba(249, 255, 228, 0.05)',
  ground: '#4a4d44',
  dark: '#34363a',
  moss: '#3f5a3a',
  blue: '#3f7fe0',
  orange: '#e08a3f',
  spike: '#d0d4c4',
  darkSpike: '#6a6d72',
  true: '#ff2020',
  kill: 'rgba(214, 64, 88, 0.35)',
  removed: 'rgba(198, 62, 216, 0.6)',
  start: '#41f88d',
  spawn: '#5ec8f0',
  reset: '#f0a040',
  checkpoint: '#5ec8f0',
  courseCheckpoint: '#ffb347',
  respawn: '#b98cff',
  upgrade: '#f0a040',
  trigger: '#e8d85a',
  fall: '#7ad7f0',
  end: '#c63ed8',
  area: 'rgba(249, 255, 228, 0.55)',
};

let base = null;
let groundSet = null;
let mossSet = null;
let blueSet = null;
let orangeSet = null;
let baseHaz = null;

let canvas, ctx, root;
let cam = { x: 0, y: 0, scale: 0.75 };
let tool = 'block';
let hover = null;
let drag = null;
let spaceDown = false;
let undoStack = [];
let redoStack = [];
const DEFAULT_PLAYER = { dashes: 1, airJumps: 1, wallJump: true, blockSwap: false, omniDash: false, zipMovers: true, refreshers: true, teleporters: true, cash: 0 };
let draft = emptyDraft();
let mounted = false;
let frameQueued = false;

function emptyDraft() {
  return { name: '', description: '', pad: 12, useBase: false, baseState: 'start', blocks: {}, spikes: {}, vines: {}, tiles: {}, arrows: [], placed: [], removed: [], removedVines: [], removedObjects: [], removedScene: [], removedDeco: [], vineSprite: 'smallArc', start: null, end: null, spawn: null, courses: [], activeCourse: null, baseEdits: {}, cat: 'blocks', pick: {}, player: { ...DEFAULT_PLAYER }, ownProgress: false };
}

let blocks = new Map();
let spikes = new Map();
let vines = new Map();
let tiles = newTileStore();
let placed = [];
// Spikes placed off the grid (a finer snap than a cell): { x, y, c, q }.
let freeSpikes = [];
// Text placed in the map, in the style of the level's green signs: { x, y, t, w, h, c, r }.
let signs = [];
// Zones switching the map's music / background: { x, y, w, h, music, background }.
let triggers = [];
// Your own images placed in the map: { x, y, image, scale, r, fx, fy }.
let csprites = [];
// Extra spawns: the game cycles through them (and the main spawn) with Q / E.
let xspawns = [];
let arrows = [];
let removed = new Set();
let removedVines = new Set();
let removedObjects = new Set();
let removedScene = new Set();
let removedDeco = new Set();
// The level's own sprites and objects moved in the editor: id -> [dx, dy].
let movedScene = new Map(), movedObjects = new Map();
// The level's own things' draw order, turn / size / flips and groups, by level id ('o:' + id for level objects).
let levelOrder = new Map(), levelTf = new Map(), levelGroups = new Map();
const levelKey = (t) => (t.kind === 'base' ? 'o:' + t.id : t.id);
let removedPaths = [];
const syncRemovedPaths = () => { removedPaths = baseObjects.filter((o) => removedObjects.has(o.id)).map((o) => o.path); };
let baseObjects = [];

const key = (cx, cy) => cx + ',' + cy;
const unkey = (k) => k.split(',').map(Number);

function cellOf(wx, wy) {
  return { cx: Math.floor(wx / CELL), cy: Math.floor((wy - OFFSET_Y) / CELL) };
}
function cellWorld(cx, cy) {
  return { x: cx * CELL, y: cy * CELL + OFFSET_Y };
}
const baseOn = () => draft.useBase && base !== null;

function newTileStore() {
  const t = new TileStore(layerGrid, tileMatrix, base?.mats);
  t.journal = [];
  return t;
}
// The saved draft: IndexedDB, or (the first time) the old localStorage one.
async function readSavedDraft() {
  try {
    const got = await readDraft();
    if (got) return got;
  } catch (e) { console.warn('[map editor] no IndexedDB draft', e); }
  try {
    const old = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (old) return { draft: old };
  } catch {}
  return null;
}
// tiles: { meta, chunks } from IndexedDB, { layers, mats } from a map file, or none (the draft's own old `tiles`).
function loadDraft(saved = null, tileSource = null) {
  draft = Object.assign(emptyDraft(), saved || {});
  draft.player = { ...DEFAULT_PLAYER, ...(draft.player || {}) };
  migrateGates();
  blocks = new Map(Array.isArray(draft.blocks) ? draft.blocks.map((k) => [k, 'ground']) : Object.entries(draft.blocks));
  spikes = new Map(Object.entries(draft.spikes).map(([k, v]) => [k, typeof v === 'number' ? { q: v, c: 'spike' } : v]));
  vines = new Map(Object.entries(draft.vines));
  tiles = newTileStore();
  if (tileSource?.meta) tiles.load(tileSource.meta, tileSource.chunks || []);
  else if (tileSource?.layers) for (const l of tileSource.layers) tiles.addRuns(l.tilemap === 'ground' ? 'new awesome nikki ground' : l.tilemap, l.names, l.runs, tileSource.mats);
  else for (const [k, t] of Object.entries(draft.tiles || {})) tiles.set(k, t);
  if (!tileSource?.meta) tilesReplaced = true;
  delete draft.tiles;
  mossCells = new Map(Object.entries(draft.moss || {}));
  cellGroups = new Map(Object.entries(draft.cellGroups || {}));
  placed = [...(draft.placed || [])];
  freeSpikes = [...(draft.freeSpikes || [])];
  signs = [...(draft.signs || [])];
  triggers = [...(draft.triggers || [])];
  csprites = [...(draft.csprites || [])];
  xspawns = [...(draft.xspawns || [])];
  arrows = (draft.arrows || []).map((a) => ({ ...a, cells: a.cells.map((c) => [...c]) }));
  for (const [k, v] of spikes) if (v.c === 'vine') { spikes.delete(k); vines.set(k, { s: 'smallArc', q: v.q }); }
  removedVines = new Set(draft.removedVines);
  removedObjects = new Set(draft.removedObjects);
  removedScene = new Set(draft.removedScene || []);
  removedDeco = new Set(draft.removedDeco || []);
  movedScene = new Map(Object.entries(draft.movedScene || {}));
  movedObjects = new Map(Object.entries(draft.movedObjects || {}));
  levelOrder = new Map(Object.entries(draft.levelOrder || {}));
  levelTf = new Map(Object.entries(draft.levelTf || {}));
  levelGroups = new Map(Object.entries(draft.levelGroups || {}));
  removed = new Set(draft.removed);
}

function saveDraft() {
  draft.blocks = Object.fromEntries(blocks);
  draft.spikes = Object.fromEntries(spikes);
  draft.vines = Object.fromEntries(vines);
  draft.moss = Object.fromEntries(mossCells);
  draft.cellGroups = Object.fromEntries(cellGroups);
  draft.placed = placed;
  draft.freeSpikes = freeSpikes;
  draft.signs = signs;
  draft.triggers = triggers;
  draft.csprites = csprites;
  draft.xspawns = xspawns;
  draft.arrows = arrows;
  draft.removedVines = [...removedVines];
  draft.removedObjects = [...removedObjects];
  draft.removedScene = [...removedScene];
  draft.removedDeco = [...removedDeco];
  for (const [k, d] of [...movedScene]) if (!d[0] && !d[1]) movedScene.delete(k);
  for (const [k, d] of [...movedObjects]) if (!d[0] && !d[1]) movedObjects.delete(k);
  draft.movedScene = Object.fromEntries(movedScene);
  draft.movedObjects = Object.fromEntries(movedObjects);
  draft.levelOrder = Object.fromEntries(levelOrder);
  draft.levelTf = Object.fromEntries(levelTf);
  draft.levelGroups = Object.fromEntries(levelGroups);
  syncRemovedPaths();
  applyBaseMoves();
  redrawChangedLevel();
  draft.removed = [...removed];
  persistSoon();
  updateStatus();
}

// Written a moment after the last change: the draft, and the tile chunks that changed.
let tilesReplaced = false, persistTimer = 0, persisting = Promise.resolve();
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 300);
}
function persistNow() {
  clearTimeout(persistTimer);
  const all = tilesReplaced;
  tilesReplaced = false;
  const chunks = all ? [...tiles.layers.values()].flatMap((l) => [...l.chunks].map(([ck, c]) => [l.name + '|' + ck, c.slice()])) : tiles.takeDirty();
  if (all) tiles.dirty.clear();
  const copy = JSON.parse(JSON.stringify(draft));
  persisting = persisting.then(() => writeDraft(copy, tiles.meta(), chunks, all)).catch((e) => {
    console.warn('[map editor] saving the draft failed', e);
    tilesReplaced = true;
  });
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
  return persisting;
}

// The latest snapshot, with where the tile journal was at the time.
let snapMark = null;
function snapshot() {
  const out = snapshotState();
  snapMark = { s: out, j: tiles.journal, n: tiles.journal.length };
  return out;
}
function snapshotState() {
  return JSON.stringify({ blocks: [...blocks], spikes: [...spikes], vines: [...vines], moss: [...mossCells], placed, freeSpikes, signs, triggers, csprites, xspawns, cellGroups: [...cellGroups], hiddenGroups: draft.hiddenGroups || [], arrows, removed: [...removed], removedVines: [...removedVines], removedObjects: [...removedObjects], removedScene: [...removedScene], removedDeco: [...removedDeco], movedScene: [...movedScene], movedObjects: [...movedObjects], levelOrder: [...levelOrder], levelTf: [...levelTf], levelGroups: [...levelGroups], courses: courses(), baseEdits: draft.baseEdits || {}, spawn: draft.spawn });
}
// An undo step: the state as a snapshot (s), and the tile changes made since (tj).
function pushUndo() {
  pushUndoEntry(snapshot());
}
function pushUndoEntry(s) {
  redoStack = [];
  // Tile changes made since that snapshot was taken belong to this step.
  tiles.journal = snapMark?.s === s && snapMark.j === tiles.journal ? tiles.journal.splice(snapMark.n) : [];
  undoStack.push({ s, tj: tiles.journal });
  let size = 0;
  for (const e of undoStack) size += e.s.length + e.tj.length * 40;
  while (undoStack.length > 200 || (undoStack.length > 1 && size > 64e6)) { const e = undoStack.shift(); size -= e.s.length + e.tj.length * 40; }
}
// The last step taken back off the stack without undoing it (nothing changed).
function popUndo() {
  const e = undoStack.pop();
  if (e) e.tj.push(...(tiles.journal === e.tj ? [] : tiles.journal));
  tiles.journal = undoStack.at(-1)?.tj || [];
}
// A drag's changes so far taken back, to redo them from its start.
function restoreDragStart(d) {
  tiles.rollback(0);
  applyState(JSON.parse(d.before));
}
function undo() {
  const e = undoStack.pop();
  if (!e) return;
  const redoTiles = tiles.revert(e.tj);
  redoStack.push({ s: snapshot(), tj: redoTiles });
  tiles.journal = undoStack.at(-1)?.tj || [];
  restoreSnapshot(e.s);
}
function redo() {
  const e = redoStack.pop();
  if (!e) return;
  const undoTiles = tiles.revert(e.tj);
  undoStack.push({ s: snapshot(), tj: undoTiles });
  tiles.journal = undoTiles;
  restoreSnapshot(e.s);
}
function restoreSnapshot(s) {
  applyState(JSON.parse(s));
  saveDraft();
  requestDraw();
}
// A snapshot's state put back, without saving (a drag rebuilds from its start on every move).
function applyState(o) {
  blocks = new Map(o.blocks);
  spikes = new Map(o.spikes);
  vines = new Map(o.vines);
  mossCells = new Map(o.moss || []);
  cellGroups = new Map(o.cellGroups || []);
  placed = o.placed || [];
  freeSpikes = o.freeSpikes || [];
  signs = o.signs || [];
  triggers = o.triggers || [];
  csprites = o.csprites || [];
  xspawns = o.xspawns || [];
  draft.hiddenGroups = o.hiddenGroups || [];
  arrows = o.arrows || [];
  removedVines = new Set(o.removedVines);
  removedObjects = new Set(o.removedObjects);
  removedScene = new Set(o.removedScene || []);
  removedDeco = new Set(o.removedDeco || []);
  movedScene = new Map(o.movedScene || []);
  movedObjects = new Map(o.movedObjects || []);
  levelOrder = new Map(o.levelOrder || []);
  levelTf = new Map(o.levelTf || []);
  levelGroups = new Map(o.levelGroups || []);
  applyBaseMoves();
  removed = new Set(o.removed);
  draft.courses = o.courses || [];
  draft.baseEdits = o.baseEdits || {};
  if (o.start || o.end) { draft.start = o.start; draft.end = o.end; migrateGates(); }
  draft.spawn = o.spawn;
}

let basePromise = null;
async function loadBase(show = false) {
  if (show && !loading) showLoading();
  if (!basePromise) basePromise = fetchBase().catch((e) => { basePromise = null; hideLoading(); throw e; });
  await basePromise;
  if (loading && !loading.render) { loading.render = true; setLoading(0.7, 'Drawing the view'); requestDraw(); }
}

async function fetchBase() {
  const res = await fetch('/maps/basemap.json');
  if (!res.ok) throw new Error('basemap.json: ' + res.status);
  const total = Number(res.headers.get('content-length')) || 5e6;
  let text;
  if (res.body?.getReader) {
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      setLoading(0.5 * Math.min(1, got / total), `Level data ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    }
    text = await new Blob(chunks).text();
  } else text = await res.text();
  base = JSON.parse(text);
  try { plantList = await (await fetch('/maps/plants/plants.json')).json(); } catch { plantList = []; }
  await preloadImages();
  applyBaseState();
  startTileWorkers();
}

function preloadImages() {
  const sc = base.scene, jobs = [];
  const add = (src, keep) => jobs.push([src, keep]);
  add('/maps/' + base.art.atlas, (i) => { atlasImg = i; });
  if (sc) {
    add('/maps/' + sc.atlas, (i) => { sceneImg = i; });
    for (const b of sc.backgrounds || []) add('/maps/' + b.img, (i) => { bgImages[b.img] = i; });
    (sc.fonts || []).forEach((f, n) => { if (f) add('/maps/' + f.atlas, (i) => { fontImages[n] = i; }); });
  }
  for (const v of new Set(base.defs.filter((d) => d.kind === 'vine').map((d) => d.sprite))) add('/maps/vines/' + encodeURIComponent(v) + '.png', (i) => { vineImages[v] = i; });
  let done = 0;
  const seen = new Map();
  return Promise.all(jobs.map(([src, keep]) => {
    if (!seen.has(src)) seen.set(src, new Promise((ok) => { const i = new Image(); i.onload = i.onerror = () => ok(i); i.src = src; }));
    return seen.get(src).then((i) => { keep(i); setLoading(0.5 + (0.2 * ++done) / jobs.length, `Images ${done} / ${jobs.length}`); });
  }));
}

let loading = null;
function showLoading() {
  const wrap = root?.querySelector('.mm-canvas-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'mm-loading';
  el.innerHTML = '<div class="mm-loading-box"><div class="mm-loading-title">Loading the level</div><div class="mm-loading-track"><div class="mm-loading-bar"></div></div><div class="mm-loading-label">Starting…</div></div>';
  wrap.appendChild(el);
  loading = { el, bar: el.querySelector('.mm-loading-bar'), label: el.querySelector('.mm-loading-label'), shown: 0, render: false };
}
function setLoading(frac, label) {
  if (!loading) return;
  loading.shown = Math.max(loading.shown, frac);
  loading.bar.style.width = (loading.shown * 100).toFixed(1) + '%';
  if (label) loading.label.textContent = label;
}
function hideLoading() {
  if (!loading) return;
  const el = loading.el;
  setLoading(1, 'Ready');
  loading = null;
  el.classList.add('done');
  setTimeout(() => el.remove(), 300);
}

let layer = null;
function applyBaseState() {
  if (!base) return;
  stageMask = null;
  baseMossGrid = null;
  const st = base.states[draft.baseState] || base.states.start;
  const both = (kind) => [base.always[kind], st[kind]];
  layer = { ground: both('ground'), moss: both('moss'), blue: both('blue'), orange: both('orange') };
  const runSet = (list) => {
    const s = new Set();
    for (const runs of list) for (let i = 0; i < runs.length; i += 3) for (let k = 0; k < runs[i + 2]; k++) s.add(key(runs[i + 1] + k, runs[i]));
    return s;
  };
  groundSet = runSet(layer.ground);
  mossSet = runSet(layer.moss);
  blueSet = runSet(layer.blue);
  orangeSet = runSet(layer.orange);
  buildArtIndex();
  buildScene();
  baseVersion++;
  baseObjects = [...(base.always.objects || []), ...(st.objects || [])].map((o) => ({ ...o, id: o.path + '@' + o.x + ',' + o.y }));
  syncRemovedPaths();
  applyBaseMoves();
  baseHaz = new Map();
  for (const b of [base.always, st]) {
    const h = b.hazards;
    for (let i = 0; i < h.length; i += 5) {
      const def = base.defs[h[i + 2]];
      baseHaz.set(key(h[i], h[i + 1]), { d: h[i + 2], m: h[i + 3], q: h[i + 4], kind: def.kind, c: layerColor(def.layer) });
    }
  }
}

const layerColor = (layer) => (/^blue/.test(layer) ? 'blue' : /^orange/.test(layer) ? 'orange' : 'spike');
const SPIKE_LAYER = { spike: 'Spikes', dark: 'Spikes', blue: 'blueSpikes', orange: 'orangeSpikes' };
// The game's darker spikes: their own tiles on the Spikes layer, one per direction.
const DARK_SPIKE_TILES = new Set(['spike_tileset_8', 'spike_tileset_11', 'spike_tileset_13', 'spike_tileset_14']);
const VINE_LAYER = 'OvergrowthSpikes';

function rotMatrix(k) {
  const a = (((k % 4) + 4) % 4) * Math.PI / 2;
  const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [c, -s, s, c];
}

function defUses() {
  if (!defUses.counts) {
    const counts = new Map();
    for (const b of [base.always, ...Object.values(base.states)]) {
      const h = b.hazards || [];
      for (let i = 0; i < h.length; i += 5) counts.set(h[i + 2], (counts.get(h[i + 2]) || 0) + 1);
    }
    defUses.counts = counts;
  }
  return defUses.counts;
}

function spikeTile(c, q) {
  const layer = SPIKE_LAYER[c] || SPIKE_LAYER.spike;
  const uses = defUses();
  const spikes = base.defs.map((d, i) => [d, uses.get(i) || 0]).filter(([d]) => d.layer === layer && d.kind === 'spike' && (layer !== 'Spikes' || DARK_SPIKE_TILES.has(d.tile) === (c === 'dark')));
  const best = (want) => spikes.filter(([d]) => d.base === want).sort((a, b) => b[1] - a[1])[0]?.[0];
  const d = (q === 1 && best(3)) || best(q) || best(0) || spikes[0][0];
  return { layer, tile: d.tile, matrix: rotMatrix(q - d.base) };
}
function trueSpikeDef() {
  const t = spikeTile('spike', 0), d = defByTile(t.layer + '|' + t.tile);
  const pts = (d?.shape || [[[13, 3], [-13, 3], [-13, -16], [13, -16]]]).flat();
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const cx = (x0 + x1) / 2, h = y1 - y0, half = Math.max(4, (x1 - x0) / 2 - 1);
  const box = [cx - half, y0, cx + half, y0 + 2 * h];
  return { tile: t.tile, box, shape: [[[box[2], box[3]], [box[0], box[3]], [box[0], box[1]], [box[2], box[1]]]] };
}
function trueSpikeJson(sp, cx, cy, at) {
  const d = trueSpikeDef(), c = COLORS.true.match(/\w\w/g).map((h) => Math.round((parseInt(h, 16) / 255) * 1000) / 1000);
  const turn = spikeTurn(sp, cx, cy), t = spikeTile('spike', turn);
  return { type: 'trueSpike', tilemap: t.layer, tileName: t.tile, ...at, matrix: t.matrix, rotation: turn * 90, color: c, hitbox: d.box };
}
const tintedTiles = new Map();
function trueSpikeCanvas() {
  const d = trueSpikeDef(), sprite = base.art.tiles[d.tile];
  let cv = tintedTiles.get(sprite);
  if (!cv) {
    const [sx, sy, w, h] = base.art.sprites[sprite];
    cv = makeCanvas();
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.drawImage(atlasImg, sx, sy, w, h, 0, 0, w, h);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = COLORS.true;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(atlasImg, sx, sy, w, h, 0, 0, w, h);
    tintedTiles.set(sprite, cv);
  }
  return cv;
}
function drawTrueSpike(cx, cy, q) {
  if (!artReady()) return drawSpike(cx, cy, q, COLORS.true);
  const wc = cellWorld(cx, cy);
  drawTrueSpikeAt(wc.x + CELL / 2, wc.y + CELL / 2, q);
}
function drawTrueSpikeAt(x, y, q) {
  const d = trueSpikeDef(), cv = trueSpikeCanvas();
  const wc = { x: x - CELL / 2, y: y - CELL / 2 }, c = toScreen(x, y), m = rotMatrix(q), px = cam.scale, w = cv.width, h = cv.height;
  ctx.save();
  ctx.setTransform(px * m[0], -px * m[2], -px * m[1], px * m[3], c.x + px * (-m[0] * w / 2 + m[1] * h / 2), c.y + px * (m[2] * w / 2 - m[3] * h / 2));
  ctx.drawImage(cv, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = COLORS.true;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  d.shape[0].forEach(([x, y], i) => { const p = toScreen(wc.x + CELL / 2 + m[0] * x + m[1] * y, wc.y + CELL / 2 + m[2] * x + m[3] * y); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function vineTile(sprite, q) {
  const d = base.defs.find((d) => d.kind === 'vine' && d.sprite === sprite && d.layer === VINE_LAYER) || base.defs.find((d) => d.kind === 'vine' && d.sprite === sprite);
  return { layer: d.layer, tile: d.tile, matrix: rotMatrix(q) };
}
function vineSprites() {
  return [...new Set(base.defs.filter((d) => d.kind === 'vine' && d.layer === VINE_LAYER).map((d) => d.sprite))].sort();
}

const CATEGORIES = [
  { id: 'blocks', label: 'Blocks', key: 'b' },
  { id: 'hazards', label: 'Hazards', key: 's' },
  { id: 'objects', label: 'Objects', key: 'o' },
  { id: 'decor', label: 'Decor', key: 'd' },
  { id: 'gates', label: 'Course', key: 'c' },
];
const LAYER_LABELS = { 'new awesome nikki ground': 'Ground' };
const layerLabel = (name) => LAYER_LABELS[name] || prettySprite(name.replace(/_/g, ' '));
const tilemapName = (layer) => (layer === 'new awesome nikki ground' ? 'ground' : layer);
// A placed thing's catalog entry: by its index, or by its saved name if a newer base map moved it.
function catalogItem(o) {
  const list = base?.catalog?.[o.cat], item = list?.[o.i];
  if (!item || !o.n || item.name === o.n) return item;
  const i = list.findIndex((x) => x.name === o.n);
  if (i < 0) return item;
  o.i = i;
  return list[i];
}

function layerGrid(name) {
  const l = base?.art?.layers.find((x) => x.name === name);
  return l ? { size: l.size, ox: l.ox, oy: l.oy, order: l.order ?? 0 } : { size: CELL, ox: 0, oy: OFFSET_Y - CELL, order: 0 };
}
function tileKeyAt(layer, wx, wy) {
  const g = layerGrid(layer);
  return layer + '|' + Math.floor((wx - g.ox) / g.size) + ',' + Math.floor((wy - g.oy) / g.size);
}
function tileCenter(layer, k) {
  const g = layerGrid(layer);
  const [gx, gy] = k.slice(k.lastIndexOf('|') + 1).split(',').map(Number);
  return { x: g.ox + (gx + 0.5) * g.size, y: g.oy + (gy + 0.5) * g.size };
}

const AROUND = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
function autotilePick(table, has, x, y) {
  if (!table) return null;
  const bits = AROUND.map(([dx, dy]) => has(x + dx, y + dy));
  for (const c of [1, 3, 5, 7]) bits[c] = bits[c] && bits[c - 1] && bits[(c + 1) % 8];
  const mask = bits.reduce((m, b, i) => (b ? m | (1 << i) : m), 0);
  if (table[mask]) return table[mask];
  const count = (n) => { let c = 0; for (; n; n >>= 1) c += n & 1; return c; };
  let best = null, score = Infinity;
  for (const [m, v] of Object.entries(table)) {
    const d = Number(m) ^ mask, sc = count(d & 0b01010101) * 4 + count(d & 0b10101010);
    if (sc < score) { score = sc; best = v; }
  }
  return best;
}

const PANEL = { TL: 1, T: 2, TR: 3, L: 9, C: 10, R: 11, BL: 17, B: 18, BR: 19 };
// The ground sheets' panel set: a lone cell, a 1-wide column and a 1-high row each have their own pieces.
const PANEL_SET = { ...PANEL, single: 0, v: [8, 16, 26], h: [27, 28, 29] };
const GRATE_SET = { ...PANEL, single: 0, v: [8, 16, 24], h: [25, 26, 27] };
function colouredTile(kind, cx, cy) {
  if (!base?.art) return null;
  const set = kind === 'blue' ? blueSet : orangeSet;
  const has = (x, y) => { const k = key(x, y); return blocks.get(k) === kind || (baseOn() && !!set?.has(k) && !removed.has(k)); };
  return plateTile(kind === 'blue' ? 'blueBlocks' : 'orangeBlocks', kind + '_ground_tileset_', PANEL_SET, has, cx, cy);
}

let mossCells = new Map();
// Group ids of your block and spike cells (placed things carry their own .group).
let cellGroups = new Map();
let baseMossGrid = null;
function baseMoss() {
  if (baseMossGrid) return baseMossGrid;
  baseMossGrid = new Set();
  for (const l of base?.art?.layers || []) {
    if (l.name !== 'moss' || (l.state !== 'always' && l.state !== draft.baseState)) continue;
    for (let i = 0; i < l.runs.length; i += 5) for (let n = 0; n < l.runs[i + 2]; n++) baseMossGrid.add((l.runs[i + 1] + n) + ',' + l.runs[i]);
  }
  return baseMossGrid;
}
function mossKeyAt(wx, wy) {
  const g = layerGrid('moss');
  return Math.floor((wx - g.ox) / g.size) + ',' + Math.floor((wy - g.oy) / g.size);
}
function mossCenter(k) {
  const g = layerGrid('moss'), [gx, gy] = k.split(',').map(Number);
  return { x: g.ox + (gx + 0.5) * g.size, y: g.oy + (gy + 0.5) * g.size };
}
function mossSprite(k) {
  const [gx, gy] = k.split(',').map(Number);
  const has = (x, y) => mossCells.has(x + ',' + y) || (baseOn() && baseMoss().has(x + ',' + y) && !mossErased(x, y));
  return autotilePick(base?.art?.autotiles?.moss, has, gx, gy);
}
function mossErased(gx, gy) {
  const g = layerGrid('moss'), c = cellOf(g.ox + gx * g.size + CELL / 2, g.oy + gy * g.size + CELL / 2);
  return removed.has(key(c.cx, c.cy)) || removed.has(key(c.cx + 1, c.cy)) || removed.has(key(c.cx, c.cy + 1)) || removed.has(key(c.cx + 1, c.cy + 1));
}
function drawMoss(k, alpha = 1) {
  const pick = mossSprite(k);
  if (!pick || !artReady()) return false;
  const c = mossCenter(k), sc = toScreen(c.x, c.y);
  ctx.save();
  ctx.globalAlpha = alpha;
  blitSprite(ctx, pick[0], base.mats[pick[1]], cam.scale, sc.x, sc.y);
  ctx.restore();
  return true;
}
function mossCovers(cx, cy) {
  const w = cellWorld(cx, cy);
  return mossCells.has(mossKeyAt(w.x + CELL / 2, w.y + CELL / 2));
}

function categoryItems(cat) {
  if (cat === 'triggers') return triggerItems();
  if (!base) return cat === 'gates' ? gateItems() : cat === 'blocks' ? blockItems() : [];
  switch (cat) {
    case 'blocks': return blockItems();
    case 'hazards': return [
      { tool: 'spike', label: 'Spike', group: 'Spikes', thumb: { art: spikeTile('spike', 0).tile } },
      { tool: 'darkSpike', label: 'Dark spike', group: 'Spikes', thumb: { art: spikeTile('dark', 0).tile } },
      { tool: 'blueSpike', label: 'Blue spike', group: 'Spikes', thumb: { art: spikeTile('blue', 0).tile } },
      { tool: 'orangeSpike', label: 'Orange spike', group: 'Spikes', thumb: { art: spikeTile('orange', 0).tile } },
      { tool: 'trueSpike', label: 'True spike', group: 'Spikes', thumb: { trueSpike: true, color: COLORS.true } },
      ...vineSprites().filter((v) => base.catalog?.vineNames?.[v] !== null).map((v) => ({ tool: 'vine', vine: v, group: 'Thorn vines', label: base.catalog?.vineNames?.[v] || prettySprite(v), thumb: { img: '/maps/vines/' + encodeURIComponent(v) + '.png' } })),
    ];
    case 'objects':
      return (base.catalog?.objects || []).map((o, i) => ({ tool: 'object', i, label: o.name, group: 'Gameplay', thumb: /^Long fall/.test(o.name) ? { icon: 'fall', color: COLORS.fall } : { scene: mainSprite(o) } }))
        .filter((it) => !/checkpoint/i.test(it.label));
    case 'tiles':
      return tileTabItems();
    case 'decor':
      return [
        { tool: 'sign', label: 'Text', group: 'Text', thumb: { color: SIGN_COLOR } },
        { tool: 'csprite', image: null, label: 'Add an image…', group: 'Your images', thumb: { color: '#8aa0b8' } },
        ...assetList('image').map((a) => ({ tool: 'csprite', image: a.file, label: a.name, group: 'Your images', thumb: { color: '#8aa0b8' } })),
        { tool: 'arrow', label: 'Guide arrow', group: 'Paths', thumb: { arrow: true } },
        ...(base.catalog?.decor || []).map((o, i) => ({ tool: 'decor', i, label: o.name, group: PLANT_DECOR.test(o.name) ? 'Plants' : 'Props', thumb: { scene: mainSprite(o) } }))
          .sort((a, b) => (a.group === 'Plants' ? 0 : 1) - (b.group === 'Plants' ? 0 : 1)),
        ...plantItems(),
        ...(base.art.stamps || []).map((st, si) => ({ tool: 'stamp', si, label: st.name, group: 'Tile pieces', thumb: { stamp: si } }))
          .filter((it) => !/^Guide arrow /.test(it.label)),
      ];
    default: return gateItems();
  }
}
// Trigger zones: each acts when the player walks in.
const TRIGGER_KINDS = {
  media: { icon: 'music', label: 'Music / background', group: 'Level', color: '#c792ff', about: 'switches them when the player walks in' },
  show: { icon: 'eye', label: 'Show group', group: 'Groups', color: '#5fd4a0', about: 'turns a group on' },
  hide: { icon: 'eyeOff', label: 'Hide group', group: 'Groups', color: '#e0736a', about: 'turns a group off' },
  toggle: { icon: 'toggle', label: 'Toggle group', group: 'Groups', color: '#e0c36a', about: 'flips a group on / off' },
  move: { icon: 'move', label: 'Move group', group: 'Groups', color: '#6aa8e0', about: 'slides a group by an offset' },
  teleport: { icon: 'portal', label: 'Teleport', group: 'Player', color: '#b07bff', about: 'sends the player to the marker' },
  kill: { icon: 'skull', label: 'Kill zone', group: 'Player', color: '#ff4f6d', about: 'kills the player like a spike' },
  respawn: { icon: 'respawn', label: 'Set respawn', group: 'Player', color: '#41f88d', about: 'the player respawns at the marker' },
  zoom: { icon: 'zoom', label: 'Camera zoom', group: 'Camera', color: '#7ad7f0', about: 'zooms the camera while inside' },
  message: { icon: 'message', label: 'Message', group: 'Camera', color: '#f0f07a', about: 'shows text on screen' },
};
const GROUP_KINDS = new Set(['show', 'hide', 'toggle', 'move']);
const MARKER_KINDS = new Set(['teleport', 'respawn']);
function triggerItems() {
  return Object.entries(TRIGGER_KINDS).map(([k, d]) => ({ tool: 'mtrigger', trigKind: k, label: d.label, group: d.group, thumb: { icon: d.icon, color: d.color } }));
}
function newTrigger(kind, x, y) {
  const t = { kind, x, y, w: 256, h: 256 };
  if (kind === 'move') Object.assign(t, { dx: 0, dy: 256, time: 1 });
  if (MARKER_KINDS.has(kind)) Object.assign(t, { tx: 512, ty: 0 });
  if (kind === 'zoom') t.size = 1.5;
  if (kind === 'message') Object.assign(t, { text: 'Hello!', seconds: 3 });
  if (GROUP_KINDS.has(kind)) t.group = [...new Set([...cellGroups.values(), ...[...WORLD_KINDS].flatMap((k) => listOfKind(k).map((i) => i.group))].filter(Boolean))][0] || '1';
  return t;
}
const trigKind = (t) => t.kind || 'media';

// The game's plant art the level never places (the Mossy sheets), placed like your own images.
let plantList = [];
const PLANT_DECOR = /trunk|glow/i;
function plantItems() {
  const count = {};
  return plantList.map((pl, pi) => ({ tool: 'gsprite', pi, label: `${pl.kind} ${(count[pl.kind] = (count[pl.kind] || 0) + 1)}`, group: 'Plants', thumb: { img: '/maps/plants/' + pl.file } }));
}
const plantOf = (cs) => plantList.find((p) => p.sprite === cs.game);

function blockItems() {
  const sets = (group) => Object.entries(BLOCK_SETS).filter(([, b]) => b.group === group)
    .map(([kind, b]) => ({ tool: kind, label: b.label, group: b.group, thumb: { art: b.thumb || b.family + b.plate.C, color: b.color } }));
  return [
    { tool: 'block', label: 'Ground', group: 'Solid', thumb: { art: 'ground1_tileset_59' } },
    { tool: 'dark', label: 'Dark ground', group: 'Solid', thumb: { art: 'dark_ground_tileset_59' } },
    ...sets('Solid'),
    { tool: 'blue', label: 'Blue block', group: 'Colour swap', thumb: { art: 'blue_ground_tileset_10', color: COLORS.blue } },
    { tool: 'orange', label: 'Orange block', group: 'Colour swap', thumb: { art: 'orange_ground_tileset_10', color: COLORS.orange } },
    ...sets('Colour swap'),
    { tool: 'moss', label: 'Moss', group: 'Overgrowth', thumb: { sprite: base?.art?.autotiles?.moss?.['255']?.[0], color: COLORS.moss } },
    ...sets('Overgrowth'),
    ...sets('Walk-through'),
  ];
}
function gateItems() {
  const obj = (name) => base?.catalog?.objects?.findIndex((o) => o.name === name) ?? -1;
  const cp = obj('Checkpoint'), ccp = obj('Course checkpoint'), lfs = obj('Long fall start'), lfe = obj('Long fall end');
  return [
    { tool: 'spawn', label: 'Spawn', group: 'Player', thumb: { icon: 'spawn', color: COLORS.spawn } },
    { tool: 'xspawn', label: 'Extra spawn (Q / E in game)', group: 'Player', thumb: { icon: 'pin', color: COLORS.spawn } },
    { tool: 'start', label: 'Start gate', group: 'Course', thumb: { icon: 'flag', color: COLORS.start } },
    { tool: 'end', label: 'End gate', group: 'Course', thumb: { icon: 'finish', color: COLORS.end } },
    ...(ccp >= 0 ? [{ tool: 'object', i: ccp, label: 'Course checkpoint', group: 'Course', thumb: { scene: base?.catalog ? mainSprite(base.catalog.objects[ccp]) : null, icon: 'checkpoint', color: COLORS.courseCheckpoint } }] : []),
    ...(lfs >= 0 ? [{ tool: 'object', i: lfs, label: 'Long fall start', group: 'Long fall', thumb: { icon: 'fall', color: COLORS.fall } }] : []),
    ...(lfe >= 0 ? [{ tool: 'object', i: lfe, label: 'Long fall end', group: 'Long fall', thumb: { icon: 'fall', color: COLORS.fall } }] : []),
    ...(cp >= 0 ? [{ tool: 'object', i: cp, label: 'Checkpoint', group: 'Checkpoints', thumb: { scene: base?.catalog ? mainSprite(base.catalog.objects[cp]) : null, icon: 'checkpoint', color: COLORS.checkpoint } }] : []),
  ];
}
function mainSprite(o) {
  let best = null, area = -1;
  for (const p of o.parts) {
    if (HIDDEN_PART(p)) continue;
    const [, , w, h] = base.scene.sprites[p.s];
    if (w * h > area) { area = w * h; best = p.frames ? p.frames[Math.floor(p.frames.length / 2)] : p.s; }
  }
  return best;
}

function currentIndex(cat) {
  const items = categoryItems(cat);
  return Math.min(items.length - 1, Math.max(0, draft.pick[cat] ?? 0));
}

function selectItem(cat, index) {
  const items = categoryItems(cat);
  if (!items.length) { flash('Import the base map first - this category uses its sprites.', true); return; }
  index = ((index % items.length) + items.length) % items.length;
  const it = items[index];
  if (draft.cat !== cat) { placeRot = 0; placeFlip = false; }
  draft.cat = cat;
  draft.pick[cat] = index;
  if (it.vine) draft.vineSprite = it.vine;
  if (it.tool === 'decor') draft.pick.decorObj = it.i;
  if (it.tool === 'object') draft.pick.obj = it.i;
  if (it.tool === 'stamp') draft.pick.stamp = it.si;
  if (it.tool === 'tile') { draft.pick.tile = it.tile; draft.pick.tileLayer = it.tileLayer; }
  if (it.tool === 'mtrigger') draft.pick.trigKind = it.trigKind;
  if (it.tool === 'gsprite') draft.pick.gsprite = plantList[it.pi]?.sprite;
  if (it.tool === 'csprite') {
    if (it.image) draft.pick.csprite = it.image;
    else pickFile('image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp').then(async (f) => {
      if (!f) return;
      draft.pick.csprite = await addAsset('image', f);
      saveDraft();
      flash('Click to place ' + f.name);
    });
  }
  setTool(it.tool);
  saveDraft();
}

function currentItem() {
  if (tool === 'erase') return null;
  const items = categoryItems(draft.cat);
  return items[currentIndex(draft.cat)] || null;
}

function stepItem(dir) {
  if (tool === 'erase') return selectItem(draft.cat, currentIndex(draft.cat));
  selectItem(draft.cat, currentIndex(draft.cat) + dir);
}

// Line icons (24-unit grid) for triggers and course markers: canvas badges and palette thumbs alike.
const ICONS = {
  music: 'M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0a3 3 0 0 1 6 0z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2 M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  toggle: 'M8 6h8a6 6 0 0 1 0 12H8A6 6 0 0 1 8 6z M16 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  move: 'M5 9l-3 3 3 3 M9 5l3-3 3 3 M15 19l-3 3-3-3 M19 9l3 3-3 3 M2 12h20 M12 2v20',
  portal: 'M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 11a1 1 0 1 0 1 1',
  skull: 'M12 3a8 8 0 0 0-5 14.2V21h10v-3.8A8 8 0 0 0 12 3z M9 10a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z M15 10a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z M10 21v-2 M14 21v-2',
  respawn: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 8v4l3 2',
  zoom: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-5-5 M11 8v6 M8 11h6',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M7 8h10 M7 12h6',
  flag: 'M5 22V3 M5 4h12l-2.5 4.5L17 13H5',
  finish: 'M5 22V3 M5 4h14v10H5 M9.7 4v10 M14.3 4v10 M5 9h14',
  spawn: 'M12 3a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z M5 21v-1.5a7 7 0 0 1 14 0V21',
  pin: 'M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z M12 7a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  timer: 'M12 5a8 8 0 1 0 0 16a8 8 0 0 0 0-16z M12 9v4l2.5 2 M9 2h6',
  checkpoint: 'M6 22V3 M6 4c3-1.5 5 1.5 8 0s4-1 4-1v8s-1-.5-4 1-5-1.5-8 0',
  cursor: 'M5 3l14 8-6 1.5L10 19z M13 12.5l5 6',
  credits: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',
  fall: 'M12 3v15 M6 12l6 6 6-6 M5 21h14',
  eraser: 'M7 21h13 M5.5 14.5l8-8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L12 20H8.5l-3-3a2 2 0 0 1 0-2.5z M9 11l6 6',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3',
  hitbox: 'M4 4h16v16H4z M4 12h16 M12 4v16',
  play: 'M7 4l13 8-13 8z',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M14 4v4 M8 10v4 M16 16v4',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5',
  keys: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  save: 'M5 3h11l3 3v15H5z M8 3v6h8V3 M8 21v-7h8v7',
  basemap: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
  expand: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  shrink: 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5',
};
const icon = (name, size = 16) => iconSvg(name, 'currentColor', size);
const iconPaths = new Map();
function drawIcon(name, x, y, size, color, lw = 2) {
  if (!ICONS[name]) return;
  let p = iconPaths.get(name);
  if (!p) { p = new Path2D(ICONS[name]); iconPaths.set(name, p); }
  ctx.save();
  ctx.setLineDash([]);
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.stroke(p);
  ctx.restore();
}
// A round icon badge with an optional name pill beside it.
function drawBadge(icon, x, y, color, label = '') {
  const r = 11;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath(); ctx.arc(x, y + 1, r + 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(14, 14, 14, 0.9)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  drawIcon(icon, x, y, 14, color, 2.2);
  if (label) {
    ctx.font = '600 10px sans-serif';
    const w = ctx.measureText(label).width + 12, lx = x + r + 3, ly = y - 8;
    ctx.fillStyle = 'rgba(14, 14, 14, 0.88)';
    ctx.beginPath(); ctx.roundRect(lx, ly, w, 16, 8); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 6, y + 0.5);
  }
  ctx.restore();
}
const iconSvg = (name, color, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`;

function thumbHtml(th, size = 32) {
  const sheet = (atlas, img, rect) => {
    if (!img?.naturalWidth || !rect) return null;
    const [x, y, w, h] = rect, k = size / Math.max(w, h, 1);
    return `<span class="mm-thumb-img" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px;background-image:url('/maps/${atlas}');background-size:${img.naturalWidth * k}px ${img.naturalHeight * k}px;background-position:${-x * k}px ${-y * k}px"></span>`;
  };
  let inner = null;
  if (th.art && base?.art?.tiles[th.art] !== undefined) inner = sheet(base.art.atlas, atlasImg, base.art.sprites[base.art.tiles[th.art]]);
  else if (th.sprite != null && base?.art) inner = sheet(base.art.atlas, atlasImg, base.art.sprites[th.sprite]);
  else if (th.scene != null && base?.scene) inner = sheet(base.scene.atlas, sceneImg, base.scene.sprites[th.scene]);
  else if (th.img) inner = `<img src="${th.img}" alt="" style="max-width:${size}px;max-height:${size}px">`;
  else if (th.trueSpike && artReady()) { const url = (trueSpikeCanvas.url ||= trueSpikeCanvas().toDataURL()); inner = `<img src="${url}" alt="" style="width:${size}px;height:${size}px;image-rendering:pixelated">`; }
  else if (th.arrow && base) { const url = arrowThumb(); if (url) inner = `<img src="${url}" alt="" style="max-width:${size}px;max-height:${size}px;image-rendering:pixelated">`; }
  else if (th.stamp != null && base) { const url = stampThumb(th.stamp); if (url) inner = `<img src="${url}" alt="" style="max-width:${size}px;max-height:${size}px;image-rendering:pixelated">`; }
  if (!inner && th.icon && ICONS[th.icon]) inner = `<span class="mm-thumb-icon" style="--c:${th.color || '#aaa'}">${iconSvg(th.icon, th.color || '#aaa', Math.round(size * 0.62))}</span>`;
  if (!inner) inner = `<span class="mm-thumb-swatch" style="background:${th.color || '#666'}"></span>`;
  return `<span class="mm-thumb" style="width:${size}px;height:${size}px">${inner}</span>`;
}

function updateCategoryButtons() {
  if (!root) return;
  root.querySelectorAll('[data-cat]').forEach((b) => {
    const cat = b.dataset.cat;
    const active = !['erase', 'select', 'paste'].includes(tool) && draft.cat === cat;
    b.classList.toggle('active', active);
    const items = categoryItems(cat);
    const it = items[currentIndex(cat)];
    b.querySelector('.mm-cat-item').textContent = it ? it.label : '';
    b.querySelector('.mm-cat-thumb').innerHTML = it ? thumbHtml(it.thumb, 18) : '';
  });
  root.querySelector('[data-tool="erase"]')?.classList.toggle('active', tool === 'erase');
  root.querySelector('[data-tool="select"]')?.classList.toggle('active', tool === 'select');
}

let popCat = null;
function openPopover(cat, anchor) {
  const pop = root.querySelector('#mm-pop');
  if (popCat === cat && !pop.hidden) return closePopover();
  popCat = cat;
  const bar = root.querySelector('.mm-bar').getBoundingClientRect(), a = anchor.getBoundingClientRect();
  pop.style.left = Math.max(0, a.left - bar.left) + 'px';
  pop.hidden = false;
  renderPopover('');
}
function closePopover() {
  popCat = null;
  const pop = root?.querySelector('#mm-pop');
  if (pop) pop.hidden = true;
}
function renderPopover(filter) {
  const pop = root.querySelector('#mm-pop'), cat = popCat;
  const meta = CATEGORIES.find((c) => c.id === cat);
  const all = categoryItems(cat).map((it, i) => ({ it, i }));
  const searchable = all.length > 12;
  const items = all.filter(({ it }) => !filter || it.label.toLowerCase().includes(filter.toLowerCase()));
  const cur = currentIndex(cat), active = (draft.cat === cat && !['erase', 'select', 'paste'].includes(tool)) || (tool === 'select' && !!selection && paletteSpotFor(selection)?.[0] === cat);
  let body = '', group = null;
  for (const { it, i } of items) {
    if (it.group !== group) {
      if (group !== null) body += '</div>';
      group = it.group;
      body += `<div class="mm-pop-group">${group || ''}</div><div class="mm-pop-grid">`;
    }
    body += `<button class="mm-item${i === cur && active ? ' active' : ''}" data-i="${i}" title="${it.label}">` +
      `<span class="mm-item-thumb">${thumbHtml(it.thumb, 44)}</span><span class="mm-item-label">${it.label}</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}</button>`;
  }
  if (group !== null) body += '</div>';
  if (!items.length) body = `<div class="mm-pop-empty">${base ? 'Nothing matches' : 'Import the base map to use these'}</div>`;
  pop.innerHTML =
    `<div class="mm-pop-head"><span class="mm-pop-title">${meta?.label || ''}</span>` +
    (searchable ? `<input class="mm-input mm-pop-search" id="mm-pop-search" placeholder="Search ${(meta?.label || '').toLowerCase()}…" value="${filter.replace(/"/g, '&quot;')}">` : '') +
    `<button class="mm-pop-close" data-close title="Close (Esc)">✕</button></div>` +
    `<div class="mm-pop-body">${body}</div>` +
    `<div class="mm-pop-foot"><kbd>${(meta?.key || '').toUpperCase()}</kbd> next · <kbd>Shift</kbd>+<kbd>${(meta?.key || '').toUpperCase()}</kbd> back · <kbd>1</kbd>-<kbd>9</kbd> pick · <kbd>R</kbd> rotate · <kbd>F</kbd> flip</div>`;
  pop.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
    const it = categoryItems(cat)[Number(b.dataset.i)];
    if (tool === 'select' && selection && replaceSelectionWith(it)) { draft.pick[cat] = Number(b.dataset.i); renderPopover(''); return; }
    selectItem(cat, Number(b.dataset.i));
    closePopover();
  }));
  pop.querySelector('[data-close]').addEventListener('click', closePopover);
  const search = pop.querySelector('#mm-pop-search');
  if (search) {
    search.addEventListener('input', () => { const v = search.value; renderPopover(v); const s2 = root.querySelector('#mm-pop-search'); s2.focus(); s2.setSelectionRange(v.length, v.length); });
    search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closePopover(); });
  }
}

function tileMatrix(t) {
  if (t.m) return t.m;
  const r = rotMatrix(t.q || 0), fx = t.fx ? -1 : 1, fy = t.fy ? -1 : 1;
  return [r[0] * fx, r[1] * fy, r[2] * fx, r[3] * fy];
}
const mul2 = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
const rot2 = (rad) => [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];

function drawPlacedTile(t, k, alpha = 1) {
  const sprite = base?.art?.tiles[t.tile];
  if (sprite === undefined || !artReady()) return;
  const w = tileCenter(t.layer, k), c = toScreen(w.x, w.y);
  ctx.save();
  ctx.globalAlpha = alpha;
  blitSprite(ctx, sprite, tileMatrix(t), cam.scale, c.x, c.y);
  ctx.restore();
}
function drawPlacedTiles(front) {
  tiles.forEach((t, k) => { if ((layerGrid(t.layer).order >= 5) === front) drawPlacedTile(t, k); });
}

function zipConfig(o, item = catalogItem(o)) {
  const z = item?.zip;
  if (!z) return null;
  const c = o.cfg?.zip || {}, end = c.end || z.end;
  const base = zipPlatform(item);
  const span = c.span ?? base.span;
  const across = Math.abs(end[1]) < Math.abs(end[0]) * 0.5;
  return { end, time: c.time ?? z.time, backTime: c.backTime ?? z.backTime, auto: !!c.auto, pauseMove: c.pauseMove ?? 1, pauseReturn: c.pauseReturn ?? 0.5, span, size: across ? [base.thick, span] : [span, base.thick] };
}
function zipPlatform(item) {
  const part = item.parts.find((p) => p.n === 'ZipMoverMovingPart');
  const [w, h] = part?.sz || [96, 384];
  return Math.abs(item.zip.end[1]) < Math.abs(item.zip.end[0]) ? { thick: w, span: h } : { thick: h, span: w };
}
// ---- zip platforms built from grate tiles ----
// A zip mover's platform is a grid of cells around its moving part; the cells
// under the gear are the root, and every other cell hangs off it (connected).
let platformEdit = null;
const STEPS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const zipMovingPart = (item) => item?.parts?.find((p) => p.n === 'ZipMoverMovingPart');
function zipShape(o, item = catalogItem(o)) {
  const z = zipConfig(o, item), mp = zipMovingPart(item);
  if (!z || !mp) return null;
  const c = o.cfg?.zip || {};
  const [w, h] = z.size, n = Math.max(1, Math.round(w / CELL)), m = Math.max(1, Math.round(h / CELL));
  const grid = c.grid || [n % 2 ? 0 : CELL / 2, m % 2 ? 0 : CELL / 2];
  let cells = c.cells;
  if (!cells) {
    cells = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) cells.push(key(Math.round((-w / 2 + CELL / 2 + i * CELL - grid[0]) / CELL), Math.round((-h / 2 + CELL / 2 + j * CELL - grid[1]) / CELL)));
  }
  return { centre: { x: o.x + mp.x, y: o.y + mp.y }, grid, cells: new Set(cells) };
}
function shapeCellCentre(sh, k) {
  const [i, j] = unkey(k);
  return { x: sh.grid[0] + i * CELL, y: sh.grid[1] + j * CELL };
}
function isRootCell(sh, k) {
  const p = shapeCellCentre(sh, k);
  return Math.abs(p.x) <= CELL / 2 && Math.abs(p.y) <= CELL / 2;
}
function attachedCells(sh, cells) {
  const seen = new Set([...cells].filter((k) => isRootCell(sh, k))), stack = [...seen];
  while (stack.length) {
    const [i, j] = unkey(stack.pop());
    for (const [di, dj] of STEPS4) {
      const k = key(i + di, j + dj);
      if (cells.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return seen;
}
// The cells as few rectangles as possible: rows of runs, stacked where they match.
// [centreX, centreY, width, height] from the moving part's centre.
function platformRects(sh) {
  const rows = new Map();
  for (const k of sh.cells) {
    const [i, j] = unkey(k);
    if (!rows.has(j)) rows.set(j, []);
    rows.get(j).push(i);
  }
  const rects = [];
  for (const [j, is] of [...rows].sort((a, b) => a[0] - b[0])) {
    is.sort((a, b) => a - b);
    for (let t = 0; t < is.length;) {
      let u = t;
      while (u + 1 < is.length && is[u + 1] === is[u] + 1) u++;
      const a = is[t], b = is[u], above = rects.find((q) => q.a === a && q.b === b && q.j1 === j - 1);
      if (above) above.j1 = j; else rects.push({ a, b, j0: j, j1: j });
      t = u + 1;
    }
  }
  return rects.map((q) => [sh.grid[0] + ((q.a + q.b) / 2) * CELL, sh.grid[1] + ((q.j0 + q.j1) / 2) * CELL, (q.b - q.a + 1) * CELL, (q.j1 - q.j0 + 1) * CELL]);
}
function platformCellAt(wp) {
  const o = placed[platformEdit], sh = o && zipShape(o);
  if (!sh) return null;
  return { o, sh, k: key(Math.round((wp.x - sh.centre.x - sh.grid[0]) / CELL), Math.round((wp.y - sh.centre.y - sh.grid[1]) / CELL)) };
}
function platformPaint(wp) {
  const hit = platformCellAt(wp);
  if (!hit) return;
  const { o, sh, k } = hit, cells = new Set(sh.cells);
  if (drag.platformMode == null) drag.platformMode = cells.has(k) ? 'erase' : 'paint';
  if (drag.platformMode === 'paint') {
    const [i, j] = unkey(k);
    if (cells.has(k) || !STEPS4.some(([di, dj]) => cells.has(key(i + di, j + dj)))) return;
    cells.add(k);
  } else {
    if (!cells.has(k)) return;
    if (isRootCell(sh, k)) { if (!drag.warned) { drag.warned = true; flash('The root under the gear stays - the rest of the platform hangs off it.'); } return; }
    cells.delete(k);
    const kept = attachedCells(sh, cells);
    for (const c of [...cells]) if (!kept.has(c)) cells.delete(c);
  }
  if (!drag.changed) { drag.changed = true; pushUndoEntry(drag.before); }
  o.cfg = { ...o.cfg, zip: { ...(o.cfg?.zip || {}), grid: sh.grid, cells: [...cells] } };
  saveDraft();
  renderConfig();
  requestDraw();
}
function setPlatformEdit(index) {
  platformEdit = index;
  renderConfig();
  requestDraw();
  if (index != null) flash('Building the platform: drag from empty space to add grate, from grate to remove it');
}
function drawPlatformEdit() {
  const o = placed[platformEdit], sh = o && zipShape(o);
  if (!sh) { platformEdit = null; return; }
  ctx.save();
  ctx.lineWidth = 1;
  for (const k of sh.cells) {
    const p = shapeCellCentre(sh, k), a = toScreen(sh.centre.x + p.x - CELL / 2, sh.centre.y + p.y + CELL / 2), sz = CELL * cam.scale;
    ctx.fillStyle = isRootCell(sh, k) ? 'rgba(65, 248, 141, 0.28)' : 'rgba(94, 200, 240, 0.12)';
    ctx.fillRect(a.x, a.y, sz, sz);
    ctx.strokeStyle = 'rgba(94, 200, 240, 0.55)';
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, sz - 1, sz - 1);
  }
  const hover = hoverWorld && platformCellAt(hoverWorld);
  if (hover) {
    const p = shapeCellCentre(sh, hover.k), a = toScreen(sh.centre.x + p.x - CELL / 2, sh.centre.y + p.y + CELL / 2), sz = CELL * cam.scale;
    ctx.strokeStyle = sh.cells.has(hover.k) ? '#ff6b6b' : COLORS.start;
    ctx.lineWidth = 2;
    ctx.strokeRect(a.x, a.y, sz, sz);
  }
  ctx.restore();
}

function snapZipEnd(dx, dy) {
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const ux = Math.round(Math.cos(a)), uy = Math.round(Math.sin(a));
  const steps = Math.max(0, Math.round((dx * ux + dy * uy) / (CELL * (ux * ux + uy * uy))));
  return [ux * steps * CELL, uy * steps * CELL];
}const ZIP_MOVING = /^(ZipMoverMovingPart|ZipMoverMechanism|ZipMoverGear)/;

function objectParts(o, item = catalogItem(o)) {
  if (!item) return [];
  const cfg = o.cfg || {};
  const T = mul2(rot2(((cfg.rot || 0) * Math.PI) / 180), [(cfg.scale || 1) * (cfg.sx || 1) * (cfg.fx ? -1 : 1), 0, 0, (cfg.scale || 1) * (cfg.sy || 1) * (cfg.fy ? -1 : 1)]);
  const zip = zipConfig(o, item);
  let parts = item.parts;
  if (zip) {
    const [ex, ey] = zip.end, len = Math.hypot(ex, ey) || 1, dx = ex / len, dy = ey / len;
    const a0 = Math.atan2(item.zip.end[1], item.zip.end[0]), turn = rot2(Math.atan2(ey, ex) - a0);
    parts = parts.map((p) => {
      if (p.n === 'ZipTrack') return { ...p, x: ex / 2 + dx * 5, y: ey / 2 + dy * 5, m: mul2(turn, p.m), sz: p.sz && [len + 30, p.sz[1]] };
      if (p.n === 'ZipNode (1)') return { ...p, x: ex - dx * 5, y: ey - dy * 5 };
      if (p.n === 'ZipMoverMovingPart' && p.sz) return { ...p, sz: zip.size };
      return p;
    });
    if (cfg.zip?.cells) {
      const sh = zipShape(o, item);
      parts = parts.flatMap((p) => (p.n === 'ZipMoverMovingPart' ? platformRects(sh).map(([rx, ry, w, h]) => ({ ...p, x: p.x + rx, y: p.y + ry, sz: [w, h] })) : [p]));
    }
  }
  if (item.stretch && cfg.width && cfg.width !== item.stretch.width) {
    parts = parts.map((p, n) => {
      if (n !== 0) return p;
      const [, , w, h] = base.scene.sprites[p.s];
      return { ...p, dm: 2, sz: [cfg.width, p.sz?.[1] ?? h], frames: undefined };
    });
  }
  return parts.map((p) => {
    const q = { ...p, x: T[0] * p.x + T[1] * p.y, y: T[2] * p.x + T[3] * p.y, m: mul2(T, p.m) };
    return q;
  });
}

const HIDDEN_PART = (p) => p.n === 'InactiveSprite' || p.a === 0;
function drawPlacedObject(o, alpha = 1) {
  const item = catalogItem(o);
  if (!item || !sceneReady()) return;
  const zip = zipConfig(o, item);
  const r = objectReach(item) + (zip ? Math.hypot(...zip.end) : 0) + (o.cfg?.trig ? Math.hypot(o.cfg.trig.w, o.cfg.trig.h) + Math.hypot(o.cfg.trig.dx, o.cfg.trig.dy) : 0);
  const tl = toWorld(0, 0), br = toWorld(canvas.width, canvas.height);
  if (o.x + r < tl.x || o.x - r > br.x || o.y + r < br.y || o.y - r > tl.y) return;
  const parts = objectParts(o, item).filter((p) => !HIDDEN_PART(p)).sort((a, b) => a.o - b.o);
  const now = performance.now() / 1000, ghost = alpha !== 1;
  alpha *= o.cfg?.alpha ?? 1;
  let animated = false;
  ctx.save();
  for (const p of parts) {
    if (draft.simulate && zip && !ghost && ZIP_MOVING.test(p.n || '')) continue;
    let sprite = p.s;
    if (p.frames) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; animated = true; }
    blitScene(sprite, p.m, o.x + p.x, o.y + p.y, alpha, p.dm, p.sz, p.c);
  }
  if (zip) {
    for (const p of parts) if (ZIP_MOVING.test(p.n || '')) blitScene(p.s, p.m, o.x + p.x + zip.end[0], o.y + p.y + zip.end[1], 0.35 * alpha, p.dm, p.sz, p.c);
    if (draft.simulate && !ghost) {
      const f = zipTravel(zip, now);
      for (const p of parts) if (ZIP_MOVING.test(p.n || '')) blitScene(p.s, p.m, o.x + p.x + zip.end[0] * f, o.y + p.y + zip.end[1] * f, alpha, p.dm, p.sz, p.c);
      animated = true;
    }
  }
  ctx.restore();
  if (zip && (tool === 'select' || tool === 'object')) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    for (const [x, y, fill] of [[o.x, o.y, COLORS.start], [o.x + zip.end[0], o.y + zip.end[1], COLORS.end]]) {
      const c = toScreen(x, y);
      ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  if (item.upgradeBox) drawBoxTexts(o, alpha);
  if (animated && !animTimer) animTimer = setTimeout(() => { animTimer = 0; requestDraw(); }, 100);
  if (!parts.length || isSizable(item)) {
    const t = trigOf(o, item), cc = isCourseCheckpoint(item), col = isLongFall(item) ? COLORS.fall : isLinked(o.course) ? linkColor(o.course) : cc ? COLORS.courseCheckpoint : COLORS.checkpoint;
    ctx.save();
    ctx.globalAlpha = alpha;
    drawGate(o, { dx: t.dx, dy: t.dy, w: t.w, h: t.h }, col, item.name.toUpperCase() + (isLinked(o.course) ? ' · ' + linkLabel(o.course).toUpperCase() : cc ? ' · ANY COURSE' : ''));
    ctx.restore();
  }
}
// Where along its track (0 start, 1 end) a zip mover is `now` seconds into
// its loop: move, pause, return, pause - as the game plays one on its own.
function zipTravel(zip, now) {
  const go = Math.max(0.05, zip.time), back = Math.max(0.05, zip.backTime);
  const atEnd = Math.max(0, zip.pauseReturn ?? 0.5), atStart = Math.max(0, zip.pauseMove ?? 1), cycle = go + atEnd + back + atStart;
  let t = now % cycle;
  if (t < go) { const x = t / go; return x < 0.75 ? 1.1851852 * x * x * x : 1.1851852 * 0.421875 + 3 * 1.1851852 * 0.5625 * (x - 0.75); }
  t -= go;
  if (t < atEnd) return 1;
  t -= atEnd;
  if (t < back) return 1 - t / back;
  return 0;
}
function objectReach(item) {
  if (item.reach == null) {
    let r = CELL;
    for (const p of item.parts) {
      const [, , w, h] = base.scene.sprites[p.s], [W, H] = p.sz || [w, h];
      r = Math.max(r, Math.hypot(p.x, p.y) + Math.hypot(W, H) * Math.max(Math.hypot(p.m[0], p.m[2]), Math.hypot(p.m[1], p.m[3])) / 2);
    }
    if (item.box) r = Math.max(r, ...item.box.map(Math.abs));
    item.reach = r;
  }
  return item.reach * 1.5;
}

const SPRING_FOOT = 44;
function placementFor(item, cx, cy) {
  const w = cellWorld(cx, cy);
  let at = { x: w.x + CELL / 2, y: w.y + CELL / 2 };
  if (snapV() < CELL && hoverWorld && cellOf(hoverWorld.x, hoverWorld.y).cx === cx && cellOf(hoverWorld.x, hoverWorld.y).cy === cy) at = snapPoint(hoverWorld);
  if (!item?.stretch) return { ...at, ...placementCfg(item) };
  const q = placeRot || (seats(cx, cy)[0] ?? 0), r = rotMatrix(q);
  const up = [r[1], r[3]], lift = SPRING_FOOT * Math.abs(item.parts[0]?.m?.[3] || 1) - CELL / 2;
  return { x: Math.round(at.x + up[0] * lift), y: Math.round(at.y + up[1] * lift), cfg: { rot: q * 90, fx: placeFlip || undefined } };
}
const ARROW_LAYER = 'environmentalObjects_front';
const LT = (n) => 'line_tileset_' + n;
const ARROW_CORNER = { '1,0|0,-1': 16, '-1,0|0,-1': 19, '-1,0|0,1': 58, '1,0|0,1': 55 };
const ARROW_CIRCLE = [[-1, 1, 49], [0, 1, 50], [1, 1, 51], [-1, 0, 62], [0, 0, 63], [1, 0, 64], [-1, -1, 74], [0, -1, 75], [1, -1, 76]];
const ARROW_HEAD_UP = [[-1, 0, 26], [0, 0, 27], [1, 0, 28], [-1, 1, 7], [0, 1, 8], [1, 1, 9]];
const ARROW_HEAD_DOWN = [[-1, 0, 65], [0, 0, 66], [1, 0, 67], [-1, -1, 77], [0, -1, 78], [1, -1, 79]];
const TURN_FROM_RIGHT = { '1,0': 0, '0,1': 1, '-1,0': 2, '0,-1': 3 };
const TURN_FROM_UP = { '0,1': 0, '-1,0': 1, '0,-1': 2, '1,0': 3 };
const turnOffset = (dx, dy, q) => { for (let i = 0; i < q; i++) [dx, dy] = [-dy, dx]; return [dx, dy]; };

function arrowCell(cx, cy) {
  const w = cellWorld(cx, cy), g = layerGrid(ARROW_LAYER);
  return [Math.floor((w.x + CELL / 2 - g.ox) / g.size), Math.floor((w.y + CELL / 2 - g.oy) / g.size)];
}

function arrowTiles(a) {
  const out = new Map(), c = a.cells, n = c.length;
  if (n < 2) return out;
  const put = (gx, gy, tile, q = 0) => out.set(ARROW_LAYER + '|' + gx + ',' + gy, { layer: ARROW_LAYER, tile: LT(tile), m: rotMatrix(q), arrow: a.id });
  const step = (i, j) => [Math.sign(c[j][0] - c[i][0]), Math.sign(c[j][1] - c[i][1])];
  for (let i = 1; i < n - 1; i++) {
    const back = step(i, i - 1), on = step(i, i + 1);
    if (!back[0] === !on[0]) put(...c[i], on[0] ? 18 : 34);
    else {
      const h = back[0] ? back : on, v = back[0] ? on : back;
      put(...c[i], ARROW_CORNER[h.join(',') + '|' + v.join(',')]);
    }
  }
  const q0 = TURN_FROM_RIGHT[step(0, 1).join(',')];
  for (const [dx, dy, t] of ARROW_CIRCLE) { const [ox, oy] = turnOffset(dx, dy, q0); put(c[0][0] + ox, c[0][1] + oy, t, q0); }
  const d = step(n - 2, n - 1), e = c[n - 1];
  if (d[1] === -1) for (const [dx, dy, t] of ARROW_HEAD_DOWN) put(e[0] + dx, e[1] + dy, t);
  else {
    const q = TURN_FROM_UP[d.join(',')];
    for (const [dx, dy, t] of ARROW_HEAD_UP) { const [ox, oy] = turnOffset(dx, dy, q); put(e[0] + ox, e[1] + oy, t, q); }
  }
  return out;
}

function rebuildArrowTiles() {
  for (const [k, t] of tiles) if (t.arrow) tiles.delete(k);
  for (const a of arrows) for (const [k, t] of arrowTiles(a)) tiles.set(k, t);
}

function removeArrow(id) {
  arrows = arrows.filter((a) => a.id !== id);
  rebuildArrowTiles();
}

function arrowDown(cx, cy) {
  if (!base?.art) { drag = null; flash('Import the base map first - arrows use its tiles.', true); return; }
  const g = arrowCell(cx, cy), same = (p) => p && p[0] === g[0] && p[1] === g[1];
  let a = arrows.find((x) => same(x.cells[x.cells.length - 1]));
  if (!a) { a = arrows.find((x) => same(x.cells[0])); if (a) a.cells.reverse(); }
  if (!a) { a = { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cells: [g] }; arrows.push(a); drag.fresh = true; }
  drag.arrow = a;
}

function arrowMove(cx, cy) {
  const a = drag.arrow, g = arrowCell(cx, cy), c = a.cells;
  let changed = false;
  for (let guard = 0; guard < 500; guard++) {
    const last = c[c.length - 1], dx = g[0] - last[0], dy = g[1] - last[1];
    if (!dx && !dy) break;
    const next = Math.abs(dx) >= Math.abs(dy) ? [last[0] + Math.sign(dx), last[1]] : [last[0], last[1] + Math.sign(dy)];
    const prev = c[c.length - 2];
    if (prev && prev[0] === next[0] && prev[1] === next[1]) c.pop();
    else c.push(next);
    changed = true;
  }
  if (!changed) return;
  if (!drag.changed) { drag.changed = true; pushUndoEntry(drag.before); }
  rebuildArrowTiles();
  saveDraft();
}

function arrowUp() {
  const a = drag.arrow;
  if (a.cells.length < 2) {
    arrows = arrows.filter((x) => x !== a);
    if (drag.fresh) flash('Drag across cells to draw a guide arrow: circle where you start, head where you let go.');
  }
  rebuildArrowTiles();
  saveDraft();
  requestDraw();
}

function drawArrowNodes(cx, cy) {
  const g = layerGrid(ARROW_LAYER);
  const dot = (p, r, fill) => {
    const s = toScreen(g.ox + (p[0] + 0.5) * g.size, g.oy + (p[1] + 0.5) * g.size);
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  for (const a of arrows) {
    const c = a.cells;
    for (let i = 1; i < c.length - 1; i++) if (c[i - 1][0] !== c[i + 1][0] && c[i - 1][1] !== c[i + 1][1]) dot(c[i], 4, '#ffd9a8');
    dot(c[0], 6, COLORS.start);
    dot(c[c.length - 1], 6, COLORS.end);
  }
  const h = arrowCell(cx, cy);
  const onEnd = arrows.some((a) => [a.cells[0], a.cells[a.cells.length - 1]].some((p) => p[0] === h[0] && p[1] === h[1]));
  ctx.strokeStyle = onEnd ? COLORS.start : '#ff9a3c';
  ctx.lineWidth = 2;
  const a = toScreen(g.ox + h[0] * g.size, g.oy + (h[1] + 1) * g.size);
  ctx.strokeRect(a.x, a.y, g.size * cam.scale, g.size * cam.scale);
  ctx.restore();
}

function arrowThumb() {
  if (arrowThumb.url) return arrowThumb.url;
  if (!artReady()) return null;
  const S = 32, cv = makeCanvas();
  cv.width = cv.height = 7 * S;
  const gc = cv.getContext('2d');
  for (const [k, t] of arrowTiles({ id: 'thumb', cells: [[1, 1], [2, 1], [3, 1], [4, 1], [4, 2], [4, 3], [4, 4]] })) {
    const [gx, gy] = k.slice(k.indexOf('|') + 1).split(',').map(Number);
    blitSprite(gc, base.art.tiles[t.tile], t.m, 1, (gx + 0.5) * S, (6 - gy + 0.5) * S);
  }
  gc.setTransform(1, 0, 0, 1, 0, 0);
  return (arrowThumb.url = cv.toDataURL());
}

function stampTiles(st, wx, wy, rot = 0, flip = false) {
  const g = layerGrid(st.layer);
  const gx0 = Math.floor((wx - g.ox) / g.size), gy0 = Math.floor((wy - g.oy) / g.size);
  const turn = mul2(rotMatrix(rot), [flip ? -1 : 1, 0, 0, 1]);
  const out = [];
  for (let i = 0; i < st.cells.length; i += 4) {
    let x = st.cells[i], y = st.cells[i + 1];
    if (flip) x = st.w - 1 - x;
    for (let r = 0; r < (rot & 3); r++) [x, y] = [-y + (r % 2 ? st.w : st.h) - 1, x];
    const k = st.layer + '|' + (gx0 + x) + ',' + (gy0 + y);
    out.push([k, { layer: st.layer, tile: st.cells[i + 2], m: mul2(turn, base.mats[st.cells[i + 3]]) }]);
  }
  return out;
}
// ---- the Tiles tab: every tileset's sprites, joined into the pieces they were drawn as ----
const TILESET_NAMES = {
  ground1_tileset: 'Ground', dark_ground_tileset: 'Dark ground', blue_ground_tileset: 'Blue ground', orange_ground_tileset: 'Orange ground',
  gril_tileset: 'Grate', spike_tileset: 'Spikes', 'Spikes Tileset': 'Spike rows', 'TILE V2 Tileset': 'Plate', 'FLOOR V2 Tileset': 'Floor plate',
  Asset_Sheet: 'Props, plates, vines and ice', '@tile': 'Wall panels', '@tile lighter': 'Light wall', broken_beam: 'Broken beams',
  line_tileset: 'Guide lines', 'Line Start': 'Guide line starts', 'Line end': 'Guide line ends', 'Line Corner': 'Guide line corners',
  'OOB areas': 'Out-of-bounds backdrop', '@ BANNER': 'Banner', Fresco: 'Fresco',
};
// Where a tileset's pieces go when the level itself never uses them.
const TILESET_LAYER = {
  ground1_tileset: 'new awesome nikki ground', dark_ground_tileset: 'new awesome nikki ground', gril_tileset: 'new awesome nikki ground',
  blue_ground_tileset: 'blueBlocks', orange_ground_tileset: 'orangeBlocks', spike_tileset: 'Spikes', 'Spikes Tileset': 'Spikes',
  line_tileset: 'environmentalObjects_front', 'OOB areas': 'OOB areas', '@ BANNER': 'Environmental objects', Fresco: 'Environmental objects',
};
let pieceStamps = null;
// The level's decoration stamps, then every tileset piece, as one list the stamp tool places from.
function allStamps() {
  if (!base?.art) return [];
  if (!pieceStamps) {
    pieceStamps = [];
    const layers = new Set((base.art.layers || []).map((l) => l.name));
    for (const [fam, list] of Object.entries(base.art.pieces || {})) {
      for (const p of list) {
        const layer = p.layer && layers.has(p.layer) ? p.layer : TILESET_LAYER[fam] || 'Background';
        const cells = [];
        for (let i = 0; i < p.cells.length; i += 4) cells.push(p.cells[i], p.h - 1 - p.cells[i + 1], p.cells[i + 2], p.cells[i + 3]);
        pieceStamps.push({ fam, layer, name: p.name || (TILESET_NAMES[fam] || fam) + (p.n > 1 ? ` ${p.w}×${p.h}` : ''), label: p.name, w: p.w, h: p.h, cells, n: p.n });
      }
    }
  }
  return [...(base.art.stamps || []), ...pieceStamps];
}
function tileTabItems() {
  const own = base.art.stamps?.length || 0, all = allStamps(), items = [];
  const order = Object.keys(TILESET_NAMES), rank = (f) => (order.includes(f) ? order.indexOf(f) : order.length);
  const fams = [...new Set(all.slice(own).map((st) => st.fam))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const fam of fams) {
    const group = TILESET_NAMES[fam] || prettySprite(fam);
    all.forEach((st, si) => {
      if (si < own || st.fam !== fam) return;
      if (st.n > 1 || st.label) items.push({ tool: 'stamp', si, label: st.label ? `${st.label} ${st.w}×${st.h}` : `${st.w}×${st.h}`, group, thumb: { stamp: si } });
      else items.push({ tool: 'tile', tileLayer: st.layer, tile: st.cells[2], label: prettySprite(st.cells[2].replace(/_/g, ' ')), group, thumb: { art: st.cells[2] } });
    });
  }
  return items;
}

function stampThumb(si) {
  stampThumb.cache ||= new Map();
  if (stampThumb.cache.has(si)) return stampThumb.cache.get(si);
  const st = allStamps()[si], g = layerGrid(st.layer);
  if (!artReady()) return null;
  const cv = makeCanvas(), k = Math.min(1, 96 / (Math.max(st.w, st.h) * g.size));
  cv.width = Math.max(1, Math.ceil(st.w * g.size * k)); cv.height = Math.max(1, Math.ceil(st.h * g.size * k));
  const gc = cv.getContext('2d');
  for (let i = 0; i < st.cells.length; i += 4) {
    const sprite = base.art.tiles[st.cells[i + 2]];
    if (sprite === undefined) continue;
    blitSprite(gc, sprite, base.mats[st.cells[i + 3]], k, (st.cells[i] + 0.5) * g.size * k, cv.height - (st.cells[i + 1] + 0.5) * g.size * k);
  }
  const url = cv.toDataURL();
  stampThumb.cache.set(si, url);
  return url;
}

function objectHit(o, wx, wy) {
  const item = catalogItem(o);
  if (!item) return false;
  const box = objectBox(o, item);
  if (box && wx >= o.x + box[0] && wx <= o.x + box[2] && wy >= o.y + box[1] && wy <= o.y + box[3]) return true;
  return objectParts(o, item).some((p) => {
    const [, , w, h] = base.scene.sprites[p.s];
    const r = (Math.max(w, h) / 2) * Math.max(Math.abs(p.m[0]) + Math.abs(p.m[1]), Math.abs(p.m[2]) + Math.abs(p.m[3]));
    return Math.abs(wx - (o.x + p.x)) <= r && Math.abs(wy - (o.y + p.y)) <= r;
  }) || Math.hypot(wx - o.x, wy - o.y) < CELL;
}
function tileAt(wx, wy) {
  let best = null;
  tiles.forEach((t, k) => {
    if (tileKeyAt(t.layer, wx, wy) !== k) return;
    if (!best || layerGrid(t.layer).order >= layerGrid(best[1].layer).order) best = [k, t];
  });
  return best;
}

let spikePlaceTurn = null;
let placeRot = 0;
let placeFlip = false;
let hoverWorld = null;
let selection = null;
let brush = null;

function worldAt(e) {
  const r = canvas.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}

function itemAt(wx, wy) {
  const t = itemAtAny(wx, wy);
  return t && layerOpen(targetLayer(t)) ? t : null;
}
function itemAtAny(wx, wy) {
  // A trigger zone wins on its edge; inside, anything else there comes first.
  const ti = layerHidden('course') ? -1 : triggerAt(wx, wy), tg = triggers[ti];
  if (tg && (Math.abs(Math.abs(wx - tg.x) - tg.w / 2) * cam.scale < 8 || Math.abs(Math.abs(wy - tg.y) - tg.h / 2) * cam.scale < 8)) return { kind: 'mtrig', index: ti };
  const xi = layerHidden('course') ? -1 : xspawnAt(wx, wy);
  if (xi >= 0) return { kind: 'xspawn', index: xi };
  const top = stack().findLast((e) => (e.kind === 'object' ? objectHit(e.it, wx, wy) : e.kind === 'csprite' ? customSpriteHit(e.it, wx, wy) : e.kind === 'sign' ? Math.abs(wx - e.it.x) <= e.it.w / 2 && Math.abs(wy - e.it.y) <= e.it.h / 2 : Math.abs(wx - e.it.x) <= CELL / 2 && Math.abs(wy - e.it.y) <= CELL / 2));
  if (top) return { kind: top.kind, index: top.index };
  const m = markerAt(wx, wy);
  if (m) return { kind: 'gate', ...m };
  const c = cellOf(wx, wy), k = key(c.cx, c.cy);
  if (spikes.has(k)) return { kind: 'cell', k };
  if (blocks.has(k)) return ownBlocksAt(c.cx, c.cy);
  const mk = mossKeyAt(wx, wy);
  if (mossCells.has(mk)) return ownMossAt(mk);
  const t = tileAt(wx, wy);
  if (t) return { kind: 'tile', key: t[0] };
  const v = vineAt(wx, wy);
  if (v?.own) return { kind: 'cell', k: v.k, vine: true };
  if (baseOn()) {
    const bo = baseObjects.findLast((o) => !removedObjects.has(o.id) && Math.abs(wx - o.x) <= o.w / 2 && Math.abs(wy - o.y) <= o.h / 2);
    if (bo) return { kind: 'base', id: bo.id };
    const bc = baseCellsAt(c.cx, c.cy);
    if (bc) return bc;
    const dt = decoAt(wx, wy);
    if (dt) return dt;
    const sp = sceneSpriteAt(wx, wy);
    if (sp) return { kind: 'scene', id: sp.id };
  }
  if (ti >= 0) return { kind: 'mtrig', index: ti };
  return null;
}
const xspawnAt = (wx, wy) => xspawns.findLastIndex((s) => Math.abs(wx - s.x) <= SPAWN_BOX.w / 2 + 4 && Math.abs(wy - (s.y + SPAWN_BOX.dy)) <= SPAWN_BOX.h / 2 + 4);

const BLOCK_NAMES = { ground: 'Ground', dark: 'Dark ground', blue: 'Blue blocks', orange: 'Orange blocks' };
function floodKeys(start, has) {
  const seen = new Set([start]), stack = [start];
  while (stack.length && seen.size <= 2000) {
    const [x, y] = unkey(stack.pop());
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(x + dx, y + dy);
      if (!seen.has(k) && has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return [...seen];
}
function ownBlocksAt(cx, cy) {
  const kind = blocks.get(key(cx, cy));
  return { kind: 'blocks', what: blockName(kind), cells: floodKeys(key(cx, cy), (k) => blocks.get(k) === kind) };
}
function ownMossAt(mk) {
  return { kind: 'moss', what: 'Moss', cells: floodKeys(mk, (k) => mossCells.has(k)) };
}
function outlineCells(cells, rectOf) {
  const set = new Set(cells);
  ctx.beginPath();
  for (const k of cells) {
    const [x, y] = unkey(k), r = rectOf(x, y);
    if (!set.has(key(x, y + 1))) { ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + r.w, r.y); }
    if (!set.has(key(x, y - 1))) { ctx.moveTo(r.x, r.y + r.h); ctx.lineTo(r.x + r.w, r.y + r.h); }
    if (!set.has(key(x - 1, y))) { ctx.moveTo(r.x, r.y); ctx.lineTo(r.x, r.y + r.h); }
    if (!set.has(key(x + 1, y))) { ctx.moveTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + r.h); }
  }
  ctx.stroke();
}
function mossRect(gx, gy) {
  const g = layerGrid('moss'), a = toScreen(g.ox + gx * g.size, g.oy + (gy + 1) * g.size);
  return { x: a.x, y: a.y, w: g.size * cam.scale, h: g.size * cam.scale };
}
function moveCells(sel, dx, dy) {
  if (sel.kind === 'blocks') {
    const moving = sel.cells.map((k) => [k, blocks.get(k)]).filter(([, v]) => v);
    for (const [k] of moving) blocks.delete(k);
    sel.cells = moving.map(([k, v]) => { const [x, y] = unkey(k), nk = key(x + dx, y + dy); blocks.set(nk, v); spikes.delete(nk); return nk; });
  } else if (sel.kind === 'moss') {
    const moving = sel.cells.filter((k) => mossCells.has(k));
    for (const k of moving) mossCells.delete(k);
    sel.cells = moving.map((k) => { const [x, y] = unkey(k), nk = key(x + dx, y + dy); mossCells.set(nk, true); return nk; });
  }
}

const DECO_LAYERS = ['environmentalObjects_front', 'Environmental objects', 'Environmental objects_back'];
let decoCache = null;
function decoCells(name) {
  if (!decoCache || decoCache.state !== draft.baseState) decoCache = { state: draft.baseState, maps: new Map() };
  let m = decoCache.maps.get(name);
  if (!m) {
    m = new Set();
    for (const l of base.art.layers) {
      if (l.name !== name || (l.state !== 'always' && l.state !== draft.baseState)) continue;
      for (let i = 0; i < l.runs.length; i += 5) for (let n = 0; n < l.runs[i + 2]; n++) m.add((l.runs[i + 1] + n) + ',' + l.runs[i]);
    }
    decoCache.maps.set(name, m);
  }
  return m;
}
function decoAt(wx, wy) {
  if (!base?.art) return null;
  for (const name of DECO_LAYERS) {
    const g = layerGrid(name), cells = decoCells(name);
    const k0 = Math.floor((wx - g.ox) / g.size) + ',' + Math.floor((wy - g.oy) / g.size);
    if (!cells.has(k0) || removedDeco.has(name + '|' + k0)) continue;
    const seen = new Set([k0]), stack = [k0];
    while (stack.length && seen.size <= 800) {
      const [x, y] = unkey(stack.pop());
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = key(x + dx, y + dy);
        if (!seen.has(k) && cells.has(k) && !removedDeco.has(name + '|' + k)) { seen.add(k); stack.push(k); }
      }
    }
    return { kind: 'decotiles', layer: name, cells: seen.size > 800 ? [k0] : [...seen] };
  }
  return null;
}

// Moss first: it grows over the ground's edge cells, and a click there means the moss.
const BASE_SETS = () => [['Moss', mossSet], ['Ground', groundSet], ['Blue blocks', blueSet], ['Orange blocks', orangeSet]];
function baseCellsAt(cx, cy) {
  const k0 = key(cx, cy);
  if (removed.has(k0)) return null;
  const h = baseHaz.get(k0);
  if (h && h.kind !== 'vine') return { kind: 'basecells', cells: [k0], what: 'Spike' };
  const hit = BASE_SETS().find(([, set]) => set?.has(k0));
  if (!hit) return null;
  // The patch around the click, spreading outward (moss counts corners too), up to a bunch's worth:
  // the level's moss and ground are mostly one connected mass.
  const [what, set] = hit, seen = new Set([k0]), queue = [[cx, cy]], LIMIT = what === 'Moss' ? 160 : 600;
  const around = what === 'Moss' ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let qi = 0; qi < queue.length && seen.size < LIMIT; qi++) {
    const [x, y] = queue[qi];
    for (const [dx, dy] of around) {
      const k = key(x + dx, y + dy);
      if (seen.has(k) || !set.has(k) || removed.has(k)) continue;
      seen.add(k);
      queue.push([x + dx, y + dy]);
      if (seen.size >= LIMIT) break;
    }
  }
  return { kind: 'basecells', cells: [...seen], what };
}

function objectBounds(o) {
  const item = catalogItem(o);
  if (!item) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const all = objectParts(o, item), shown = all.filter((p) => !HIDDEN_PART(p));
  for (const p of shown) {
    const [, , w, h, pvx, pvy] = base.scene.sprites[p.s], W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h;
    for (const [lx, ly] of [[-pvx * W, -pvy * H], [(1 - pvx) * W, -pvy * H], [-pvx * W, (1 - pvy) * H], [(1 - pvx) * W, (1 - pvy) * H]]) {
      const x = o.x + p.x + p.m[0] * lx + p.m[1] * ly, y = o.y + p.y + p.m[2] * lx + p.m[3] * ly;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  if (!shown.length || !Number.isFinite(x0)) {
    const b = objectBox(o, item) || [-CELL / 2, -CELL / 2, CELL / 2, CELL / 2];
    return { x0: o.x + b[0], y0: o.y + b[1], x1: o.x + b[2], y1: o.y + b[3] };
  }
  return { x0, y0, x1, y1 };
}


function drawTarget(t) {
  const rectW = (x0, y0, x1, y1) => { const a = toScreen(x0, y1), b = toScreen(x1, y0); ctx.strokeRect(a.x - 2, a.y - 2, b.x - a.x + 4, b.y - a.y + 4); };
  if (t.kind === 'object') { const b = placed[t.index] && objectBounds(placed[t.index]); if (b) rectW(b.x0, b.y0, b.x1, b.y1); }
  else if (t.kind === 'fspike') { const f = freeSpikes[t.index], r = (CELL / 2) * (f?.s || 1) * (f?.r ? Math.SQRT2 : 1); if (f) rectW(f.x - r, f.y - r, f.x + r, f.y + r); }
  else if (t.kind === 'sign') { const sg = signs[t.index]; if (sg) rectW(sg.x - sg.w / 2, sg.y - sg.h / 2, sg.x + sg.w / 2, sg.y + sg.h / 2); }
  else if (t.kind === 'csprite') { const cs = csprites[t.index], b = cs && customSpriteSize(cs); if (b) rectW(cs.x - b.w / 2, cs.y - b.h / 2, cs.x + b.w / 2, cs.y + b.h / 2); }
  else if (t.kind === 'xspawn') { const s = xspawns[t.index]; if (s) rectW(s.x - SPAWN_BOX.w / 2, s.y + SPAWN_BOX.dy - SPAWN_BOX.h / 2, s.x + SPAWN_BOX.w / 2, s.y + SPAWN_BOX.dy + SPAWN_BOX.h / 2); }
  else if (t.kind === 'mtrig') { const tg = triggers[t.index]; if (tg) rectW(tg.x - tg.w / 2, tg.y - tg.h / 2, tg.x + tg.w / 2, tg.y + tg.h / 2); }
  else if (t.kind === 'gate') {
    const g = markerPos(t), b = MARKER_BOX[t.which];
    if (g) rectW(g.x + b.dx - Math.max(b.w, CELL) / 2, g.y + b.dy - Math.max(b.h, CELL) / 2, g.x + b.dx + Math.max(b.w, CELL) / 2, g.y + b.dy + Math.max(b.h, CELL) / 2);
  } else if (t.kind === 'tile') {
    const tl = tiles.get(t.key);
    if (tl) { const g = layerGrid(tl.layer), c = tileCenter(tl.layer, t.key); rectW(c.x - g.size / 2, c.y - g.size / 2, c.x + g.size / 2, c.y + g.size / 2); }
  } else if (t.kind === 'cell') {
    if (t.vine) { const v = vines.get(t.k), img = v && vineImage(v.s), [cx, cy] = unkey(t.k), w = cellWorld(cx, cy), r = Math.max(img?.naturalWidth || 96, img?.naturalHeight || 96) / 2; rectW(w.x + CELL / 2 - r, w.y + CELL / 2 - r, w.x + CELL / 2 + r, w.y + CELL / 2 + r); }
    else { const [cx, cy] = unkey(t.k), w = cellWorld(cx, cy); rectW(w.x, w.y, w.x + CELL, w.y + CELL); }
  } else if (t.kind === 'base') {
    const o = baseObjects.find((x) => x.id === t.id);
    if (o) rectW(o.x - o.w / 2, o.y - o.h / 2, o.x + o.w / 2, o.y + o.h / 2);
  } else if (t.kind === 'blocks') {
    outlineCells(t.cells, cellRect);
  } else if (t.kind === 'moss') {
    outlineCells(t.cells, mossRect);
  } else if (t.kind === 'decotiles') {
    const g = layerGrid(t.layer);
    outlineCells(t.cells, (x, y) => { const a = toScreen(g.ox + x * g.size, g.oy + (y + 1) * g.size); return { x: a.x, y: a.y, w: g.size * cam.scale, h: g.size * cam.scale }; });
  } else if (t.kind === 'basecells') {
    const set = new Set(t.cells);
    ctx.beginPath();
    for (const k of t.cells) {
      const [cx, cy] = unkey(k), r = cellRect(cx, cy);
      if (!set.has(key(cx, cy + 1))) { ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + r.w, r.y); }
      if (!set.has(key(cx, cy - 1))) { ctx.moveTo(r.x, r.y + r.h); ctx.lineTo(r.x + r.w, r.y + r.h); }
      if (!set.has(key(cx - 1, cy))) { ctx.moveTo(r.x, r.y); ctx.lineTo(r.x, r.y + r.h); }
      if (!set.has(key(cx + 1, cy))) { ctx.moveTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + r.h); }
    }
    ctx.stroke();
  } else if (t.kind === 'scene') {
    const p = sceneList?.items.find((x) => x.id === t.id);
    if (!p) return;
    const [, , w, h, pvx, pvy] = base.scene.sprites[p.s], W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h;
    ctx.beginPath();
    [[-pvx * W, -pvy * H], [(1 - pvx) * W, -pvy * H], [(1 - pvx) * W, (1 - pvy) * H], [-pvx * W, (1 - pvy) * H]].forEach(([lx, ly], i) => {
      const s2 = toScreen(p.x + p.m[0] * lx + p.m[1] * ly, p.y + p.m[2] * lx + p.m[3] * ly);
      if (i) ctx.lineTo(s2.x, s2.y); else ctx.moveTo(s2.x, s2.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}

function zipHandle(o) {
  const z = zipConfig(o);
  return z ? { x: o.x + z.end[0], y: o.y + z.end[1] } : null;
}

// Pressing on what's already selected picks it up to drag, whatever tool is active.
function grabsSelection(wp) {
  const targets = targetsOf(selection);
  if (!targets.length) return false;
  const c = cellOf(wp.x, wp.y);
  if (targets.some((t) => t.kind === 'region' && c.cx >= t.x0 && c.cx <= t.x1 && c.cy >= t.y0 && c.cy <= t.y1)) return true;
  const hit = itemAt(wp.x, wp.y);
  return !!hit && targets.some((t) => sameTarget(t, hit));
}

// A selected trigger zone's or checkpoint's box, in world units, to size by its edges.
function sizableBox() {
  if (selection?.kind === 'mtrig') { const t = triggers[selection.index]; return t ? { x0: t.x - t.w / 2, y0: t.y - t.h / 2, x1: t.x + t.w / 2, y1: t.y + t.h / 2 } : null; }
  if (selection?.kind === 'object') {
    const o = placed[selection.index], item = o && catalogItem(o);
    if (!isSizable(item)) return null;
    const t = trigOf(o, item);
    return { x0: o.x + t.dx - t.w / 2, y0: o.y + t.dy - t.h / 2, x1: o.x + t.dx + t.w / 2, y1: o.y + t.dy + t.h / 2 };
  }
  return null;
}
function edgesAt(w) {
  const b = sizableBox();
  if (!b) return null;
  const near = 7 / cam.scale, inX = w.x > b.x0 - near && w.x < b.x1 + near, inY = w.y > b.y0 - near && w.y < b.y1 + near;
  const e = { l: inY && Math.abs(w.x - b.x0) < near, r: inY && Math.abs(w.x - b.x1) < near, b: inX && Math.abs(w.y - b.y0) < near, t: inX && Math.abs(w.y - b.y1) < near };
  return e.l || e.r || e.b || e.t ? { ...e, box: b } : null;
}
function edgeCursor(e) {
  if (!e) return '';
  if ((e.l && e.t) || (e.r && e.b)) return 'nwse-resize';
  if ((e.r && e.t) || (e.l && e.b)) return 'nesw-resize';
  return e.l || e.r ? 'ew-resize' : 'ns-resize';
}
function resizeMove(e) {
  const w = worldAt(e), snap = e.shiftKey ? 1 : snapV(), d = drag.resize, b = { ...d.box };
  const sx = Math.round((w.x - drag.start.x) / snap) * snap, sy = Math.round((w.y - drag.start.y) / snap) * snap;
  if (d.l) b.x0 = Math.min(b.x1 - 16, b.x0 + sx);
  if (d.r) b.x1 = Math.max(b.x0 + 16, b.x1 + sx);
  if (d.b) b.y0 = Math.min(b.y1 - 16, b.y0 + sy);
  if (d.t) b.y1 = Math.max(b.y0 + 16, b.y1 + sy);
  const sig = [b.x0, b.y0, b.x1, b.y1].join(',');
  if (sig === drag.sig) return;
  drag.sig = sig;
  if (!drag.changed) { drag.changed = true; pushUndoEntry(drag.before); }
  const w2 = b.x1 - b.x0, h2 = b.y1 - b.y0, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  if (selection.kind === 'mtrig') Object.assign(triggers[selection.index], { x: cx, y: cy, w: w2, h: h2 });
  else { const o = placed[selection.index]; o.cfg = { ...o.cfg, trig: { w: w2, h: h2, dx: cx - o.x, dy: cy - o.y } }; }
  requestDraw();
}

function selectDown(e) {
  const w = worldAt(e);
  const edges = edgesAt(w);
  if (edges) {
    drag = { pan: false, resize: edges, start: w, before: snapshot(), changed: false };
    return;
  }
  const sel = selection?.kind === 'object' ? placed[selection.index] : null;
  const h = sel && zipHandle(sel);
  if (h && Math.hypot(w.x - h.x, w.y - h.y) * cam.scale < 12) {
    drag = { pan: false, zip: true, before: snapshot(), changed: false };
    return;
  }
  const hit = itemAt(w.x, w.y);
  if (hit && e.shiftKey) {
    toggleInSelection(hit);
    drag = null;
    renderConfig();
    requestDraw();
    return;
  }
  if (grabsSelection(w)) {
    drag = { pan: false, moveSel: true, start: w, before: snapshot(), selOrig: JSON.stringify(selection), changed: false };
    requestDraw();
    return;
  }
  if (hit) {
    selection = hit;
    showInDropdown(hit);
    if (hit.kind === 'gate' && hit.course) draft.activeCourse = hit.course;
    drag = { pan: false, moveSel: true, selOrig: JSON.stringify(hit), move: false, gate: hit.kind === 'gate' ? hit : null, group: hit.kind === 'blocks' || hit.kind === 'moss' ? { at: hit.kind === 'moss' ? mossKeyAt(w.x, w.y) : key(cellOf(w.x, w.y).cx, cellOf(w.x, w.y).cy) } : null, fspike: hit.kind === 'fspike', sign: hit.kind === 'sign', start: w, orig: hit.kind === 'object' ? { x: placed[hit.index].x, y: placed[hit.index].y } : hit.kind === 'fspike' ? { x: freeSpikes[hit.index].x, y: freeSpikes[hit.index].y } : hit.kind === 'sign' ? { x: signs[hit.index].x, y: signs[hit.index].y } : hit.kind === 'gate' && hit.which === 'screen' ? { ...markerPos(hit) } : null, before: snapshot(), changed: false };
  } else {
    const c = cellOf(w.x, w.y);
    const keep = e.shiftKey ? targetsOf(selection) : [];
    if (!e.shiftKey) selection = null;
    drag = { pan: false, region: c, keep };
  }
  renderConfig();
  requestDraw();
}

function selectMove(e) {
  const w = worldAt(e);
  if (drag.moveSel) {
    // Rebuilt from the drag's start every time, so whatever the moving things
    // pass over is only covered, never lost.
    const dx = w.x - drag.start.x, dy = w.y - drag.start.y, fine = e.shiftKey, snap = fine ? 1 : snapV();
    const cx = Math.round(dx / CELL), cy = Math.round(dy / CELL);
    const sig = [Math.round(dx / snap), Math.round(dy / snap), cx, cy].join(',');
    if (sig === (drag.sig ?? '0,0,0,0')) return;
    drag.sig = sig;
    if (!drag.changed) { drag.changed = true; pushUndoEntry(drag.before); }
    restoreDragStart(drag);
    selection = JSON.parse(drag.selOrig);
    moveTargets(targetsOf(selection), dx, dy, cx, cy, fine);
    requestDraw();
    return;
  }
  if (drag.region) {
    const c = cellOf(w.x, w.y);
    if (c.cx !== drag.region.cx || c.cy !== drag.region.cy) drag.regionMoved = true;
    if (!drag.regionMoved) return;
    const r = { x0: Math.min(drag.region.cx, c.cx), y0: Math.min(drag.region.cy, c.cy), x1: Math.max(drag.region.cx, c.cx), y1: Math.max(drag.region.cy, c.cy) };
    const add = marqueeTargets(r).filter((t) => !drag.keep.some((k) => sameTarget(k, t)));
    setSelection([...drag.keep, ...add]);
    renderConfig();
  } else if (drag.group) {
    const now = selection.kind === 'moss' ? mossKeyAt(w.x, w.y) : key(cellOf(w.x, w.y).cx, cellOf(w.x, w.y).cy);
    if (now !== drag.group.at) {
      const [ax, ay] = unkey(drag.group.at), [bx, by] = unkey(now);
      changed(() => moveCells(selection, bx - ax, by - ay));
      drag.group.at = now;
    }
  } else if (drag.sign) {
    const sg = signs[selection.index], snap = e.shiftKey ? 1 : snapV();
    const x = drag.orig.x + Math.round((w.x - drag.start.x) / snap) * snap, y = drag.orig.y + Math.round((w.y - drag.start.y) / snap) * snap;
    if (sg && (sg.x !== x || sg.y !== y)) changed(() => { sg.x = x; sg.y = y; });
  } else if (drag.fspike) {
    const f = freeSpikes[selection.index], snap = e.shiftKey ? 1 : snapV();
    const x = Math.round((drag.orig.x + w.x - drag.start.x) / snap) * snap, y = drag.orig.y + Math.round((w.y - drag.start.y) / snap) * snap;
    if (f && (f.x !== x || f.y !== y)) changed(() => { f.x = x; f.y = y; });
  } else if (drag.gate && drag.gate.which === 'screen') {
    const course = courseById(drag.gate.course), snap = e.shiftKey ? 1 : snapV();
    const at = { x: Math.round((drag.orig.x + w.x - drag.start.x) / snap) * snap, y: Math.round((drag.orig.y + w.y - drag.start.y) / snap) * snap };
    if (course && (course.screen?.x !== at.x || course.screen?.y !== at.y)) changed(() => { course.screen = at; });
  } else if (drag.gate) {
    const c = cellOf(w.x, w.y), which = drag.gate.which, g = gateAt(c.cx, c.cy, which);
    const cur = which === 'spawn' ? draft.spawn : courseById(drag.gate.course)?.[which];
    if (cur && (cur.x !== g.x || cur.y !== g.y)) changed(() => { if (which === 'spawn') draft.spawn = g; else courseById(drag.gate.course)[which] = g; });
  } else if (drag.move) {
    const o = placed[selection.index];
    let mx = w.x - drag.start.x, my = w.y - drag.start.y;
    if (!e.shiftKey) { mx = Math.round(mx / snapV()) * snapV(); my = Math.round(my / snapV()) * snapV(); }
    const nx = Math.round(drag.orig.x + mx), ny = Math.round(drag.orig.y + my);
    if (nx !== o.x || ny !== o.y) changed(() => { o.x = nx; o.y = ny; });
  } else if (drag.zip) {
    const o = placed[selection.index];
    const end = snapZipEnd(w.x - o.x, w.y - o.y), cur = zipConfig(o).end;
    if ((end[0] || end[1]) && (end[0] !== cur[0] || end[1] !== cur[1])) changed(() => { o.cfg = { ...o.cfg, zip: { ...o.cfg?.zip, end } }; });
  }
  requestDraw();
}

function zipPlaceMove(e) {
  const o = placed[drag.zipPlace], w = worldAt(e);
  const end = snapZipEnd(w.x - o.x, w.y - o.y);
  if (!end[0] && !end[1]) return;
  o.cfg = { ...o.cfg, zip: { ...o.cfg?.zip, end } };
  saveDraft();
  requestDraw();
}

function changed(fn) {
  if (!drag.changed) { drag.changed = true; pushUndoEntry(drag.before); }
  fn();
  saveDraft();
  renderConfig();
}

function placementCfg(item) {
  if (!item || (!placeRot && !placeFlip)) return {};
  if (item.zip) {
    const [ex, ey] = item.zip.end, r = rotMatrix(placeRot);
    return { cfg: { zip: { end: [r[0] * ex + r[1] * ey, r[2] * ex + r[3] * ey] } } };
  }
  return { cfg: { rot: placeRot * 90, fx: placeFlip || undefined } };
}

const PLACING = ['object', 'decor', 'stamp', 'vine'];
function turnSomething(dir, flip = false) {
  let target = tool === 'select' ? selection : null;
  if (target?.kind === 'region' || (target?.kind === 'multi' && target.items.some((t) => t.kind === 'region'))) return transformRegion(flip ? 'x' : 'r');
  if (selection?.kind === 'fspike' && !flip) {
    const f = freeSpikes[selection.index];
    if (f) { pushUndo(); f.q = ((f.q ?? 0) + (dir < 0 ? 1 : 3)) % 4; saveDraft(); renderConfig(); requestDraw(); }
    return;
  }
  const tfs = targetsOf(target).filter((t) => t.kind === 'csprite' || t.kind === 'sign' || t.kind === 'fspike');
  if (tfs.length && !flip) { tfTurn(tfs, dir < 0 ? 90 : -90); return; }
  if (tfs.length && flip) { pushUndo(); for (const t of tfs) if (tfFields(t).includes('flip')) tfSet(t, 'fx', !tfGet(t).fx); saveDraft(); renderConfig(); requestDraw(); return; }
  if (SPIKE_KIND[tool] && !flip) {
    const w = hover && cellWorld(hover.cx, hover.cy), under = w && itemAt(w.x + CELL / 2, w.y + CELL / 2);
    if (!under || under.kind !== 'cell' || !spikes.has(under.k)) {
      const order = [null, 0, 1, 2, 3], i = order.indexOf(spikePlaceTurn);
      spikePlaceTurn = order[(i + (dir < 0 ? order.length - 1 : 1)) % order.length];
      flash(spikePlaceTurn === null ? 'Spikes: seat on the surface they touch' : `Spikes: always ${['up', 'left', 'down', 'right'][spikePlaceTurn]}`);
      requestDraw();
      return;
    }
  }
  if (!target && PLACING.includes(tool)) {
    if (flip) placeFlip = !placeFlip;
    else placeRot = (placeRot + dir + 4) & 3;
    flash(`Placing at ${placeRot * 90}°${placeFlip ? ', mirrored' : ''}`);
    requestDraw();
    return;
  }
  if (!target && hover) { const w = cellWorld(hover.cx, hover.cy); target = itemAt(w.x + CELL / 2, w.y + CELL / 2); }
  if (!target) return;
  if (target.kind === 'cell' && !flip) {
    const [cx, cy] = unkey(target.k);
    const keep = hover;
    hover = { cx, cy };
    rotateSpikeAtHover();
    hover = keep;
    return;
  }
  pushUndo();
  if (target.kind === 'object') {
    const o = placed[target.index], item = catalogItem(o), cfg = { ...(o.cfg || {}) };
    if (item?.zip && !flip) {
      const z = zipConfig(o, item), r = rotMatrix(dir);
      cfg.zip = { ...cfg.zip, end: [Math.round(r[0] * z.end[0] + r[1] * z.end[1]), Math.round(r[2] * z.end[0] + r[3] * z.end[1])] };
    } else if (flip) cfg.fx = !cfg.fx;
    else cfg.rot = (((cfg.rot || 0) + dir * 90) % 360 + 360) % 360;
    o.cfg = cfg;
  } else if (target.kind === 'tile') {
    const t = tiles.get(target.key);
    tiles.set(target.key, flip ? { ...t, m: undefined, fx: !t.fx } : { ...t, m: undefined, q: (((t.q || 0) + dir) % 4 + 4) % 4 });
  }
  saveDraft();
  renderConfig();
  requestDraw();
}

// Moves one selected thing: dx, dy in cells for cell content and markers, in
// snap steps for placed things. False for the level's own things (they can't move).
function shiftTarget(sel, dx, dy, fine) {
  const shiftKey = (k) => { const [x, y] = unkey(k); return key(x + dx, y + dy); };
  const moveArrow = (id) => { const a = arrows.find((x) => x.id === id); if (a) a.cells = a.cells.map(([x, y]) => [x + dx, y + dy]); };
  if (sel.kind === 'object') {
    const o = placed[sel.index], step = fine ? 1 : snapV();
    o.x += dx * step; o.y += dy * step;
  } else if (sel.kind === 'tile') {
    const t = tiles.get(sel.key);
    if (!t) return false;
    const g = layerGrid(t.layer), c = tileCenter(t.layer, sel.key);
    const nk = tileKeyAt(t.layer, c.x + dx * g.size, c.y + dy * g.size);
    if (t.arrow) { moveArrow(t.arrow); rebuildArrowTiles(); } else { tiles.delete(sel.key); tiles.set(nk, t); }
    sel.key = nk;
  } else if (sel.kind === 'cell') {
    const nk = shiftKey(sel.k);
    for (const m of sel.vine ? [vines] : [blocks, spikes]) if (m.has(sel.k)) { const v = m.get(sel.k); m.delete(sel.k); m.set(nk, v); }
    sel.k = nk;
  } else if (sel.kind === 'blocks' || sel.kind === 'moss') {
    moveCells(sel, dx, dy);
  } else if (sel.kind === 'base' || sel.kind === 'scene') {
    const step = fine ? 1 : snapV();
    return moveLevelThing(sel, dx * step, dy * step);
  } else if (sel.kind === 'basecells') {
    return false;
  } else if (sel.kind === 'sign') {
    const sg = signs[sel.index], step = fine ? 1 : snapV();
    if (!sg) return false;
    sg.x += dx * step; sg.y += dy * step;
  } else if (sel.kind === 'fspike') {
    const f = freeSpikes[sel.index], step = fine ? 1 : snapV();
    if (!f) return false;
    f.x += dx * step; f.y += dy * step;
  } else if (sel.kind === 'gate') {
    const g = markerPos(sel);
    if (!g) return false;
    const moved = { ...g, x: g.x + dx * CELL, y: g.y + dy * CELL };
    if (sel.which === 'spawn') draft.spawn = moved; else courseById(sel.course)[sel.which] = moved;
  } else {
    const inR = (cx, cy) => cx >= sel.x0 && cx <= sel.x1 && cy >= sel.y0 && cy <= sel.y1;
    for (const m of [blocks, spikes, vines]) {
      const moving = [...m].filter(([k]) => inR(...unkey(k)));
      for (const [k] of moving) m.delete(k);
      for (const [k, v] of moving) m.set(shiftKey(k), v);
    }
    if (!sel.cellsOnly) for (const o of placed) { const c = cellOf(o.x, o.y); if (inR(c.cx, c.cy)) { o.x += dx * CELL; o.y += dy * CELL; } }
    const ids = new Set(), movingTiles = [];
    for (const [k, t] of tiles) {
      const c = tileCenter(t.layer, k), cc = cellOf(c.x, c.y);
      if (!inR(cc.cx, cc.cy)) continue;
      if (t.arrow) ids.add(t.arrow);
      else if (layerGrid(t.layer).size === CELL) movingTiles.push([k, t, c]);
    }
    for (const [k] of movingTiles) tiles.delete(k);
    for (const [, t, c] of movingTiles) tiles.set(tileKeyAt(t.layer, c.x + dx * CELL, c.y + dy * CELL), t);
    ids.forEach(moveArrow);
    if (ids.size) rebuildArrowTiles();
    const shiftG = (m) => { if (!m) return m; const c = cellOf(m.x, m.y); return inR(c.cx, c.cy) ? { ...m, x: m.x + dx * CELL, y: m.y + dy * CELL } : m; };
    if (!sel.cellsOnly) {
      draft.spawn = shiftG(draft.spawn);
      for (const c of courses()) { c.start = shiftG(c.start); c.end = shiftG(c.end); }
    }
    Object.assign(sel, { x0: sel.x0 + dx, x1: sel.x1 + dx, y0: sel.y0 + dy, y1: sel.y1 + dy });
  }
  return true;
}

// ---- the selection: one thing, or several of any kinds ('multi') ----
const targetsOf = (sel) => (!sel ? [] : sel.kind === 'multi' ? sel.items : [sel]);
const WORLD_KINDS = new Set(['object', 'fspike', 'sign', 'mtrig', 'csprite', 'xspawn']);
const STACKABLE = new Set(['object', 'fspike', 'sign', 'csprite', 'base', 'scene']);
const listOfKind = (kind) => ({ object: placed, fspike: freeSpikes, sign: signs, mtrig: triggers, csprite: csprites, xspawn: xspawns })[kind];
function sameTarget(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (WORLD_KINDS.has(a.kind)) return a.index === b.index;
  if (a.kind === 'gate') return a.which === b.which && a.course === b.course;
  if (a.kind === 'region') return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
  if (a.kind === 'cell') return a.k === b.k && !!a.vine === !!b.vine;
  if (a.kind === 'tile') return a.key === b.key;
  if (a.kind === 'base' || a.kind === 'scene') return a.id === b.id;
  return JSON.stringify(a.cells) === JSON.stringify(b.cells);
}
function setSelection(items) {
  selection = !items.length ? null : items.length === 1 ? items[0] : { kind: 'multi', items };
}
function toggleInSelection(t) {
  const items = targetsOf(selection);
  const at = items.findIndex((x) => sameTarget(x, t));
  setSelection(at >= 0 ? items.filter((_, i) => i !== at) : [...items, t]);
}
// Moves every selected thing: placed things by the world offset (snapped),
// cell content and markers by whole cells. Returns false if nothing could move.
function moveTargets(targets, wx, wy, cx, cy, fine) {
  const snap = fine ? 1 : snapV(), sx = Math.round(wx / snap) * snap, sy = Math.round(wy / snap) * snap;
  let moved = false, fixed = false;
  for (const t of targets) {
    if (WORLD_KINDS.has(t.kind)) {
      const it = listOfKind(t.kind)[t.index];
      if (it) { it.x += sx; it.y += sy; moved = moved || sx !== 0 || sy !== 0; }
    } else if (t.kind === 'gate' && t.which === 'screen') {
      const c = courseById(t.course), at = courseScreen(c);
      if (c && at) { c.screen = { x: at.x + sx, y: at.y + sy }; moved = true; }
    } else if (t.kind === 'base' || t.kind === 'scene') {
      if (sx || sy) { moveLevelThing(t, sx, sy); moved = true; }
    } else if (t.kind === 'moss') {
      const g = layerGrid('moss').size, mx = Math.round((cx * CELL) / g), my = Math.round((cy * CELL) / g);
      if (mx || my) { moveCells(t, mx, my); moved = true; }
    } else if (cx || cy) {
      if (shiftTarget(t, cx, cy, fine)) moved = true; else fixed = true;
    }
  }
  if (fixed) flash('The level\'s own ground stays put - erase it and place your own blocks.');
  return moved;
}
function nudgeSelection(dx, dy, fine) {
  const targets = targetsOf(selection);
  if (!targets.length) return false;
  pushUndo();
  const step = fine ? 1 : snapV();
  const moved = moveTargets(targets, dx * step, dy * step, dx, dy, fine);
  if (!moved) popUndo();
  saveDraft();
  renderConfig();
  requestDraw();
  return moved;
}
// Everything a dragged-out box covers: the placed things and markers whose
// centre is inside, and the cells (for their content and region tools).
function marqueeTargets(r) {
  const a = cellWorld(r.x0, r.y0), b = cellWorld(r.x1 + 1, r.y1 + 1);
  const inside = (p) => p && p.x >= a.x && p.x < b.x && p.y >= a.y && p.y < b.y;
  const out = [];
  for (const e of stack()) if (inside(e.it) && layerOpen(targetLayer({ kind: e.kind, index: e.index }))) out.push({ kind: e.kind, index: e.index });
  if (layerOpen('course')) triggers.forEach((t, i) => { if (inside(t)) out.push({ kind: 'mtrig', index: i }); });
  if (layerOpen('course')) xspawns.forEach((t, i) => { if (inside(t)) out.push({ kind: 'xspawn', index: i }); });
  if (layerOpen('tiles')) tiles.forEach((t, k) => { if (!t.arrow && inside(tileCenter(t.layer, k))) out.push({ kind: 'tile', key: k }); });
  if (baseOn() && layerOpen('level')) {
    for (const o of baseObjects) if (!removedObjects.has(o.id) && inside(o)) out.push({ kind: 'base', id: o.id });
    for (const p of sceneList?.items || []) if (p.id && !p.group && p.a !== 0 && !removedScene.has(p.id) && p.reach < 400 && inside(p)) out.push({ kind: 'scene', id: p.id });
  }
  if (!layerLocked('course')) {
    if (inside(draft.spawn)) out.push({ kind: 'gate', which: 'spawn' });
    for (const c of courses()) for (const which of ['start', 'end', 'screen']) {
      const p = which === 'screen' ? courseScreen(c) : c[which];
      if (inside(p)) out.push({ kind: 'gate', which, course: c.id });
    }
  }
  out.push({ kind: 'region', ...r, cellsOnly: true });
  return out;
}
// The cells in a region that hold something of yours.
function regionContent(r) {
  const cells = [];
  for (let cy = r.y0; cy <= r.y1; cy++) for (let cx = r.x0; cx <= r.x1; cx++) {
    const k = key(cx, cy);
    if (blocks.has(k) || spikes.has(k) || vines.has(k)) cells.push(k);
  }
  return cells;
}

function deleteSelection() {
  if (!selection) return;
  for (const t of targetsOf(selection).slice(0, 30)) { const p = targetPoint(t); if (p) addFx('burst', p.x, p.y, COLORS.end, 48); }
  pushUndo();
  // Highest index first, so earlier deletions don't shift the later ones.
  const all = [...targetsOf(selection)].sort((a, b) => (b.index ?? -1) - (a.index ?? -1));
  for (const t of all) { selection = t; deleteOne(); }
  selection = null;
  saveDraft();
  renderConfig();
  requestDraw();
}
// A level sprite goes; a refresher's goes with all its other sprites (wings, dotted outline).
function removeScene(id) {
  removedScene.add(id);
  const item = sceneList?.items.find((x) => x.id === id), path = item?.p || '';
  const m = path.match(/^(.*?\/[^/]*Resetter[^/]*)(\/|$)/);
  if (!m) return;
  for (const x of sceneList.items) if (x.id && (x.p === m[1] || x.p?.startsWith(m[1] + '/')) && Math.hypot(x.x - item.x, x.y - item.y) < 200) removedScene.add(x.id);
}
function deleteOne() {
  if (selection.kind === 'object') placed.splice(selection.index, 1);
  else if (selection.kind === 'fspike') freeSpikes.splice(selection.index, 1);
  else if (selection.kind === 'sign') signs.splice(selection.index, 1);
  else if (selection.kind === 'csprite') csprites.splice(selection.index, 1);
  else if (selection.kind === 'mtrig') triggers.splice(selection.index, 1);
  else if (selection.kind === 'xspawn') xspawns.splice(selection.index, 1);
  else if (selection.kind === 'gate') clearMarker(selection);
  else if (selection.kind === 'base') removedObjects.add(selection.id);
  else if (selection.kind === 'blocks') selection.cells.forEach((k) => blocks.delete(k));
  else if (selection.kind === 'moss') selection.cells.forEach((k) => mossCells.delete(k));
  else if (selection.kind === 'basecells') selection.cells.forEach((k) => removed.add(k));
  else if (selection.kind === 'scene') removeScene(selection.id);
  else if (selection.kind === 'decotiles') selection.cells.forEach((k) => removedDeco.add(selection.layer + '|' + k));
  else if (selection.kind === 'tile') { const id = tiles.get(selection.key)?.arrow; if (id) removeArrow(id); else tiles.delete(selection.key); }
  else if (selection.kind === 'cell') { if (selection.vine) vines.delete(selection.k); else { blocks.delete(selection.k); spikes.delete(selection.k); } }
  else if (selection.kind === 'region') {
    const saveTool = tool;
    tool = 'erase';
    const inRegion = (cx, cy) => cx >= selection.x0 && cx <= selection.x1 && cy >= selection.y0 && cy <= selection.y1;
    if (!selection.cellsOnly) placed = placed.filter((o) => { const c = cellOf(o.x, o.y); return !inRegion(c.cx, c.cy); });
    const cut = new Set();
    for (const [k, t] of [...tiles]) { const c = tileCenter(t.layer, k), cc = cellOf(c.x, c.y); if (inRegion(cc.cx, cc.cy)) { tiles.delete(k); if (t.arrow) cut.add(t.arrow); } }
    if (cut.size) { arrows = arrows.filter((ar) => !cut.has(ar.id)); rebuildArrowTiles(); }
    for (let cy = selection.y0; cy <= selection.y1; cy++) for (let cx = selection.x0; cx <= selection.x1; cx++) {
      const k = key(cx, cy);
      blocks.delete(k); spikes.delete(k); vines.delete(k);
      if (baseOn() && (groundSet.has(k) || mossSet.has(k) || blueSet.has(k) || orangeSet.has(k) || (baseHaz.get(k) && baseHaz.get(k).kind !== 'vine'))) removed.add(k);
      if (baseOn() && baseHaz.get(k)?.kind === 'vine') removedVines.add(k);
    }
    tool = saveTool;
  }
}

function baseTilesIn(x0, y0, x1, y1) {
  const out = [];
  if (!baseOn() || !base.art) return out;
  const lo = cellWorld(x0, y0), hi = cellWorld(x1 + 1, y1 + 1);
  for (const l of base.art.layers) {
    if (l.state !== 'always' && l.state !== draft.baseState) continue;
    const names = new Map((base.art.palette?.[l.name] || []).map((n) => [base.art.tiles[n], n]));
    const gy0 = Math.floor((lo.y - l.oy) / l.size), gy1 = Math.floor((hi.y - 1 - l.oy) / l.size);
    const gx0 = Math.floor((lo.x - l.ox) / l.size), gx1 = Math.floor((hi.x - 1 - l.ox) / l.size);
    for (let i = 0; i < l.runs.length; i += 5) {
      const gy = l.runs[i];
      if (gy < gy0 || gy > gy1) continue;
      for (let n = 0; n < l.runs[i + 2]; n++) {
        const gx = l.runs[i + 1] + n;
        if (gx < gx0 || gx > gx1 || erasedArt(l, gx, gy)) continue;
        const tile = names.get(l.runs[i + 3]);
        if (tile) out.push({ layer: l.name, x: l.ox + (gx + 0.5) * l.size, y: l.oy + (gy + 0.5) * l.size, tile, m: base.mats[l.runs[i + 4]] });
      }
    }
  }
  return out;
}

// Layering: objects draw in list order, so the end of the list is the front.
function drawStackEntries(list) {
  for (const e of list) {
    if (e.kind === 'fspike') { if (!layerHidden('hazards')) drawFreeSpike(e.it); }
    else if (e.kind === 'sign') { if (!layerHidden('decor')) drawSign(e.it); }
    else if (e.kind === 'csprite') { if (!layerHidden('decor')) drawCustomSprite(e.it); }
    else if (!layerHidden(e.it.cat === 'decor' ? 'decor' : 'objects')) drawPlacedObject(e.it);
  }
}

// The stack: placed objects, decorations and free spikes in draw order,
// back to front. Each keeps a z; new things (no z yet) go on top as made.
function stack() {
  const all = [...placed.map((it, i) => ({ kind: 'object', index: i, it })), ...freeSpikes.map((it, i) => ({ kind: 'fspike', index: i, it })), ...signs.map((it, i) => ({ kind: 'sign', index: i, it })), ...csprites.map((it, i) => ({ kind: 'csprite', index: i, it }))];
  const z = (e) => e.it.z ?? Infinity;
  const kindOrder = { object: 0, fspike: 1, sign: 2, csprite: 3 };
  return all.sort((a, b) => (a.it.behind ? 0 : 1) - (b.it.behind ? 0 : 1) || z(a) - z(b) || (a.kind === b.kind ? a.index - b.index : kindOrder[a.kind] - kindOrder[b.kind]));
}
function stackRank() {
  const rank = new Map();
  stack().forEach((e, n) => rank.set(e.it, n));
  return rank;
}
// Moves the selection in the stack: 'front', 'back', or one step 'up' / 'down'.
function restack(how) {
  if (selection?.kind === 'multi') {
    const pos = (t) => stack().findIndex((e) => e.kind === t.kind && e.index === t.index);
    const items = selection.items.filter((t) => STACKABLE.has(t.kind)).sort((a, b) => pos(a) - pos(b));
    if (!items.length) { flash('Nothing here goes in the layer stack.', true); return; }
    if (how === 'up' || how === 'front') items.reverse();
    const all = selection;
    for (const t of items) { selection = t; restack(how); }
    selection = all;
    renderConfig();
    return;
  }
  if (selection?.kind === 'base' || selection?.kind === 'scene') {
    // The level's own: its draw order among the level's layers (below 0 is behind the ground).
    const k = levelKey(selection), cur = levelOrder.get(k) || 0, step = { up: 1, down: -1, front: 40, back: -40 }[how];
    pushUndo();
    const next = Math.max(-400, Math.min(400, cur + step));
    if (next) levelOrder.set(k, next); else levelOrder.delete(k);
    applyBaseMoves();
    saveDraft(); renderConfig(); requestDraw();
    flash(`Draw order ${next > 0 ? '+' : ''}${next}`);
    return;
  }
  if (!STACKABLE.has(selection?.kind)) { flash('Select an object, image, text or a free spike to move it in front or behind.', true); return; }
  // The level sits in the stack as a divider: what's below it is behind the level.
  const list = stack(), split = list.filter((e) => e.it.behind).length;
  const full = [...list.slice(0, split), { divider: true }, ...list.slice(split)];
  const pos = full.findIndex((e) => !e.divider && e.kind === selection.kind && e.index === selection.index);
  if (pos < 0) return;
  const to = how === 'front' ? full.length - 1 : how === 'back' ? 0 : Math.max(0, Math.min(full.length - 1, pos + (how === 'up' ? 1 : -1)));
  if (to === pos) {
    // Already the furthest back behind the ground: the next step back is behind the walls.
    if ((how === 'down' || how === 'back') && selection && full[pos]?.it?.behind && full[pos].it.depth !== 2) {
      pushUndo(); full[pos].it.depth = 2; saveDraft(); renderConfig(); requestDraw(); flash('Behind the walls now'); return;
    }
    flash(how === 'up' || how === 'front' ? 'Already at the front' : 'Already behind everything'); return;
  }
  pushUndo();
  const [moved] = full.splice(pos, 1);
  full.splice(to, 0, moved);
  const was = !!moved.it.behind;
  let behind = true, n = 0;
  for (const e of full) {
    if (e.divider) { behind = false; continue; }
    if (behind) e.it.behind = true; else delete e.it.behind;
    e.it.z = n++;
  }
  saveDraft();
  renderConfig();
  requestDraw();
  flash(was !== !!moved.it.behind ? (moved.it.behind ? 'Behind the level now' : 'In front of the level now') : { front: 'Brought to front', back: 'Sent to back', up: 'Moved up one', down: 'Moved down one' }[how]);
}
function levelOrderRow() {
  const n = levelOrder.get(levelKey(selection)) || 0;
  return `<div class="mm-config-sub" style="display:block">Draw order ${n ? (n > 0 ? '+' : '') + n : 'as the level has it'} - below the level's ground once it's far enough back.</div>`;
}
const OWN_STACK = ['object', 'fspike', 'sign', 'csprite'];
function depthRow() {
  const own = targetsOf(selection).filter((t) => OWN_STACK.includes(t.kind)).map((t) => listOfKind(t.kind)[t.index]).filter(Boolean);
  if (!own.length) return '';
  const d = own[0].behind ? (own[0].depth === 2 ? 2 : 1) : 0;
  const opt = (v, t) => `<option value="${v}"${v === d ? ' selected' : ''}>${t}</option>`;
  return `<div class="mm-config-row"><label>Depth<select class="mm-input" data-depth="1">${opt(0, 'In front of the level')}${opt(1, 'Behind the ground and objects')}${opt(2, 'Behind the walls too')}</select></label></div>`;
}
function bindDepth(el) {
  el.querySelectorAll('[data-depth]').forEach((inp) => inp.addEventListener('change', () => {
    const v = Number(inp.value);
    pushUndo();
    for (const t of targetsOf(selection)) {
      if (!OWN_STACK.includes(t.kind)) continue;
      const it = listOfKind(t.kind)[t.index];
      if (!it) continue;
      if (!v) { delete it.behind; delete it.depth; } else { it.behind = true; if (v === 2) it.depth = 2; else delete it.depth; }
    }
    saveDraft(); renderConfig(); requestDraw();
  }));
}
function stackButtons() {
  const listOf = { object: placed, fspike: freeSpikes, sign: signs };
  const behind = targetsOf(selection).some((t) => listOf[t.kind]?.[t.index]?.behind);
  return (behind ? `<div class="mm-config-sub">Behind the level: drawn under its ground and objects, over its background.</div>` : '') + `<div class="mm-config-row"><button class="mm-tool" data-act="stack:front" title="In front of everything (Shift+])">⤒ Front</button><button class="mm-tool" data-act="stack:up" title="Up one (])">↑ Up</button><button class="mm-tool" data-act="stack:down" title="Down one ([)">↓ Down</button><button class="mm-tool" data-act="stack:back" title="Behind everything (Shift+[)">⤓ Back</button></div>`;
}

// A copied object: Ctrl+V puts a copy under the mouse (a region copy pastes with a click instead).
let clipObject = null;
function pasteObject() {
  const at = hoverWorld || { x: cam.x, y: cam.y }, snap = snapV();
  if (clipObject.many) {
    pushUndo();
    pasteMany(clipObject.many, cellOf(at.x, at.y));
    saveDraft(); renderConfig(); requestDraw();
    return;
  }
  if (clipObject.sign) {
    const p = snapPoint(at, snap);
    pushUndo();
    signs.push({ ...clipObject.sign, x: p.x, y: p.y });
    selection = { kind: 'sign', index: signs.length - 1 };
    saveDraft(); renderConfig(); requestDraw();
    return;
  }
  if (clipObject.freeSpike) {
    const p = snapPoint(at, snap);
    pushUndo();
    freeSpikes.push({ ...clipObject.freeSpike, x: p.x, y: p.y });
    selection = { kind: 'fspike', index: freeSpikes.length - 1 };
    saveDraft(); renderConfig(); requestDraw();
    return;
  }
  const copy = { ...JSON.parse(JSON.stringify(clipObject)), x: Math.round(at.x / snap) * snap, y: Math.round(at.y / snap) * snap };
  if (copy.uid) copy.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  delete copy.tp;
  pushUndo();
  placed.push(copy);
  selection = { kind: 'object', index: placed.length - 1 };
  saveDraft();
  renderConfig();
  requestDraw();
}

// Several things copied together: placed things by their offset, cell content by cells.
function copyMany(items) {
  const region = items.find((t) => t.kind === 'region');
  const things = items.filter((t) => WORLD_KINDS.has(t.kind)).map((t) => {
    return { kind: t.kind, data: JSON.parse(JSON.stringify(listOfKind(t.kind)[t.index])) };
  }).filter((t) => t.data);
  const cells = [];
  if (region) for (const k of regionContent(region)) {
    const [cx, cy] = unkey(k);
    cells.push({ cx, cy, block: blocks.get(k), spike: spikes.get(k), vine: vines.get(k) });
  }
  const xs = [...things.map((t) => t.data.x), ...cells.map((c) => cellWorld(c.cx, c.cy).x + CELL / 2)];
  const ys = [...things.map((t) => t.data.y), ...cells.map((c) => cellWorld(c.cx, c.cy).y + CELL / 2)];
  if (!xs.length) return null;
  const anchor = cellOf(Math.min(...xs), Math.min(...ys)), a = cellWorld(anchor.cx, anchor.cy);
  return {
    anchor,
    many: {
      things: things.map((t) => ({ ...t, dx: t.data.x - a.x, dy: t.data.y - a.y })),
      cells: cells.map((c) => ({ ...c, dcx: c.cx - anchor.cx, dcy: c.cy - anchor.cy })),
    },
  };
}
function pasteMany(many, anchorCell) {
  const a = cellWorld(anchorCell.cx, anchorCell.cy), out = [];
  for (const t of many.things) {
    const copy = { ...JSON.parse(JSON.stringify(t.data)), x: Math.round(a.x + t.dx), y: Math.round(a.y + t.dy) };
    delete copy.z;
    if (copy.uid) copy.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    delete copy.tp;
    const list = listOfKind(t.kind);
    list.push(copy);
    out.push({ kind: t.kind, index: list.length - 1 });
  }
  for (const c of many.cells) {
    const k = key(anchorCell.cx + c.dcx, anchorCell.cy + c.dcy);
    if (c.block) { blocks.set(k, c.block); spikes.delete(k); }
    if (c.spike) { spikes.set(k, c.spike); blocks.delete(k); }
    if (c.vine) vines.set(k, c.vine);
  }
  if (many.cells.length) {
    const xs = many.cells.map((c) => c.dcx), ys = many.cells.map((c) => c.dcy);
    out.push({ kind: 'region', x0: anchorCell.cx + Math.min(...xs), y0: anchorCell.cy + Math.min(...ys), x1: anchorCell.cx + Math.max(...xs), y1: anchorCell.cy + Math.max(...ys), cellsOnly: true });
  }
  setSelection(out);
}

function copySelection() {
  if (selection?.kind === 'multi') {
    const clip = copyMany(selection.items);
    if (!clip) { flash('Nothing in the selection can be copied.', true); return; }
    clipObject = clip;
    flash(`Copied ${clip.many.things.length + (clip.many.cells.length ? 1 : 0) > 1 ? 'the selection' : 'it'} - Ctrl+V pastes at the mouse`);
    return;
  }
  if (selection?.kind === 'csprite' && csprites[selection.index]) {
    clipObject = copyMany([selection]);
    flash('Copied image - Ctrl+V pastes it at the mouse');
    return;
  }
  if (selection?.kind === 'sign' && signs[selection.index]) {
    clipObject = { sign: { ...signs[selection.index] } };
    flash('Copied text - Ctrl+V pastes it at the mouse');
    return;
  }
  if (selection?.kind === 'fspike' && freeSpikes[selection.index]) {
    clipObject = { freeSpike: { ...freeSpikes[selection.index] } };
    flash('Copied spike - Ctrl+V pastes it at the mouse');
    return;
  }
  if (selection?.kind === 'object' && placed[selection.index]) {
    clipObject = JSON.parse(JSON.stringify(placed[selection.index]));
    flash(`Copied ${catalogItem(clipObject)?.name || 'object'} - Ctrl+V pastes it at the mouse`);
    return;
  }
  if (selection?.kind !== 'region') { flash('Select an object, or drag out a region with Select (Q), first.', true); return; }
  clipObject = null;
  const { x0, y0, x1, y1 } = selection;
  const origin = cellWorld(x0, y0);
  const inRegion = (cx, cy) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  const b = { w: x1 - x0 + 1, h: y1 - y0 + 1, tiles: [], blocks: [], spikes: [], vines: [], objects: [] };
  for (const t of baseTilesIn(x0, y0, x1, y1)) b.tiles.push({ layer: t.layer, dx: t.x - origin.x, dy: t.y - origin.y, tile: t.tile, m: t.m });
  tiles.forEach((t, k) => { const c = tileCenter(t.layer, k), cc = cellOf(c.x, c.y); if (inRegion(cc.cx, cc.cy)) b.tiles.push({ ...t, dx: c.x - origin.x, dy: c.y - origin.y }); });
  blocks.forEach((kind, k) => { const [cx, cy] = unkey(k); if (inRegion(cx, cy)) b.blocks.push([cx - x0, cy - y0, kind]); });
  spikes.forEach((sp, k) => { const [cx, cy] = unkey(k); if (inRegion(cx, cy)) b.spikes.push([cx - x0, cy - y0, sp]); });
  vines.forEach((v, k) => { const [cx, cy] = unkey(k); if (inRegion(cx, cy)) b.vines.push([cx - x0, cy - y0, v]); });
  for (const o of placed) { const c = cellOf(o.x, o.y); if (inRegion(c.cx, c.cy)) b.objects.push({ ...o, dx: o.x - origin.x, dy: o.y - origin.y }); }
  brush = b;
  closePopover();
  setTool('paste');
  flash(`Copied ${b.w}x${b.h}: ${b.tiles.length} tiles, ${b.blocks.length + b.spikes.length} blocks/spikes, ${b.objects.length} objects - click to paste (V)`);
}

function pasteBrush(cx, cy) {
  const origin = cellWorld(cx, cy);
  for (const t of brush.tiles) {
    const { dx, dy, arrow, ...rest } = t;
    tiles.set(tileKeyAt(t.layer, origin.x + dx, origin.y + dy), rest);
  }
  for (const [dx, dy, kind] of brush.blocks) { blocks.set(key(cx + dx, cy + dy), kind); spikes.delete(key(cx + dx, cy + dy)); }
  for (const [dx, dy, sp] of brush.spikes) { spikes.set(key(cx + dx, cy + dy), sp); blocks.delete(key(cx + dx, cy + dy)); }
  for (const [dx, dy, v] of brush.vines) vines.set(key(cx + dx, cy + dy), v);
  for (const o of brush.objects) { const { dx, dy, ...rest } = o; placed.push({ ...rest, x: origin.x + dx, y: origin.y + dy }); }
}

function drawBrush(cx, cy) {
  const origin = cellWorld(cx, cy);
  for (const t of brush.tiles) drawPlacedTile(t, tileKeyAt(t.layer, origin.x + t.dx, origin.y + t.dy), 0.55);
  for (const o of brush.objects) drawPlacedObject({ ...o, x: origin.x + o.dx, y: origin.y + o.dy }, 0.55);
  const a = cellRect(cx, cy + brush.h - 1), r = cellRect(cx + brush.w - 1, cy);
  ctx.save();
  ctx.strokeStyle = COLORS.start;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(a.x, a.y, r.x + r.w - a.x, r.y + r.h - a.y);
  ctx.restore();
}

function pickAt(wx, wy) {
  const oi = placed.findLastIndex((o) => objectHit(o, wx, wy));
  if (oi >= 0) {
    const o = placed[oi];
    if (o.cat === 'objects') {
      const ci = categoryItems('objects').findIndex((it) => it.i === o.i);
      if (ci >= 0) selectItem('objects', ci);
      else selectItem('gates', Math.max(0, categoryItems('gates').findIndex((it) => it.tool === 'object' && it.i === o.i)));
    }
    else selectItem('decor', o.i);
    placeRot = Math.round((o.cfg?.rot || 0) / 90) & 3;
    placeFlip = !!o.cfg?.fx;
    return;
  }
  flash('Point at a placed object or decoration to pick it.', true);
}

const FIELD_LABELS = {
  'SpringScript.upForce': 'Up force', 'SpringScript.strength': 'Strength', 'SpringScript.movementLock': 'Movement lock (s)',
  'JiggleDropScript.cooldownOnUse': 'Regrow time (s)', 'JiggleDropScript.timeStopDuration': 'Time stop (s)',
};

const UPGRADE_KINDS = [
  { id: 'dash', label: 'Dash', multi: true },
  { id: 'doubleJump', label: 'Double jump', multi: true },
  { id: 'wallJump', label: 'Wall jump' },
  { id: 'blockSwap', label: 'Block swap' },
  { id: 'omniDash', label: 'Omni dash' },
  { id: 'zipMovers', label: 'Zip movers' },
  { id: 'refreshers', label: 'Refreshers' },
  { id: 'clones', label: 'Clones', multi: true, local: true },
  { id: 'baseReward', label: 'Base reward', multi: true, local: true },
  { id: 'cloneMult', label: 'Clone reward multiplier', multi: true, local: true },
  { id: 'fastClone', label: 'Fast clone chance', multi: true, local: true },
  { id: 'bigClone', label: 'Big clone chance', multi: true, local: true },
  { id: 'moreWatts', label: 'More watts', multi: true, local: true },
  { id: 'greenReward', label: 'Green clone GP reward', multi: true, local: true },
  { id: 'redReward', label: 'Red clone RP reward', multi: true, local: true },
  { id: 'cloneDust', label: 'Clone dust generation', local: true },
];
const CURRENCIES = [['Cash', 'Cash'], ['GreenPower', 'Green power'], ['AtomicPower', 'Nuclear power'], ['CloneDust', 'Clone dust'], ['RedPower', 'Red power'], ['BluePower', 'Blue power']];

function upgradeConfig(o) {
  const u = { kind: 'dash', currency: 'Cash', price: 10, scale: 1.5, add: 0, power: 1, max: 1, prices: [], label: '', ...(o.cfg?.upgrade || {}) };
  if (!UPGRADE_KINDS.find((k) => k.id === u.kind)?.multi) u.max = 1;
  return u;
}
function upgradePrices(u, n = u.max) {
  const out = [];
  let c = u.price;
  for (let i = 0; i < n; i++) {
    if (i < u.prices.length) c = u.prices[i];
    else if (i > 0) c = Math.ceil(Math.pow(c + u.add, u.power) * u.scale);
    out.push(c);
  }
  return out;
}
const upgradeLabel = (u) => u.label || UPGRADE_KINDS.find((k) => k.id === u.kind)?.label || u.kind;
function shortNumber(v) {
  if (!Number.isFinite(v)) return '∞';
  if (Math.abs(v) < 1e4) return String(Math.round(v * 100) / 100);
  const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
  let i = -1;
  while (Math.abs(v) >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return (Math.round(v * 10) / 10) + units[i];
}

const BOX_TEXT = {
  dash: { name: '+1 Dash' },
  doubleJump: { name: '+1 midair jump' },
  wallJump: { name: 'Unlock wall jump' },
  blockSwap: { name: 'Activate orange blocks, Deactivate blue blocks' },
  omniDash: { name: '-1 Midair jump.\n\nDash in any direction' },
  zipMovers: { name: 'Activate zip movers' },
  refreshers: { name: 'Enable Jump and Dash refresh orbs' },
  clones: { name: '0 Clones', effect: '[+1 Per use]' },
  baseReward: { name: '1x base reward', effect: '[+1x  Per use]' },
  cloneMult: { name: '0.1x clone reward multiplier', effect: '[+0.1x  Per use]' },
  fastClone: { name: '5% clone speed increase chance', effect: '[+5%  Per use]' },
  bigClone: { name: '5% clone size increase chance', effect: '[+5%  Per use]' },
  moreWatts: { name: '0% more watts', effect: '[+100%  Per use]' },
  greenReward: { name: '1x green clone GP reward', effect: '[+1x  Per use]' },
  redReward: { name: '1x red clone RP reward', effect: '[+1x  Per use]' },
  cloneDust: { name: 'Enable Clone Dust generation on this course' },
};
const CURRENCY_MARK = { Cash: 'w', GreenPower: 'gp', AtomicPower: 'np', CloneDust: 'cd', RedPower: 'rp', BluePower: 'bp' };
const CURRENCY_COLOUR = { Cash: '#ff6a00', GreenPower: '#00dd5d', AtomicPower: '#9654f0', CloneDust: '#b3905e', RedPower: '#db5246', BluePower: '#9654f0' };
function gameCost(v, currency) {
  const mark = CURRENCY_MARK[currency] ?? '';
  const two = (n) => (Math.round(n * 100) / 100).toFixed(2);
  if (v >= 1e18) return v.toExponential(2).replace('e+', 'e') + mark;
  if (v / 1e15 > 1) return two(v / 1e15) + 'P' + mark;
  for (const [d, u] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'K']]) if (v / d >= 1) return two(v / d) + u + mark;
  if (v > 0) return (currency === 'AtomicPower' ? v.toFixed(2) : String(Math.round(v))) + mark;
  return '0' + mark;
}
const BOX_NAME_T = { f: 2, dx: 0, dy: -44.6, r: 0, w: 127.5, h: 127.5, k: 1.5, size: 8.55, auto: [8, 36], ha: 2, va: 256, wrap: 1, ls: 0, cs: 0, m: [0, 3.21, 0, 17.78], c: '#d9dad9', a: 1 };
const BOX_COST_T = { f: 1, dx: 2.6, dy: 43, r: 0, w: 100.5, h: 37.5, k: 1.5, size: 11.5, auto: [1, 21], ha: 4, va: 512, wrap: 1, ls: 0, cs: 0, m: [1.3, 0, 0, 0], a: 1 };
const BOX_EFFECT_T = { f: 2, dx: 0, dy: -102, r: 0, w: 135, h: 45, k: 1.5, size: 9.85, auto: [5, 36], ha: 2, va: 1024, wrap: 1, ls: 0, cs: 0, m: [0, 0, 0, 16.17], c: '#d9dad9', a: 1 };
function boxTexts(o) {
  const u = upgradeConfig(o), text = BOX_TEXT[u.kind] || { name: upgradeLabel(u) };
  const out = [
    { ...BOX_COST_T, t: gameCost(upgradePrices(u, 1)[0], u.currency), c: CURRENCY_COLOUR[u.currency] || '#ffffff' },
    { ...BOX_NAME_T, t: u.label || text.name },
  ];
  if (text.effect) out.push({ ...BOX_EFFECT_T, t: text.effect });
  return out;
}
const bakedTexts = new Map();
function drawTextAt(t, x, y) {
  const k = [t.t, t.f, t.c, t.w, t.h, t.size, t.k].join('|');
  let e = bakedTexts.get(k);
  if (!e) {
    e = { t: { ...t } };
    e.baked = bakeText(e.t);
    bakedTexts.set(k, e);
    if (bakedTexts.size > 400) bakedTexts.delete(bakedTexts.keys().next().value);
  }
  if (!e.baked) return;
  const c = toScreen(x, y);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, c.x, c.y);
  ctx.scale(cam.scale / e.baked.px, cam.scale / e.baked.px);
  ctx.globalAlpha *= t.a ?? 1;
  ctx.drawImage(e.baked.canvas, e.baked.x0 * e.baked.px, -e.baked.top * e.baked.px);
  ctx.restore();
}
function fontsReady() {
  const fonts = base?.scene?.fonts || [];
  return fonts.length > 0 && fonts.every((f, i) => !f || fontImage(i).complete);
}
function drawBoxTexts(o, alpha) {
  if (!fontsReady()) return drawUpgradeLabel(o);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const t of boxTexts(o)) drawTextAt(t, o.x + t.dx, o.y + t.dy);
  ctx.restore();
}
function editedBoxText(t) {
  for (const [id, e] of Object.entries(draft.baseEdits || {})) {
    const o = baseObjects.find((x) => x.id === id);
    if (!o || Math.abs(t.x - o.x) > o.w / 2 || Math.abs(t.y - o.y) > o.h / 2) continue;
    const u = baseUpgradeConfig(o);
    if (t.f === 1) return { ...t, t: gameCost(upgradePrices(u, 1)[0], u.currency), c: CURRENCY_COLOUR[u.currency] || t.c };
    if (e.label && !t.t.startsWith('[')) return { ...t, t: e.label };
  }
  return null;
}

function drawUpgradeLabel(o) {
  const u = upgradeConfig(o), c = toScreen(o.x, o.y + 40);
  const size = Math.max(9, Math.min(22, 13 * cam.scale * 1.4));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `bold ${size}px sans-serif`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillStyle = '#fff';
  ctx.strokeText(upgradeLabel(u), c.x, c.y);
  ctx.fillText(upgradeLabel(u), c.x, c.y);
  const price = shortNumber(upgradePrices(u, 1)[0]) + ' ' + (CURRENCIES.find((x) => x[0] === u.currency)?.[1] || u.currency) + (u.max > 1 ? ` · ×${u.max}` : '');
  ctx.font = `${size * 0.8}px sans-serif`;
  ctx.fillStyle = '#ffb347';
  ctx.strokeText(price, c.x, c.y + size);
  ctx.fillText(price, c.x, c.y + size);
  ctx.restore();
}

function upgradeConfigHtml(o, num) {
  const u = upgradeConfig(o), kind = UPGRADE_KINDS.find((k) => k.id === u.kind);
  const sel = (id, label, options, value) => `<label>${label}<select class="mm-input" data-cfg="${id}">${options.map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const linked = isLinked(o.course);
  let html = `<div class="mm-config-row">${sel('up:kind', 'Gives', UPGRADE_KINDS.filter((k) => !k.local || linked || k.id === u.kind).map((k) => [k.id, k.label + (k.local ? ' (course)' : '')]), u.kind)}${sel('up:currency', 'Paid in', CURRENCIES, u.currency)}</div>`;
  if (kind?.local && !linked) html += `<div class="mm-config-sub mm-warn">Link this box to a course for this upgrade to work.</div>`;
  html += `<div class="mm-config-row"><label>Label<input class="mm-input" type="text" data-cfg="up:label" value="${u.label.replace(/"/g, '&quot;')}" placeholder="${kind?.label || ''}"></label></div>`;
  html += `<div class="mm-config-row">${num('up:price', 'Price', u.price, 1)}${kind?.multi ? num('up:max', 'Max buys', u.max, 1) : ''}</div>`;
  if (kind?.multi && u.max > 1) {
    html += `<div class="mm-config-sub">Each next price = ((last + add) ^ power) × scale</div>`;
    html += `<div class="mm-config-row">${num('up:scale', '× Scale', u.scale, 0.1)}${num('up:add', '+ Add', u.add, 1)}${num('up:power', '^ Power', u.power, 0.05)}</div>`;
    html += `<div class="mm-config-row"><label>Set prices (comma list, overrides the curve)<input class="mm-input" type="text" data-cfg="up:prices" value="${u.prices.join(', ')}" placeholder="e.g. 10, 25, 60"></label></div>`;
    html += `<div class="mm-config-sub">Prices: ${upgradePrices(u, Math.min(u.max, 12)).map(shortNumber).join(', ')}${u.max > 12 ? ' …' : ''}</div>`;
  }
  return html;
}

const LEVEL_TOGGLES = [
  ['wallJump', 'Wall jump'], ['blockSwap', 'Block swap dash'], ['omniDash', 'Omni dash'],
  ['zipMovers', 'Zip movers work'], ['refreshers', 'Refreshers work'], ['teleporters', 'Teleporters work'],
];
const LOCAL_UPGRADE_ENUM = ['Global', 'Movement', 'Clones', 'Base reward', 'Fast clone chance', 'Big clone chance', 'Boost all previous courses', 'Clone reward multiplier', 'Clones', 'Green clone reward', 'Emergency lights', 'Clone dust generation', 'More watts', 'Red clone reward'];
const MOVEMENT_ENUM = ['Dash', 'Wall jump', 'Double jump', 'Swap blocks once', 'Block swap', 'End of demo', 'Omni dash'];
const GLOBAL_ENUM = ['Base reward', 'Fast clone chance', 'Max clone speed', 'Big clone chance', 'Max clone size', 'Clone multiplier', 'New atom', 'Atom level chance', 'Green clone chance', 'Tree growth', 'Unlock prestige', 'Open gate', 'More watts', 'More green power', 'More nuclear power', 'Open area 2 door', 'Zip movers', 'Exempt course from atom prestige', 'Triple threat', 'Refreshers', 'Clone dust digits', 'Completion boost', 'Completion boost time', 'Completion boost strength', 'Clone dust multiplier', 'More refresher orbs', 'Teleporters', 'Buy max on a course', 'Red clone chance', 'Blue clone chance', 'Nuclear power soft cap', 'Completion boost doubles NP', 'Speedrun time', 'Start speedrun', 'More watts', 'More green power', 'More red power', 'More red power', 'Red power cap', 'GP atoms keep courses', 'NP generation speed'];
function boxKindName(o) {
  const b = o.box;
  if (!b) return o.label;
  if (b.upgrade === 0) return GLOBAL_ENUM[b.global] || o.label;
  if (b.upgrade === 1) return MOVEMENT_ENUM[b.movement] || o.label;
  return LOCAL_UPGRADE_ENUM[b.upgrade] || o.label;
}
const CURRENCY_ENUM = ['Cash', 'GreenPower', 'AtomicPower', 'regularNumber', 'CloneDust', 'RedPower', 'BluePower'];
function baseUpgradeConfig(o) {
  const b = o.box || {};
  return { currency: CURRENCY_ENUM[b.currency] || 'Cash', price: b.price ?? 10, scale: b.scale ?? 1.5, add: b.add ?? 0, power: b.power ?? 1, max: b.max ?? 1, prices: [], label: '', ...(draft.baseEdits?.[o.id] || {}) };
}
function baseUpgradeHtml(o, num) {
  const u = baseUpgradeConfig(o), edited = !!draft.baseEdits?.[o.id];
  const sel = (id, label, options, value) => `<label>${label}<select class="mm-input" data-cfg="${id}">${options.map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  let html = `<div class="mm-config-row"><label>Label<input class="mm-input" type="text" data-cfg="bu:label" value="${u.label.replace(/"/g, '&quot;')}" placeholder="the game's own"></label>${sel('bu:currency', 'Paid in', CURRENCIES, u.currency)}</div>`;
  html += `<div class="mm-config-row">${num('bu:price', 'Price', u.price, 1)}${num('bu:max', 'Max buys', u.max, 1)}</div>`;
  html += `<div class="mm-config-sub">Each next price = ((last + add) ^ power) × scale</div>`;
  html += `<div class="mm-config-row">${num('bu:scale', '× Scale', u.scale, 0.1)}${num('bu:add', '+ Add', u.add, 1)}${num('bu:power', '^ Power', u.power, 0.005)}</div>`;
  html += `<div class="mm-config-row"><label>Set prices (comma list, overrides the curve)<input class="mm-input" type="text" data-cfg="bu:prices" value="${u.prices.join(', ')}" placeholder="e.g. 10, 25, 60"></label></div>`;
  html += `<div class="mm-config-sub">Prices: ${upgradePrices(u, Math.min(u.max, 10)).map(shortNumber).join(', ')}${u.max > 10 ? ' …' : ''}</div>`;
  html += edited ? `<div class="mm-config-row"><button class="mm-tool" data-act="baseReset">Reset to the game's values</button></div>` : `<div class="mm-config-sub">The game's own values (course boxes also scale with the course's tier in the game).</div>`;
  return html;
}
function applyBaseUpgrade(field, raw) {
  const o = baseObjects.find((x) => x.id === selection.id);
  if (!o) return;
  const u = { ...(draft.baseEdits?.[o.id] || {}) };
  if (field === 'currency' || field === 'label') u[field] = raw.trim();
  else if (field === 'prices') u.prices = raw.split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  else {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    u[field] = field === 'max' ? Math.max(1, Math.round(v)) : field === 'price' || field === 'add' ? Math.max(0, v) : Math.max(0.001, v);
  }
  pushUndo();
  draft.baseEdits = { ...(draft.baseEdits || {}), [o.id]: u };
  saveDraft();
  renderConfig();
  requestDraw();
}

function renderPlayerPanel() {
  const el = root?.querySelector('#mm-player');
  if (!el || el.hidden) return;
  const pl = draft.player, own = !!draft.ownProgress;
  const step = (id, label, value) => `<div class="mm-step"><span>${label}</span><button class="mm-tool" data-step="${id}" data-d="-1"${own ? ' disabled' : ''}>−</button><input class="mm-input" type="number" min="0" max="99" data-pl="${id}" value="${value}"${own ? ' disabled' : ''}><button class="mm-tool" data-step="${id}" data-d="1"${own ? ' disabled' : ''}>+</button></div>`;
  let html = `<div class="mm-config-title">Level settings<span>what the player starts with</span></div>`;
  html += step('dashes', 'Dashes', pl.dashes) + step('airJumps', 'Double jumps', pl.airJumps);
  html += `<div class="mm-toggles">${LEVEL_TOGGLES.map(([id, label]) => `<label class="mm-check"><input type="checkbox" data-pl="${id}"${pl[id] ? ' checked' : ''}${own ? ' disabled' : ''}> ${label}</label>`).join('')}</div>`;
  html += `<div class="mm-config-row"><label>Starting cash<input class="mm-input" type="number" min="0" data-pl="cash" value="${pl.cash}"${own ? ' disabled' : ''}></label></div>`;
  html += `<div class="mm-config-sub">Upgrade boxes in the level add to these.</div>`;
  html += `<div class="mm-config-row"><label class="mm-check"><input type="checkbox" data-pl="own"${own ? ' checked' : ''}> Use the player's own save instead</label></div>`;
  const bg = draft.background;
  html += `<div class="mm-config-sub" style="margin-top:8px">Music and background - for the whole map; a trigger (Course) switches them</div>`;
  html += `<div class="mm-config-row"><label>Music<select class="mm-input" data-media="music">${musicOptions(draft.music || 'level')}</select></label></div>`;
  html += `<div class="mm-config-row"><label>Background<select class="mm-input" data-media="background">${backgroundOptions(bg?.image || 'level')}</select></label></div>`;
  if (bg?.image) html += `<div class="mm-config-row"><label>Parallax (0 moves with the level, 1 stays put)<input class="mm-input" type="number" min="0" max="1" step="0.05" data-media="parallax" value="${bg.parallax ?? 0.8}"></label><label>Scale<input class="mm-input" type="number" min="0.05" step="0.1" data-media="scale" value="${bg.scale ?? 1}"></label></div>`;
  el.innerHTML = html;
  const set = (id, v) => { pushUndo(); draft.player = { ...draft.player, [id]: v }; saveDraft(); renderPlayerPanel(); };
  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => set(b.dataset.step, Math.max(0, Math.min(99, (draft.player[b.dataset.step] || 0) + Number(b.dataset.d))))));
  el.querySelectorAll('[data-media]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', async () => {
      const f = inp.dataset.media;
      if (f === 'music' || f === 'background') {
        const v = await resolveMediaChoice(f === 'music' ? 'music' : 'image', inp.value);
        if (v === null) { renderPlayerPanel(); return; }
        pushUndo();
        if (f === 'music') draft.music = v === 'level' ? undefined : v;
        else draft.background = v === 'level' ? undefined : { parallax: 0.8, scale: 1, ...(draft.background || {}), image: v };
      } else {
        const n = Number(inp.value);
        if (!Number.isFinite(n) || !draft.background) return;
        pushUndo();
        draft.background = { ...draft.background, [f]: f === 'parallax' ? Math.min(1, Math.max(0, n)) : Math.max(0.05, n) };
      }
      saveDraft();
      renderPlayerPanel();
      invalidateBase?.();
      requestDraw();
    });
  });
  el.querySelectorAll('input[data-pl]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const id = inp.dataset.pl;
      if (id === 'own') { pushUndo(); draft.ownProgress = inp.checked; saveDraft(); renderPlayerPanel(); }
      else if (inp.type === 'checkbox') set(id, inp.checked);
      else set(id, Math.max(0, Math.round(Number(inp.value) || 0)));
    });
  });
}

function bindGroupFields(el) {
  el.querySelectorAll('[data-grp]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      pushUndo();
      if (inp.dataset.grp === 'id') setGroup(targetsOf(selection), inp.value.trim());
      else {
        const g = groupOf(targetsOf(selection)[0]), set = new Set(draft.hiddenGroups || []);
        if (inp.checked) set.add(g); else set.delete(g);
        draft.hiddenGroups = [...set];
      }
      saveDraft(); renderConfig(); requestDraw();
    });
  });
}

// Copy / duplicate / delete as icons under the title, and the hints toggle.
let showHints = false;
try { showHints = localStorage.getItem('mapMakerHints') === '1'; } catch { /* private window */ }
function actionBar(many = false) {
  const b = (act, icon, title, cls = '') => `<button class="mm-act${cls}" data-act="${act}" title="${title}">${icon}</button>`;
  return `<div class="mm-actions">${b('copy', '⧉', 'Copy (Ctrl+C)')}${many ? '' : b('dup', '⊕', 'Duplicate (Ctrl+D)')}${b('delete', '✕', 'Delete (Del)', ' mm-act-danger')}<span class="mm-actions-gap"></span>${b('hints', 'ⓘ', 'Show / hide the help lines', showHints ? ' active' : '')}</div>`;
}
// Swaps the panel's contents, keeping its scroll, and animates it in when it opens.
function showPanel(el, html) {
  const opening = el.hidden, top = el.scrollTop;
  el.innerHTML = html;
  el.classList.toggle('mm-hints', showHints);
  el.hidden = false;
  el.scrollTop = top;
  if (opening) { el.classList.remove('mm-anim'); void el.offsetWidth; el.classList.add('mm-anim'); }
}

function renderConfig() {
  const el = root?.querySelector('#mm-config');
  if (!el) return;
  if (!selection) { el.hidden = true; return; }
  const num = (id, label, value, step = 1) => `<label>${label}<input class="mm-input" type="number" data-cfg="${id}" value="${Math.round(value * 1000) / 1000}" step="${step}"></label>`;
  const chk = (id, label, on) => `<label class="mm-check"><input type="checkbox" data-cfg="${id}"${on ? ' checked' : ''}> ${label}</label>`;
  let html = '';
  if (selection.kind === 'multi') {
    const ts = selection.items, region = ts.find((t) => t.kind === 'region');
    const things = ts.filter((t) => t.kind !== 'region').length, cells = region ? regionContent(region).length : 0;
    html += `<div class="mm-config-title">${things + (cells ? 1 : 0) > 1 || !region ? `${things} selected` : 'Region'}<span>${[things ? `${things} thing${things === 1 ? '' : 's'}` : '', cells ? `${cells} cell${cells === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') || 'empty'}</span></div>`;
    html += actionBar(true);
    html += `<div class="mm-config-sub">Drag any of it to move it all, or use the arrow keys. Shift+click adds or removes things; Shift+drag adds a box.</div>`;
    html += transformSection();
    if (region) html += sec('region', 'Region', `<div class="mm-config-row"><button class="mm-tool" data-act="rflipx" title="Mirror left-right (F)">↔ Flip</button><button class="mm-tool" data-act="rflipy" title="Mirror top-bottom (Shift+F)">↕ Flip</button><button class="mm-tool" data-act="rrot" title="Turn 90° (R)">⟲ Turn</button></div>`);
    html += sec('group', 'Group & layer', groupRow() + depthRow() + (ts.some((t) => STACKABLE.has(t.kind)) ? stackButtons() : ''));
    showPanel(el, html);
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => configAction(b.dataset.act)));
    bindGroupFields(el);
    bindTransform(el);
    bindDepth(el);
    bindSections(el);
    return;
  }
  if (selection.kind === 'object') {
    const o = placed[selection.index], item = catalogItem(o);
    if (!o || !item) { selection = null; el.hidden = true; return; }
    const cfg = o.cfg || {};
    html += `<div class="mm-config-title">${item.name}<span>${o.cat === 'objects' ? 'object' : 'decoration'}</span></div>`;
    html += actionBar();
    let more = '';
    if (isTeleporter(item)) {
      const opts = teleporterTargets(o), sel = (dir) => `<label>${dir === 'up' ? 'Up (▲) to' : 'Down (▼) to'}<select class="mm-input" data-cfg="tp:${dir}"><option value="">Nothing</option>${opts.map(([v, t]) => `<option value="${v}"${o.tp?.[dir] === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
      more += `<div class="mm-config-row">${sel('up')}</div><div class="mm-config-row">${sel('down')}</div>`;
      more += `<div class="mm-config-sub">Links go both ways. In the game a teleporter works once you've touched the one you're going to.</div>`;
    }
    if (isCourseCheckpoint(item)) {
      more += `<div class="mm-config-row"><label>Belongs to<select class="mm-input" data-cfg="link"><option value="">Any course</option>${courses().map((c) => `<option value="${c.id}"${o.course === c.id ? ' selected' : ''}>Course ${courseNumber(c.id)}</option>`).join('')}${baseOn() ? base.courses.map((c, i) => `<option value="level:${i + 1}"${o.course === 'level:' + (i + 1) ? ' selected' : ''}>Level course ${i + 1}</option>`).join('') : ''}</select></label></div>`;
      more += `<div class="mm-config-sub">The game's own course checkpoint, working exactly as in the game. "Belongs to" files it under that course.</div>`;
    } else if (LINKABLE(item)) more += `<div class="mm-config-row"><label>Course<select class="mm-input" data-cfg="link"><option value="">None</option>${courses().map((c) => `<option value="${c.id}"${o.course === c.id ? ' selected' : ''}>Course ${courseNumber(c.id)}</option>`).join('')}${baseOn() ? base.courses.map((c, i) => `<option value="level:${i + 1}"${o.course === 'level:' + (i + 1) ? ' selected' : ''}>Level course ${i + 1}</option>`).join('') : ''}</select></label></div>`;
    const zip = zipConfig(o, item);
    if (item.upgradeBox) more += upgradeConfigHtml(o, num);
    else if (zip) {
      const len = Math.hypot(...zip.end), ang = (Math.atan2(zip.end[1], zip.end[0]) * 180) / Math.PI;
      more += `<div class="mm-config-sub">Track - drag the end node (8 directions, whole cells)</div>`;
      more += `<div class="mm-config-row">${num('zipLen', 'Length', len, CELL)}${num('zipAng', 'Direction (°)', ang, 45)}</div>`;
      more += `<div class="mm-config-row">${num('zipTime', 'Move time (s)', zip.time, 0.1)}${num('zipBack', 'Return time (s)', zip.backTime, 0.1)}</div>`;
      more += `<div class="mm-config-row">${chk('zipAuto', 'Moves on its own', zip.auto)}</div>`;
      if (zip.auto) more += `<div class="mm-config-row">${num('zipPauseReturn', 'Pause before returning (s)', zip.pauseReturn, 0.1)}${num('zipPauseMove', 'Pause before moving (s)', zip.pauseMove, 0.1)}</div>`;
      else more += `<div class="mm-config-sub">Moves when touched, like the game's own. Tick "Moves on its own" to have it loop by itself.</div>`;
      const building = platformEdit === selection.index, shaped = !!cfg.zip?.cells;
      if (!shaped) more += `<div class="mm-config-row">${num('zipSpan', 'Platform length', zip.span, CELL)}</div>`;
      more += `<div class="mm-config-row"><button class="mm-tool${building ? ' active' : ''}" data-act="platform">${building ? 'Done building' : 'Build platform (B)'}</button>${shaped ? '<button class="mm-tool" data-act="platformReset">Reset shape</button>' : ''}</div>`;
      if (building) more += `<div class="mm-config-sub">Drag from empty space to add grate tiles, from a tile to remove them. Every tile hangs off the green root under the gear; cutting a piece off removes it.</div>`;
      else if (shaped) more += `<div class="mm-config-sub">Built from ${zipShape(o, item).cells.size} grate tiles.</div>`;
    } else {
      if (item.stretch) more += `<div class="mm-config-row">${num('width', 'Width (tiles the sprite)', cfg.width || item.stretch.width, 16)}</div>`;
    }
    if (isSizable(item)) {
      const t = trigOf(o, item);
      more += `<div class="mm-config-row">${num('trig:w', 'Trigger width', t.w, 16)}${num('trig:h', 'Trigger height', t.h, 16)}</div>`;
      more += `<div class="mm-config-row">${num('trig:dx', 'Offset right', t.dx, 8)}${num('trig:dy', 'Offset up', t.dy, 8)}</div>`;
      if (o.cfg?.trig) more += `<div class="mm-config-row"><button class="mm-tool" data-act="trigReset">Game's own size</button></div>`;
      more += `<div class="mm-config-sub">${isLongFall(item) ? (item.name === 'Long fall start' ? 'Falling through this box starts the game\'s long fall: the player falls faster and survives the drop. Put a Long fall end where it lands.' : 'Falling through this box ends a long fall.') : 'Touching this box sets where the player respawns.'} Drag its edges on the map to size it.</div>`;
    }
    for (const [f, def] of Object.entries(item.fields || {})) more += `<div class="mm-config-row">${num('field:' + f, FIELD_LABELS[f] || f, cfg.fields?.[f] ?? def, 0.1)}</div>`;
    html += sec('settings', item.upgradeBox ? 'Upgrade' : zip ? 'Zip mover' : 'Settings', more);
    html += transformSection() + sec('group', 'Group & layer', groupRow() + depthRow() + stackButtons());
  } else if (selection.kind === 'base') {
    const o = baseObjects.find((x) => x.id === selection.id);
    if (!o || removedObjects.has(o.id)) { selection = null; el.hidden = true; return; }
    html += `<div class="mm-config-title">${o.kind === 'upgrade' ? boxKindName(o) : o.label}<span>level ${o.kind === 'upgrade' ? 'upgrade box' : 'object'}</span></div>`;
    html += actionBar();
    if (o.box) html += sec('settings', 'Upgrade', baseUpgradeHtml(o, num) + (o.box.door ? `<div class="mm-config-sub" style="display:block">Opens ${o.box.door.path.includes('Atom') ? 'the atom room\'s gate' : 'the door to the facility\'s lower section'} (the yellow line) - shut until this box is bought, in custom maps too.</div>` : ''));
    html += transformSection() + sec('group', 'Group & layer', groupRow() + levelOrderRow() + stackButtons());
  } else if (selection.kind === 'blocks' || selection.kind === 'moss') {
    html += `<div class="mm-config-title">${selection.what}<span>${selection.cells.length} cell${selection.cells.length === 1 ? '' : 's'} - drag or arrow keys to move</span></div>`;
    html += actionBar();
    if (selection.kind === 'blocks') html += sec('group', 'Group', groupRow());
  } else if (selection.kind === 'decotiles') {
    html += `<div class="mm-config-title">Level decoration<span>${selection.cells.length} tile${selection.cells.length === 1 ? '' : 's'} · ${layerLabel(selection.layer)}</span></div>`;
  } else if (selection.kind === 'basecells') {
    html += `<div class="mm-config-title">${selection.what}<span>level · ${selection.cells.length} cell${selection.cells.length === 1 ? '' : 's'}</span></div>`;
  } else if (selection.kind === 'scene') {
    const p = sceneList?.items.find((x) => x.id === selection.id);
    if (!p || removedScene.has(p.id)) { selection = null; el.hidden = true; return; }
    html += `<div class="mm-config-title">${prettySprite(p.p.split('/').pop().replace(/ \(\d+\)$/, ''))}<span>level decoration</span></div>`;
    html += actionBar() + transformSection() + sec('group', 'Group & layer', groupRow() + levelOrderRow() + stackButtons());
  } else if (selection.kind === 'gate') {
    const c = courseById(selection.course);
    if (selection.which === 'spawn') {
      if (!draft.spawn) { selection = null; el.hidden = true; return; }
      html += `<div class="mm-config-title">Spawn<span>where the player starts</span></div>`;
    } else if (selection.which === 'screen') {
      if (!courseScreen(c)) { selection = null; el.hidden = true; return; }
      html += `<div class="mm-config-title" style="color:${courseColor(c.id)}">Course ${courseNumber(c.id)}<span>screen</span></div>`;
      html += `<div class="mm-config-sub">Shows the course's reward, best time and clones in the game. Drag it anywhere; Delete puts it back beside the start gate.</div>`;
    } else {
      if (!c?.[selection.which]) { selection = null; el.hidden = true; return; }
      const n = courseNumber(c.id), rw = c.reward || { currency: 'Cash', amount: 0 };
      html += `<div class="mm-config-title" style="color:${courseColor(c.id)}">Course ${n}<span>${selection.which === 'start' ? 'start gate' : 'end gate'}</span></div>`;
      html += `<div class="mm-config-row"><label>Belongs to<select class="mm-input" data-cfg="gatecourse">${courses().map((x) => `<option value="${x.id}"${x.id === c.id ? ' selected' : ''}>Course ${courseNumber(x.id)}</option>`).join('')}<option value="new">New course</option></select></label></div>`;
      html += `<div class="mm-config-row"><label>Reward<select class="mm-input" data-cfg="reward:currency">${CURRENCIES.map(([v, t]) => `<option value="${v}"${v === rw.currency ? ' selected' : ''}>${t}</option>`).join('')}</select></label><label>Amount<input class="mm-input" type="number" min="0" data-cfg="reward:amount" value="${rw.amount}"></label></div>`;
      const linkedN = placed.filter((o) => o.course === c.id).length;
      html += `<div class="mm-config-sub">${c.start && c.end ? 'Start and end linked' : 'Needs a ' + (c.start ? 'end' : 'start') + ' gate'} · ${linkedN} linked item${linkedN === 1 ? '' : 's'}</div>`;
      html += `<div class="mm-config-row"><button class="mm-tool" data-act="delcourse">Delete course ${n}</button></div>`;
    }
  } else if (selection.kind === 'tile') {
    const t = tiles.get(selection.key);
    if (!t) { selection = null; el.hidden = true; return; }
    html += `<div class="mm-config-title">${t.tile}<span>${layerLabel(t.layer)}</span></div>`;
    html += `<div class="mm-config-thumb">${thumbHtml({ art: t.tile }, 48)}</div>`;
    html += actionBar();
    html += sec('transform', 'Transform', `<div class="mm-config-row"><button class="mm-tool" data-act="rotL">⟲ Rotate</button><button class="mm-tool" data-act="rotR">Rotate ⟳</button></div><div class="mm-config-row">${chk('fx', 'Flip X', t.fx)}${chk('fy', 'Flip Y', t.fy)}</div>`);
    const g = layerGrid(t.layer).size, choices = (base?.art?.layers || []).filter((l) => l.size === g && !['moss', 'OvergrowthMoss', 'OOB areas'].includes(l.name)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    html += sec('group', 'Group & layer', groupRow() + `<div class="mm-config-row"><label>Game layer (back to front)<select class="mm-input" data-cfg="tilelayer">${choices.map((l) => `<option value="${l.name}"${l.name === t.layer ? ' selected' : ''}>${layerLabel(l.name)} (${l.order ?? 0})</option>`).join('')}</select></label></div>`);
  } else if (selection.kind === 'csprite') {
    const cs = csprites[selection.index];
    if (!cs) { selection = null; el.hidden = true; return; }
    html += cs.game ? `<div class="mm-config-title">Plant<span>${cs.game}</span></div>` : `<div class="mm-config-title">Image<span>${assetName(cs.image)}</span></div>`;
    html += actionBar() + transformSection();
    if (!cs.game) html += `<div class="mm-config-row"><label>Image<select class="mm-input" data-cs="image">${backgroundOptions(cs.image).replace(/<option value="level"[^>]*>[^<]*<\/option>/, '')}</select></label></div>`;
    html += sec('group', 'Group & layer', groupRow() + depthRow() + stackButtons());
  } else if (selection.kind === 'mtrig') {
    const tg = triggers[selection.index];
    if (!tg) { selection = null; el.hidden = true; return; }
    const k = trigKind(tg), d = TRIGGER_KINDS[k] || TRIGGER_KINDS.media, esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const num = (f, label, v, step = 16) => `<label>${label}<input class="mm-input" type="number" step="${step}" data-trig="${f}" value="${v}"></label>`;
    html += `<div class="mm-config-title">${d.label} trigger<span>${d.about}</span></div>`;
    html += `<div class="mm-config-row"><label>Kind<select class="mm-input" data-trig="kind">${Object.entries(TRIGGER_KINDS).map(([v, x]) => `<option value="${v}"${v === k ? ' selected' : ''}>${x.label}</option>`).join('')}</select></label></div>`;
    if (k === 'media') {
      const bgv = !tg.background ? '' : tg.background === 'level' ? 'level' : tg.background.image;
      html += `<div class="mm-config-row"><label>Music<select class="mm-input" data-trig="music">${musicOptions(tg.music || '', true)}</select></label></div>`;
      html += `<div class="mm-config-row"><label>Background<select class="mm-input" data-trig="background">${backgroundOptions(bgv, true)}</select></label></div>`;
      if (tg.background?.image) html += `<div class="mm-config-row"><label>Parallax<input class="mm-input" type="number" min="0" max="1" step="0.05" data-trig="parallax" value="${tg.background.parallax ?? 0.8}"></label><label>Scale<input class="mm-input" type="number" min="0.05" step="0.1" data-trig="scale" value="${tg.background.scale ?? 1}"></label></div>`;
    }
    if (GROUP_KINDS.has(k)) {
      const all = [...new Set([...cellGroups.values(), ...[...WORLD_KINDS].flatMap((x) => listOfKind(x).map((i) => i.group))].filter(Boolean))].sort();
      const m = groupMembers(tg.group || '');
      html += `<div class="mm-config-row"><label>Group<input class="mm-input" type="text" list="mm-groups" data-trig="group" value="${esc(tg.group)}"><datalist id="mm-groups">${all.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label></div>`;
      html += `<div class="mm-config-sub">${m.targets.length + m.cells.length ? `${m.targets.length} thing${m.targets.length === 1 ? '' : 's'} and ${m.cells.length} cell${m.cells.length === 1 ? '' : 's'} in it, outlined.` : 'Nothing is in this group yet - select things and give them this group.'}</div>`;
    }
    if (k === 'move') {
      html += `<div class="mm-config-row">${num('dx', 'Right', tg.dx || 0)}${num('dy', 'Up', tg.dy || 0)}</div>`;
      html += `<div class="mm-config-row">${num('time', 'Seconds', tg.time ?? 1, 0.1)}<label class="mm-check"><input type="checkbox" data-trig="back"${tg.back ? ' checked' : ''}> Back on leaving</label></div>`;
    }
    if (MARKER_KINDS.has(k)) html += `<div class="mm-config-row">${num('tx', 'Marker right', tg.tx || 0)}${num('ty', 'Marker up', tg.ty || 0)}</div><div class="mm-config-sub">The circle is where the player ends up.</div>`;
    if (k === 'zoom') html += `<div class="mm-config-row">${num('size', 'Zoom (1 = normal, 2 = see twice as far)', tg.size || 1, 0.1)}</div>`;
    if (k === 'message') html += `<div class="mm-config-row"><label>Text<textarea class="mm-input" rows="2" data-trig="text">${esc(tg.text)}</textarea></label></div><div class="mm-config-row">${num('seconds', 'Seconds on screen', tg.seconds ?? 3, 0.5)}</div>`;
    if (k !== 'zoom' && k !== 'kill') html += `<div class="mm-config-row"><label class="mm-check"><input type="checkbox" data-trig="once"${tg.once ? ' checked' : ''}> Only the first time</label></div>`;
    html += `<div class="mm-config-row"><label>Width<input class="mm-input" type="number" min="16" step="16" data-trig="w" value="${tg.w}"></label><label>Height<input class="mm-input" type="number" min="16" step="16" data-trig="h" value="${tg.h}"></label></div>`;
  } else if (selection.kind === 'xspawn') {
    html += `<div class="mm-config-title">Spawn ${selection.index + 2}<span>Q / E in game cycles the spawns</span></div>`;
    html += actionBar() + transformSection();
  } else if (selection.kind === 'sign') {
    const sg = signs[selection.index];
    if (!sg) { selection = null; el.hidden = true; return; }
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    html += `<div class="mm-config-title">Text<span>says anything, in the level's sign style</span></div>`;
    html += actionBar();
    html += `<div class="mm-config-row"><label>Text<textarea class="mm-input" rows="2" data-sign="t">${esc(sg.t)}</textarea></label></div>`;
    html += `<div class="mm-config-row"><label>Colour<input class="mm-input" type="color" data-sign="c" value="${sg.c || SIGN_COLOR}"></label></div>`;
    html += `<div class="mm-config-sub">The text shrinks to fit its box, like the game's signs.</div>`;
    html += transformSection() + sec('group', 'Group & layer', groupRow() + depthRow() + stackButtons());
  } else if (selection.kind === 'fspike') {
    const f = freeSpikes[selection.index];
    if (!f) { selection = null; el.hidden = true; return; }
    html += `<div class="mm-config-title">${{ spike: 'Spike', dark: 'Dark spike', blue: 'Blue spike', orange: 'Orange spike', true: 'True spike' }[f.c]}<span>off the grid</span></div>`;
    html += actionBar();
    html += `<div class="mm-config-sub">Placed with a finer snap than a cell. Drag it, or nudge it with the arrow keys.</div>`;
    html += transformSection() + sec('group', 'Group & layer', groupRow() + depthRow() + stackButtons());
  } else if (selection.kind === 'cell') {
    const sp = spikes.get(selection.k), kind = selection.vine ? 'Vine' : sp ? { spike: 'Spike', dark: 'Dark spike', blue: 'Blue spike', orange: 'Orange spike', true: 'True spike' }[sp.c] : { ground: 'Ground', dark: 'Dark ground', blue: 'Blue block', orange: 'Orange block' }[blocks.get(selection.k)];
    html += `<div class="mm-config-title">${kind}<span>cell ${selection.k}</span></div>`;
    html += actionBar();
    if (sp || selection.vine) html += `<div class="mm-config-row"><button class="mm-tool" data-act="rotCell">⟳ Rotate (R)</button></div>`;
    html += sec('group', 'Group', groupRow());
  } else {
    const { x0, y0, x1, y1 } = selection;
    html += `<div class="mm-config-title">Region<span>${x1 - x0 + 1} x ${y1 - y0 + 1} cells</span></div>`;
    html += actionBar(true);
    html += `<div class="mm-config-row"><button class="mm-tool" data-act="rflipx" title="Mirror left-right (F)">↔ Flip</button><button class="mm-tool" data-act="rflipy" title="Mirror top-bottom (Shift+F)">↕ Flip</button><button class="mm-tool" data-act="rrot" title="Turn 90° (R)">⟲ Turn</button></div>`;
    html += `<div class="mm-config-sub">Copying takes the level's own tiles too - paste them anywhere.</div>`;
  }
  if (!html.includes('mm-actions')) html = html.replace(/(<div class="mm-config-title"[^]*?<\/div>)/, '$1' + actionBar());
  showPanel(el, html);
  el.querySelectorAll('[data-cfg]').forEach((inp) => inp.addEventListener('change', () => applyConfig(inp)));
  el.querySelectorAll('input').forEach((inp) => inp.addEventListener('keydown', (e) => e.stopPropagation()));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => configAction(b.dataset.act)));
  bindGroupFields(el);
  bindTransform(el);
  bindDepth(el);
  bindSections(el);
  el.querySelectorAll('[data-cs]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', async () => {
      const cs = csprites[selection?.index];
      if (!cs) return;
      const f = inp.dataset.cs;
      if (f === 'image') {
        const v = await resolveMediaChoice('image', inp.value);
        if (!v) { renderConfig(); return; }
        pushUndo(); cs.image = v;
      } else if (f === 'fx' || f === 'fy') { pushUndo(); cs[f] = inp.checked || undefined; }
      else { const n = Number(inp.value); if (!Number.isFinite(n)) return; pushUndo(); cs[f] = f === 'scale' ? Math.max(0.05, n) : n; }
      saveDraft(); renderConfig(); requestDraw();
    });
  });
  el.querySelectorAll('[data-trig]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', async () => {
      const tg = triggers[selection?.index];
      if (!tg) return;
      const f = inp.dataset.trig;
      if (f === 'kind') { pushUndo(); const n = newTrigger(inp.value, tg.x, tg.y); for (const x of Object.keys(tg)) if (!['x', 'y', 'w', 'h', 'once'].includes(x)) delete tg[x]; Object.assign(tg, n, { w: tg.w, h: tg.h }); }
      else if (f === 'group' || f === 'text') { pushUndo(); tg[f] = inp.value; }
      else if (f === 'once' || f === 'back') { pushUndo(); tg[f] = inp.checked || undefined; }
      else if (f === 'music' || f === 'background') {
        const v = await resolveMediaChoice(f === 'music' ? 'music' : 'image', inp.value);
        if (v === null) { renderConfig(); return; }
        pushUndo();
        if (f === 'music') { if (v) tg.music = v; else delete tg.music; }
        else if (!v) delete tg.background;
        else tg.background = v === 'level' ? 'level' : { parallax: 0.8, scale: 1, ...(typeof tg.background === 'object' ? tg.background : {}), image: v };
      } else {
        const n = Number(inp.value);
        if (!Number.isFinite(n)) return;
        pushUndo();
        if (f === 'w' || f === 'h') tg[f] = Math.max(16, n);
        else if (['dx', 'dy', 'tx', 'ty', 'time', 'size', 'seconds'].includes(f)) tg[f] = f === 'size' ? Math.max(0.2, n) : f === 'time' || f === 'seconds' ? Math.max(0, n) : n;
        else if (typeof tg.background === 'object') tg.background = { ...tg.background, [f]: f === 'parallax' ? Math.min(1, Math.max(0, n)) : Math.max(0.05, n) };
      }
      saveDraft();
      renderConfig();
      requestDraw();
    });
  });
  el.querySelectorAll('[data-sign]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener(inp.tagName === 'TEXTAREA' ? 'input' : 'change', () => {
      const sg = signs[selection?.index];
      if (!sg) return;
      if (!inp.dataset.typing) { pushUndo(); if (inp.tagName === 'TEXTAREA') inp.dataset.typing = '1'; }
      const f = inp.dataset.sign;
      if (f === 't' || f === 'c') sg[f] = inp.value;
      else { const v = Number(inp.value); if (!Number.isFinite(v)) return; sg[f] = f === 'r' ? v : Math.max(8, v); }
      saveDraft();
      requestDraw();
    });
    inp.addEventListener('blur', () => { delete inp.dataset.typing; });
  });
}

function applyConfig(inp) {
  const id = inp.dataset.cfg;
  if (id.startsWith('up:')) return applyUpgradeConfig(id.slice(3), inp.value);
  if (id.startsWith('bu:')) return applyBaseUpgrade(id.slice(3), inp.value);
  if (id.startsWith('tp:')) return applyTeleport(id.slice(3), inp.value);
  if (id === 'link' || id === 'gatecourse' || id.startsWith('reward:')) return applyCourseConfig(id, inp.value);
  if (id === 'tilelayer') {
    const t = tiles.get(selection.key);
    if (!t || t.layer === inp.value) return;
    pushUndo();
    const c = tileCenter(t.layer, selection.key), nk = tileKeyAt(inp.value, c.x, c.y), g = cellGroups.get(selection.key);
    tiles.delete(selection.key);
    tiles.set(nk, { ...t, layer: inp.value });
    if (g) { cellGroups.delete(selection.key); cellGroups.set(nk, g); }
    selection = { ...selection, key: nk };
    saveDraft(); renderConfig(); requestDraw();
    return;
  }
  const v = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
  if (inp.type !== 'checkbox' && !Number.isFinite(v)) return;
  pushUndo();
  if (selection.kind === 'tile') {
    const t = tiles.get(selection.key);
    tiles.set(selection.key, { ...t, m: undefined, [id]: v });
  } else if (selection.kind === 'object') {
    const o = placed[selection.index], cfg = { ...(o.cfg || {}) };
    if (id === 'x' || id === 'y') o[id] = v;
    else if (id.startsWith('field:')) cfg.fields = { ...cfg.fields, [id.slice(6)]: v };
    else if (id.startsWith('trig:')) { const k = id.slice(5); cfg.trig = { ...trigOf(o), [k]: k === 'w' || k === 'h' ? Math.max(8, v) : v }; }
    else if (id.startsWith('zip')) {
      const cur = zipConfig(o), z = { ...cfg.zip };
      const len = Math.hypot(...cur.end), ang = Math.atan2(cur.end[1], cur.end[0]);
      if (id === 'zipLen') z.end = snapZipEnd(Math.cos(ang) * v, Math.sin(ang) * v);
      if (id === 'zipAng') z.end = snapZipEnd(Math.cos((v * Math.PI) / 180) * len, Math.sin((v * Math.PI) / 180) * len);
      if (z.end && !z.end[0] && !z.end[1]) delete z.end;
      if (id === 'zipTime') z.time = v;
      if (id === 'zipBack') z.backTime = v;
      if (id === 'zipAuto') z.auto = v;
      if (id === 'zipPauseReturn') z.pauseReturn = Math.max(0, v);
      if (id === 'zipPauseMove') z.pauseMove = Math.max(0, v);
      if (id === 'zipSpan') z.span = Math.max(CELL, Math.round(v / CELL) * CELL);
      cfg.zip = z;
    } else cfg[id] = v;
    o.cfg = cfg;
  }
  saveDraft();
  renderConfig();
  requestDraw();
}

function applyUpgradeConfig(field, raw) {
  const o = placed[selection.index], u = { ...(o.cfg?.upgrade || {}) };
  if ((field === 'kind' || field === 'currency') && !raw.trim()) return;
  if (field === 'kind' || field === 'currency' || field === 'label') u[field] = raw.trim();
  else if (field === 'prices') u.prices = raw.split(/[\s,;]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  else {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    u[field] = field === 'max' ? Math.max(1, Math.round(v)) : field === 'price' || field === 'add' ? Math.max(0, v) : Math.max(0.01, v);
  }
  pushUndo();
  o.cfg = { ...o.cfg, upgrade: u };
  saveDraft();
  renderConfig();
  requestDraw();
}

function applyCourseConfig(id, raw) {
  pushUndo();
  if (id === 'link') {
    const o = placed[selection.index];
    if (raw) o.course = raw; else delete o.course;
  } else if (id === 'gatecourse') {
    const from = courseById(selection.course), which = selection.which, g = from?.[which];
    if (!g) return;
    const to = raw === 'new' ? newCourse() : courseById(raw);
    if (!to || to === from) return;
    const other = to[which];
    to[which] = g;
    from[which] = other || null;
    selection = { kind: 'gate', which, course: to.id };
    draft.activeCourse = to.id;
    pruneCourses();
  } else {
    const c = courseById(selection.course);
    if (!c) return;
    const rw = { currency: 'Cash', amount: 0, ...(c.reward || {}) };
    if (id === 'reward:currency') rw.currency = raw; else rw.amount = Math.max(0, Number(raw) || 0);
    c.reward = rw;
  }
  saveDraft();
  renderConfig();
  requestDraw();
}

function configAction(act) {
  if (act === 'delete') return deleteSelection();
  if (act.startsWith('stack:')) return restack(act.slice(6));
  if (act === 'rotFree') { const f = freeSpikes[selection?.index]; if (!f) return; pushUndo(); f.q = ((f.q ?? 0) + 3) % 4; saveDraft(); requestDraw(); return; }
  if (act === 'platform') return setPlatformEdit(platformEdit === selection?.index ? null : selection?.index);
  if (act === 'platformReset') {
    const o = placed[selection.index];
    pushUndo();
    const { cells, grid, ...rest } = o.cfg?.zip || {};
    o.cfg = { ...o.cfg, zip: rest };
    saveDraft();
    renderConfig();
    requestDraw();
    return;
  }
  if (act === 'rflipx') return transformRegion('x');
  if (act === 'rflipy') return transformRegion('y');
  if (act === 'rrot') return transformRegion('r');
  if (act === 'baseReset') {
    pushUndo();
    delete draft.baseEdits[selection.id];
    saveDraft();
    renderConfig();
    requestDraw();
    return;
  }
  if (act === 'delcourse') {
    pushUndo();
    draft.courses = courses().filter((c) => c.id !== selection.course);
    pruneCourses();
    selection = null;
    saveDraft();
    renderConfig();
    requestDraw();
    return;
  }
  if (act === 'trigReset') { const o = placed[selection?.index]; if (o?.cfg?.trig) { pushUndo(); const c = { ...o.cfg }; delete c.trig; o.cfg = c; saveDraft(); renderConfig(); requestDraw(); } return; }
  if (act === 'hints') { showHints = !showHints; try { localStorage.setItem('mapMakerHints', showHints ? '1' : '0'); } catch { /* private window */ } return renderConfig(); }
  if (act === 'copy') return copySelection();
  if (act === 'dup') return duplicateSelection();
  if (act === 'rotCell') { hover = cellOf(...(() => { const [cx, cy] = unkey(selection.k); const w = cellWorld(cx, cy); return [w.x + 1, w.y + 1]; })()); return rotateSpikeAtHover(); }
  if (selection?.kind !== 'tile') return;
  const t = tiles.get(selection.key);
  pushUndo();
  tiles.set(selection.key, { ...t, m: undefined, q: (((t.q || 0) + (act === 'rotR' ? 1 : 3)) % 4) });
  saveDraft();
  renderConfig();
  requestDraw();
}

// Each placed long-fall start, joined to the end below it (or a hint to place one).
function drawLongFallLinks() {
  const starts = placed.filter((o) => catalogItem(o)?.name === 'Long fall start'), ends = placed.filter((o) => catalogItem(o)?.name === 'Long fall end');
  for (const st of starts) {
    const end = ends.filter((e) => e.y < st.y && Math.abs(e.x - st.x) < 1500).sort((a, b) => b.y - a.y)[0];
    const a = toScreen(st.x, st.y);
    ctx.save();
    ctx.strokeStyle = COLORS.fall; ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = CALM ? 0 : (performance.now() / 50) % 20;
    ctx.globalAlpha = 0.8;
    if (end) { const b = toScreen(end.x, end.y); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    else if (cam.scale >= 0.1) { ctx.font = '600 11px sans-serif'; ctx.fillStyle = COLORS.fall; ctx.textAlign = 'center'; ctx.fillText('↓ place a Long fall end where it lands', a.x, a.y + trigOf(st).h / 2 * cam.scale + 16); }
    ctx.restore();
  }
}
function drawDoorLinks() {
  for (const t of targetsOf(selection)) {
    const o = t.kind === 'base' && levelThing(t), door = o?.box?.door;
    if (!door) continue;
    const a = toScreen(o.x, o.y), b = toScreen(door.x, door.y);
    ctx.save();
    ctx.strokeStyle = '#f0c040'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = CALM ? 0 : -(performance.now() / 40) % 22;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
    drawBadge('toggle', b.x, b.y, '#f0c040', 'OPENS THIS DOOR');
  }
}
function drawSelection() {
  drawLongFallLinks();
  if (!selection) return;
  drawDoorLinks();
  const tsel = selection.kind === 'mtrig' && triggers[selection.index];
  if (tsel && GROUP_KINDS.has(trigKind(tsel)) && tsel.group) {
    const m = groupMembers(tsel.group);
    ctx.save();
    ctx.strokeStyle = TRIGGER_KINDS[trigKind(tsel)].color;
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 3]);
    m.targets.forEach(drawTarget);
    if (m.cells.length) outlineCells(m.cells, cellRect);
    ctx.restore();
  }
  ctx.save();
  ctx.strokeStyle = COLORS.start;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  if (!CALM) {
    const now = performance.now();
    ctx.lineDashOffset = -(now / 60) % 16;
    if (!drawSelection.timer) drawSelection.timer = setTimeout(() => { drawSelection.timer = 0; if (selection) requestDraw(); }, 120);
  }
  for (const t of targetsOf(selection)) {
    if (t.kind !== 'region') { drawTarget(t); continue; }
    const a = cellRect(t.x0, t.y1), b = cellRect(t.x1, t.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(65, 248, 141, 0.05)';
    ctx.fillRect(a.x, a.y, b.x + b.w - a.x, b.y + b.h - a.y);
    ctx.globalAlpha = 0.35;
    ctx.strokeRect(a.x, a.y, b.x + b.w - a.x, b.y + b.h - a.y);
    ctx.restore();
    const cells = regionContent(t);
    if (cells.length) { ctx.save(); ctx.setLineDash([]); ctx.lineWidth = 2; outlineCells(cells, (x, y) => cellRect(x, y)); ctx.stroke(); ctx.restore(); }
  }
  if (selection.kind === 'object') {
    const o = placed[selection.index], h = o && zipHandle(o);
    if (h) {
      const c = toScreen(o.x, o.y), hc = toScreen(h.x, h.y);
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(hc.x, hc.y); ctx.stroke();
      ctx.fillStyle = COLORS.start;
      ctx.beginPath(); ctx.arc(hc.x, hc.y, 7, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function editorState() {
  saveDraft();
  const { name, description, useBase, baseState, blocks: b, spikes: sp, vines: v, tiles: t, moss: mo, arrows: ar, placed: pl, freeSpikes: fs, signs: sg, triggers: tg, csprites: cs2, removed: r, removedVines: rv, removedObjects: ro, removedScene: rs, removedDeco: rd, movedScene: ms, movedObjects: mob, levelOrder: lo, levelTf: ltf, levelGroups: lg, courses: cs, baseEdits: be, spawn, player, ownProgress, music, background, assets, stageEdits, cellGroups: cg, hiddenGroups, xspawns: xs } = draft;
  return { version: 1, name, description, useBase, baseState, blocks: b, spikes: sp, vines: v, tiles: t, moss: mo, arrows: ar, placed: pl, freeSpikes: fs, signs: sg, triggers: tg, csprites: cs2, removed: r, removedVines: rv, removedObjects: ro, removedScene: rs, removedDeco: rd, movedScene: ms, movedObjects: mob, levelOrder: lo, levelTf: ltf, levelGroups: lg, courses: cs, baseEdits: be, spawn, player, ownProgress, music, background, assets, stageEdits, cellGroups: cg, hiddenGroups, xspawns: xs };
}

async function readMapFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const dv = new DataView(buf.buffer);
    for (let p = 0; p + 30 < buf.length && dv.getUint32(p, true) === 0x04034b50;) {
      const method = dv.getUint16(p + 8, true), size = dv.getUint32(p + 18, true), nameLen = dv.getUint16(p + 26, true), extra = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + nameLen));
      const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
      if (name.endsWith('map.json')) {
        if (method === 0) return new TextDecoder().decode(data);
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(stream).text();
      }
      p += 30 + nameLen + extra + size;
    }
    throw new Error('no map.json in that zip');
  }
  return new TextDecoder().decode(buf);
}

async function loadMapFile(file) {
  let map;
  try { map = JSON.parse(await readMapFile(file)); } catch (e) { flash('Couldn\'t read that map: ' + e.message, true); return; }
  return openMap(map, file.name);
}

async function toggleInstalledList() {
  const list = root.querySelector('#mm-load-list');
  if (!list.hidden) { list.hidden = true; return; }
  list.hidden = false;
  list.innerHTML = '<div class="mm-config-sub">Loading…</div>';
  let maps = [];
  try { maps = await window.__TAURI__.core.invoke('list_maps'); } catch (e) { list.innerHTML = `<div class="mm-config-sub mm-warn">Couldn't list installed maps: ${e}</div>`; return; }
  if (!maps.length) { list.innerHTML = '<div class="mm-config-sub">No maps installed.</div>'; return; }
  list.innerHTML = maps.map((m) => `<button class="mm-tool mm-load-item" data-id="${m.id}" title="${(m.description || '').replace(/"/g, '&quot;')}">${m.name || m.id}<span>${m.id === 'map-maker-test' ? 'last test' : m.id}</span></button>`).join('');
  list.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const text = await window.__TAURI__.core.invoke('read_map', { id: b.dataset.id });
      await openMap(JSON.parse(text), b.dataset.id, b.dataset.id);
      list.hidden = true;
    } catch (e) {
      flash(/read_map|not found|unknown command/i.test(String(e)) ? 'This Recharge build can\'t read installed maps yet.' : 'Couldn\'t open that map: ' + e, true);
    }
  }));
}

async function openMap(map, label, installedId = null) {
  const st = map.editor;
  if (!st) { flash('That map wasn\'t made in this editor (no editor data in it).', true); return; }
  pushUndo();
  Object.assign(draft, { blocks: {}, spikes: {}, vines: {}, tiles: {}, moss: {}, arrows: [], placed: [], freeSpikes: [], signs: [], triggers: [], csprites: [], xspawns: [], cellGroups: {}, hiddenGroups: [], music: undefined, background: undefined, stageEdits: undefined, courses: [], baseEdits: {}, start: null, end: null, player: { ...DEFAULT_PLAYER }, ownProgress: false, removed: [], removedVines: [], removedObjects: [], removedScene: [], removedDeco: [], movedScene: {}, movedObjects: {}, levelOrder: {}, levelTf: {}, levelGroups: {} }, st);
  if (draft.useBase && !base) { try { await loadBase(true); } catch { draft.useBase = false; } }
  loadDraft(JSON.parse(JSON.stringify(draft)), map.tileLayers ? { layers: map.tileLayers, mats: map.mats || [] } : null);
  applyBaseState();
  selection = null;
  saveDraft();
  syncBaseUi();
  draft.savedId = installedId && installedId !== TEST_MAP_ID ? installedId : null;
  if (installedId && window.__TAURI__) fetchInstalledAssets(installedId).then(requestDraw);
  draft.savedAt = null;
  saveDraft();
  syncSaveState();
  root.querySelector('#mm-name').value = draft.name || '';
  root.querySelector('#mm-desc').value = draft.description || '';
  renderConfig();
  requestDraw();
  flash(`Loaded ${draft.name || label}`);
}

function isSolid(cx, cy) {
  const k = key(cx, cy);
  if (blocks.has(k) || mossCovers(cx, cy)) return true;
  return baseOn() && (groundSet.has(k) || mossSet.has(k)) && !removed.has(k);
}

const BASE_DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function seats(cx, cy) {
  return [0, 2, 1, 3].filter((q) => isSolid(cx + BASE_DIR[q][0], cy + BASE_DIR[q][1]));
}

function neighbourTurn(cx, cy) {
  const sp = spikes.get(key(cx, cy));
  if (sp) return sp.q ?? seats(cx, cy)[0] ?? 0;
  const h = baseOn() && baseHaz.get(key(cx, cy));
  return h && h.kind === 'spike' && !removed.has(key(cx, cy)) ? h.q : null;
}

function autoSpikeTurn(cx, cy) {
  for (const [dx, dy] of [[1, 0], [-1, 0]]) { const n = neighbourTurn(cx + dx, cy + dy); if (n === 0 || n === 2) return n; }
  for (const [dx, dy] of [[0, 1], [0, -1]]) { const n = neighbourTurn(cx + dx, cy + dy); if (n === 1 || n === 3) return n; }
  const options = seats(cx, cy);
  if (!options.length) return 0;
  for (const q of options) {
    const along = q % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    if (along.some(([dx, dy]) => neighbourTurn(cx + dx, cy + dy) === q)) return q;
  }
  return options[0];
}

const PLATE = { TL: 56, T: 57, TR: 58, L: 63, C: 64, R: 65, BL: 70, B: 71, BR: 72 };
const PLATE3 = { TL: 0, T: 1, TR: 2, L: 3, C: 4, R: 5, BL: 6, B: 7, BR: 8 };
// The level's other block tilesets, each autotiled on its own game tilemap like ground is.
const ASSET_PLATE = (tl, l, bl, bar) => ({ TL: tl, T: tl + 1, TR: tl + 2, L: l, C: l + 1, R: l + 2, BL: bl, B: bl + 1, BR: bl + 2, ...(bar ? { h: [bar, bar + 1, bar + 2] } : {}) });
const BLOCK_SETS = {
  panel: { label: 'Panel', group: 'Solid', layer: 'ground', family: 'ground1_tileset_', plate: PANEL_SET, thumb: 'ground1_tileset_6', color: '#55584f' },
  darkpanel: { label: 'Dark panel', group: 'Solid', layer: 'ground', family: 'dark_ground_tileset_', plate: PANEL_SET, thumb: 'dark_ground_tileset_6', color: '#3a3c40' },
  grate: { label: 'Grate', group: 'Solid', layer: 'ground', family: 'gril_tileset_', plate: GRATE_SET, thumb: 'gril_tileset_0', color: '#5d6160' },
  plate: { label: 'Plate', group: 'Solid', layer: 'ground', family: 'TILE V2 Tileset_', plate: PLATE3, thumb: 'TILE V2 Tileset_4', color: '#50534c' },
  floorplate: { label: 'Floor plate', group: 'Solid', layer: 'ground', family: 'FLOOR V2 Tileset_', plate: PLATE3, thumb: 'FLOOR V2 Tileset_1', color: '#50534c' },
  lightplate: { label: 'Light plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(241, 253, 265, 186), thumb: 'Asset_Sheet_254', color: '#6a6c68' },
  lightfloor: { label: 'Light floor plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(192, 211, 226, 186), thumb: 'Asset_Sheet_193', color: '#6a6c68' },
  darkplate: { label: 'Dark plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(238, 250, 262, 235), thumb: 'Asset_Sheet_251', color: '#35373a' },
  darkfloor: { label: 'Dark floor plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(189, 207, 223, 235), thumb: 'Asset_Sheet_190', color: '#35373a' },
  blueplate: { label: 'Blue plate', group: 'Colour swap', layer: 'blueBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(229, 244, 256, 220), thumb: 'Asset_Sheet_245', color: COLORS.blue },
  bluefloor: { label: 'Blue floor plate', group: 'Colour swap', layer: 'blueBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(180, 196, 214, 220), thumb: 'Asset_Sheet_181', color: COLORS.blue },
  orangeplate: { label: 'Orange plate', group: 'Colour swap', layer: 'orangeBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(232, 247, 259, 203), thumb: 'Asset_Sheet_248', color: COLORS.orange },
  orangefloor: { label: 'Orange floor plate', group: 'Colour swap', layer: 'orangeBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(183, 200, 217, 203), thumb: 'Asset_Sheet_184', color: COLORS.orange },
  breakable: { label: 'Breakable ground', group: 'Overgrowth', layer: 'OvergrowthDestroyedGround', family: 'ground1_tileset_', plate: PLATE, thumb: 'ground1_tileset_59', color: '#6b5d48' },
  illusory: { label: 'Illusory wall', group: 'Walk-through', layer: 'Ilusorywalls', family: 'ground1_tileset_', plate: PLATE, thumb: 'ground1_tileset_59', color: 'rgba(74, 77, 68, 0.55)' },
  bgwall: { label: 'Background wall', group: 'Walk-through', layer: 'Background', family: 'TILE V2 Tileset_', plate: PLATE3, thumb: 'TILE V2 Tileset_4', color: '#26282b' },
  bgfloor: { label: 'Background floor plate', group: 'Walk-through', layer: 'Background', family: 'FLOOR V2 Tileset_', plate: PLATE3, thumb: 'FLOOR V2 Tileset_1', color: '#26282b' },
  bgplate: { label: 'Background dark plate', group: 'Walk-through', layer: 'Background', family: 'Asset_Sheet_', plate: ASSET_PLATE(238, 250, 262, 235), thumb: 'Asset_Sheet_251', color: '#1d1e21' },
  bglight: { label: 'Background ground', group: 'Walk-through', layer: 'Background', family: 'ground1_tileset_', plate: PLATE, thumb: 'ground1_tileset_59', color: '#2c2e2a' },
  bgdark: { label: 'Dark background ground', group: 'Walk-through', layer: 'Background', family: 'dark_ground_tileset_', plate: PLATE, thumb: 'dark_ground_tileset_59', color: '#1d1e21' },
};
const blockName = (kind) => BLOCK_NAMES[kind] || BLOCK_SETS[kind]?.label || 'Blocks';
function blockArt(kind, cx, cy) {
  if (isGround(kind)) return groundTile(cx, cy, kind === 'dark');
  const set = BLOCK_SETS[kind];
  if (set) return base?.art ? plateTile(set.layer, set.family, set.plate, (x, y) => blocks.get(key(x, y)) === kind, cx, cy) : null;
  return colouredTile(kind, cx, cy);
}
const isGround = (kind) => kind === 'ground' || kind === 'dark';

function groundTile(cx, cy, dark = false) {
  if (!base?.art) return null;
  const solid = (x, y) => { const k = key(x, y); return isGround(blocks.get(k)) || (baseOn() && groundSet.has(k) && !removed.has(k)); };
  return plateTile('ground', dark ? 'dark_ground_tileset_' : 'ground1_tileset_', PLATE, solid, cx, cy);
}

function usedPiece(layer, family, plate, piece) {
  const used = base?.art?.palette?.[layer], name = (p) => family + plate[p];
  if (!used || used.includes(name(piece))) return { tile: name(piece), matrix: [1, 0, 0, 1] };
  const flipV = piece.replace(/^T/, 'b').replace(/^B/, 'T').replace(/^b/, 'B');
  if (flipV !== piece && used.includes(name(flipV))) return { tile: name(flipV), matrix: [1, 0, 0, -1] };
  const flipH = piece.replace(/L$/, 'r').replace(/R$/, 'L').replace(/r$/, 'R');
  if (flipH !== piece && used.includes(name(flipH))) return { tile: name(flipH), matrix: [-1, 0, 0, 1] };
  return { tile: name(piece), matrix: [1, 0, 0, 1] };
}

function plateTile(layer, family, plate, solid, cx, cy) {
  const n = solid(cx, cy + 1), e = solid(cx + 1, cy), s = solid(cx, cy - 1), w = solid(cx - 1, cy);
  const name = (piece) => family + plate[piece];
  const id = [1, 0, 0, 1];
  if (!n && !e && !s && !w && plate.single != null) return { layer, tile: family + plate.single, matrix: id };
  if (plate.v && (n || s) && !e && !w) return { layer, tile: family + plate.v[!n ? 0 : !s ? 2 : 1], matrix: id };
  if (plate.h && (e || w) && !n && !s) return { layer, tile: family + plate.h[!w ? 0 : !e ? 2 : 1], matrix: id };
  if ((n || s) && (e || w)) {
    const row = !n ? 'T' : !s ? 'B' : '', col = !w ? 'L' : !e ? 'R' : '';
    return { layer, ...usedPiece(layer, family, plate, row + col || 'C') };
  }
  const corner = (v, h, vPiece, hPiece, both) => (!v && !h ? both : !v ? vPiece : !h ? hPiece : 'C');
  const quarters = [
    corner(n, w, 'T', 'L', 'TL'), corner(n, e, 'T', 'R', 'TR'),
    corner(s, w, 'B', 'L', 'BL'), corner(s, e, 'B', 'R', 'BR'),
  ].map(name);
  return {
    layer, tile: family + 'q' + quarters.map((q) => q.slice(family.length)).join('_'), matrix: id, quarters,
    spriteFrom: { ref: name('C'), quarters },
  };
}

function drawGroundArt(cx, cy, art) {
  if (!art.quarters) return drawTileArt(cx, cy, art.tile, art.matrix);
  if (!artReady() || art.quarters.some((q) => base.art.tiles[q] === undefined)) return false;
  const r = cellRect(cx, cy);
  const hw = r.w / 2, hh = r.h / 2;
  art.quarters.forEach((q, i) => {
    const col = i % 2, row = i >> 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + col * hw - (col ? 0.25 : 0), r.y + row * hh - (row ? 0.25 : 0), hw + 0.5, hh + 0.5);
    ctx.clip();
    drawTileArt(cx, cy, q, art.matrix);
    ctx.restore();
  });
  return true;
}

function objectTransformJson(cfg) {
  const out = {}, X = (cfg.scale || 1) * (cfg.sx || 1), Y = (cfg.scale || 1) * (cfg.sy || 1);
  if (cfg.rot) out.rotation = cfg.rot;
  if (X !== 1 || Y !== 1 || cfg.fx || cfg.fy) out.scale = [X * (cfg.fx ? -1 : 1), Y * (cfg.fy ? -1 : 1)];
  if (cfg.alpha != null && cfg.alpha !== 1) out.alpha = cfg.alpha;
  return out;
}
function cloneConfig(o, item) {
  const cfg = o.cfg || {}, out = {};
  if (item.upgradeBox) {
    const u = upgradeConfig(o);
    return { ...objectTransformJson(cfg), ...(isLinked(o.course) ? { course: o.course } : {}), upgrade: { id: o.uid || 'box' + Math.round(o.x) + '_' + Math.round(o.y), kind: u.kind, label: u.label || (u.kind === 'omniDash' ? BOX_TEXT.omniDash.name : ''), currency: u.currency, prices: upgradePrices(u), scale: u.scale, add: u.add, power: u.power, max: u.max } };
  }
  if (item.worldScale) {
    const S = item.worldScale * (cfg.scale || 1);
    return { absolute: true, rotation: cfg.rot || 0, scale: [S * (cfg.sx || 1) * (cfg.fx ? -1 : 1), S * (cfg.sy || 1) * (cfg.fy ? -1 : 1)], tint: [1, 1, 1], ...(cfg.alpha != null && cfg.alpha !== 1 ? { alpha: cfg.alpha } : {}) };
  }
  if (item.stretch && cfg.width && cfg.width !== item.stretch.width) out.width = cfg.width;
  Object.assign(out, objectTransformJson(cfg));
  if (cfg.fields && Object.keys(cfg.fields).length) out.fields = cfg.fields;
  const zip = item.zip && cfg.zip ? zipConfig(o, item) : null;
  if (zip) out.zip = { end: zip.end, time: zip.time, backTime: zip.backTime, size: zip.size, ...(zip.auto ? { auto: true, pauseMove: zip.pauseMove, pauseReturn: zip.pauseReturn } : {}), ...(cfg.zip?.cells ? { rects: platformRects(zipShape(o, item)) } : {}) };
  if (isLinked(o.course)) out.course = o.course;
  if (isCourseCheckpoint(item)) out.courseCheckpoint = true;
  if (isSizable(item) && cfg.trig) out.trigger = { w: cfg.trig.w, h: cfg.trig.h, dx: cfg.trig.dx, dy: cfg.trig.dy };
  if (isTeleporter(item)) {
    const ref = (r) => { const t = teleportTarget(r); return t ? (t.uid ? { uid: t.uid } : { path: t.path, x: t.x, y: t.y }) : null; };
    const zone = baseOn() ? Number(String(zoneAt(o.x, o.y)).replace(/\D+/g, '')) || 1 : 1;
    out.teleport = { id: o.uid || 'tp' + Math.round(o.x) + '_' + Math.round(o.y), zone, up: ref(o.tp?.up), down: ref(o.tp?.down) };
  }
  return out;
}

function exportArea() {
  const xs = [], ys = [];
  const addKey = (k) => { const [x, y] = unkey(k); xs.push(x); ys.push(y); };
  blocks.forEach((_, k) => addKey(k));
  spikes.forEach((_, k) => addKey(k));
  vines.forEach((_, k) => addKey(k));
  tiles.forEach((t, k) => { const c = tileCenter(t.layer, k); const cc = cellOf(c.x, c.y); xs.push(cc.cx); ys.push(cc.cy); });
  for (const o of placed) { const cc = cellOf(o.x, o.y); xs.push(cc.cx); ys.push(cc.cy); }
  mossCells.forEach((_, k) => { const c = mossCenter(k), cc = cellOf(c.x, c.y); xs.push(cc.cx); ys.push(cc.cy); });
  if (baseOn()) removedVines.forEach(addKey);
  if (baseOn()) removed.forEach(addKey);
  for (const g of [draft.spawn, ...courses().flatMap((c) => [c.start, c.end])]) {
    if (!g) continue;
    const c = cellOf(g.x, g.y);
    xs.push(c.cx); ys.push(c.cy);
  }
  if (!xs.length) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function effectiveGates(area = exportArea()) {
  const first = completeCourses()[0] || courses()[0];
  let start = first?.start, end = first?.end;
  if (baseOn() && area && (!start || !end)) {
    const lo = cellWorld(area.x0, area.y0), hi = cellWorld(area.x1 + 1, area.y1 + 1);
    const inside = (g) => g && g.x >= lo.x && g.x < hi.x && g.y >= lo.y && g.y < hi.y;
    const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
    const dist = (g) => Math.hypot(g.x - mid.x, g.y - mid.y);
    const course = base.courses.filter((c) => inside(c.start) || inside(c.end)).sort((a, b) => dist(a.start || a.end) - dist(b.start || b.end))[0];
    if (course) {
      if (!start && inside(course.start)) start = course.start;
      if (!end && inside(course.end)) end = course.end;
    }
  }
  return { start, end };
}

// Stage edits carry their state; the other state's stage edits are built from where they're kept.
function buildOverlay() {
  const map = buildOverlayCore(), objs = map.groups[0].objects;
  const pos = (o) => (o.type === 'hide' ? { x: o.srcX, y: o.srcY } : { x: o.x, y: o.y });
  const tag = (o, st) => (o.type !== 'modify' && o.x !== undefined || o.type === 'hide') && inStage(pos(o).x, pos(o).y) ? { ...o, state: st } : null;
  for (let i = 0; i < objs.length; i++) { const t = tag(objs[i], draft.baseState); if (t) objs[i] = t; }
  const other = otherState(draft.baseState), kept = draft.stageEdits?.[other];
  if (kept) {
    const snap = snapshotState(), mark = tiles.journal.length;
    takeStageEdits();
    putStageEdits(kept);
    const theirs = buildOverlayCore().groups[0].objects;
    tiles.rollback(mark);
    applyState(JSON.parse(snap));
    saveDraft();
    for (const o of theirs) { const t = tag(o, other); if (t) objs.push(t); }
  }
  if (objs.some((o) => o.state)) map.stages = true;
  return withGroups(map);
}
// Group ids onto the exported objects: placed things carry theirs; tiles take their cell's.
function withGroups(map) {
  const objs = map.groups[0].objects, origin = baseOn() ? { x: 0, y: 0 } : cellWorld(0, 0);
  for (const o of objs) {
    if (o.group || !(o.type === 'tile' || o.type === 'ground' || o.type === 'coloredGround' || o.type === 'trueSpike')) continue;
    const k = o.cellX !== undefined ? key(o.cellX, o.cellY) : (() => { const c = cellOf(o.x + origin.x, o.y + origin.y); return key(c.cx, c.cy); })();
    const g = cellGroups.get(k);
    if (g && (blocks.has(k) || spikes.has(k))) o.group = g;
  }
  const used = new Set(objs.map((o) => o.group).filter(Boolean));
  const hidden = (draft.hiddenGroups || []).filter((g) => used.has(g));
  if (hidden.length) map.hiddenGroups = hidden;
  return map;
}
function buildOverlayCore() {
  const at = (k) => { const [cx, cy] = unkey(k); const w = cellWorld(cx, cy); return { x: w.x + CELL / 2, y: w.y + CELL / 2 }; };
  const objects = [];
  removed.forEach((k) => objects.push({ type: 'erase', ...at(k) }));
  removedVines.forEach((k) => {
    const h = baseHaz.get(k);
    if (h) objects.push({ type: 'erase', tilemap: base.defs[h.d].layer, ...at(k) });
  });
  for (const o of baseObjects) if (removedObjects.has(o.id)) objects.push({ type: 'hide', path: o.path, srcX: o.x, srcY: o.y });
  removedDeco.forEach((rk) => {
    const bar = rk.lastIndexOf('|'), layerName = rk.slice(0, bar), [gx, gy] = unkey(rk.slice(bar + 1)), g = layerGrid(layerName);
    objects.push({ type: 'erase', tilemap: layerName, x: g.ox + (gx + 0.5) * g.size, y: g.oy + (gy + 0.5) * g.size });
  });
  for (const p of sceneList?.items || []) if (p.id && removedScene.has(p.id)) objects.push({ type: 'hide', path: p.p, srcX: p.x0 ?? p.x, srcY: p.y0 ?? p.y, rendererOnly: true });
  // The level's own things, moved: the game moves the real object by the same amount.
  for (const o of baseObjects) { const d = movedObjects.get(o.id); if (d && !removedObjects.has(o.id)) objects.push({ type: 'move', path: o.path, srcX: o.x0 ?? o.x, srcY: o.y0 ?? o.y, dx: d[0], dy: d[1] }); }
  for (const p of sceneList?.items || []) { const d = p.id && movedScene.get(p.id); if (d && !removedScene.has(p.id)) objects.push({ type: 'move', path: p.p, srcX: p.x0 ?? p.x, srcY: p.y0 ?? p.y, dx: d[0], dy: d[1] }); }
  const levelAt = (k) => { if (k.startsWith('o:')) { const o = baseObjects.find((x) => x.id === k.slice(2)); return o && !removedObjects.has(o.id) ? { path: o.path, srcX: o.x0 ?? o.x, srcY: o.y0 ?? o.y } : null; } const p = sceneList?.items.find((x) => x.id === k); return p && !removedScene.has(p.id) ? { path: p.p, srcX: p.x0 ?? p.x, srcY: p.y0 ?? p.y } : null; };
  for (const [k, tf] of levelTf) { const at = levelAt(k); if (at) objects.push({ type: 'transform', ...at, rotation: tf.rot || 0, scale: [(tf.scale || 1) * (tf.sx || 1) * (tf.fx ? -1 : 1), (tf.scale || 1) * (tf.sy || 1) * (tf.fy ? -1 : 1)] }); }
  for (const [k, n] of levelOrder) { const at = levelAt(k); if (at) objects.push({ type: 'order', ...at, delta: n }); }
  for (const [k, g] of levelGroups) { const at = levelAt(k); if (at) objects.push({ type: 'group', ...at, group: g }); }
  for (const id of Object.keys(draft.baseEdits || {})) {
    const o = baseObjects.find((x) => x.id === id);
    if (!o || removedObjects.has(id)) continue;
    const u = baseUpgradeConfig(o);
    objects.push({ type: 'modify', path: o.path, srcX: o.x, srcY: o.y, upgrade: { id: 'level:' + id, label: u.label, currency: u.currency, prices: upgradePrices(u), scale: u.scale, add: u.add, power: u.power, max: u.max } });
  }
  blocks.forEach((kind, k) => {
    const [cx, cy] = unkey(k);
    const art = (isGround(kind) || BLOCK_SETS[kind]) && blockArt(kind, cx, cy);
    if (art) objects.push({ type: 'tile', tilemap: art.layer, tileName: art.tile, ...at(k), matrix: art.matrix, ...(art.spriteFrom ? { spriteFrom: art.spriteFrom } : {}) });
    else if (isGround(kind)) objects.push({ type: 'ground', ...at(k) });
    else {
      const t = colouredTile(kind, cx, cy);
      objects.push(t ? { type: 'tile', tilemap: t.layer, tileName: t.tile, ...at(k), matrix: t.matrix, ...(t.spriteFrom ? { spriteFrom: t.spriteFrom } : {}) } : { type: 'coloredGround', color: kind, ...at(k) });
    }
  });
  mossCells.forEach((_, k) => { const c = mossCenter(k); objects.push({ type: 'tile', tilemap: 'moss', tileName: 'Moss', x: c.x, y: c.y, matrix: [1, 0, 0, 1] }); });
  const ranks = stackRank();
  for (const f of freeSpikes) objects.push({ ...freeSpikeJson(f), order: ranks.get(f), ...(f.behind ? { behind: true, ...(f.depth === 2 ? { depth: 2 } : {}) } : {}), ...(f.group ? { group: f.group } : {}) });
  for (const sg of signs) objects.push({ ...signJson(sg), order: ranks.get(sg), ...(sg.behind ? { behind: true, ...(sg.depth === 2 ? { depth: 2 } : {}) } : {}), ...(sg.group ? { group: sg.group } : {}) });
  for (const tg of triggers) objects.push(triggerJson(tg));
  for (const cs of csprites) objects.push({ ...customSpriteJson(cs), order: ranks.get(cs), ...(cs.behind ? { behind: true, ...(cs.depth === 2 ? { depth: 2 } : {}) } : {}), ...(cs.group ? { group: cs.group } : {}) });
  spikes.forEach((sp, k) => {
    const [cx, cy] = unkey(k);
    if (sp.c === 'true') { objects.push(trueSpikeJson(sp, cx, cy, at(k))); return; }
    const t = spikeTile(sp.c, spikeTurn(sp, cx, cy));
    objects.push({ type: 'tile', tilemap: t.layer, tileName: t.tile, ...at(k), matrix: t.matrix });
  });
  vines.forEach((v, k) => {
    const t = vineTile(v.s, v.q);
    objects.push({ type: 'tile', tilemap: t.layer, tileName: t.tile, ...at(k), matrix: t.matrix });
  });
  tiles.forEach((t, k) => {
    const c = tileCenter(t.layer, k);
    objects.push({ type: 'tile', tilemap: tilemapName(t.layer), tileName: t.tile, x: c.x, y: c.y, matrix: tileMatrix(t), ...(cellGroups.get(k) ? { group: cellGroups.get(k) } : {}) });
  });
  for (const o of placed) {
    const item = catalogItem(o);
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, x: Math.round(o.x), y: Math.round(o.y), order: ranks.get(o), ...(o.behind ? { behind: true, ...(o.depth === 2 ? { depth: 2 } : {}) } : {}), ...(o.group ? { group: o.group } : {}), ...cloneConfig(o, item) });
  }

  const full = completeCourses(), first = full[0], hasGates = !!first;
  const spawn = draft.spawn || first?.start || viewSpawn();
  const keepSpawn = !draft.spawn;
  const r = (v) => Math.round(v);
  return {
    formatVersion: 1,
    name: draft.name.trim() || 'Untitled map',
    description: draft.description.trim(),
    images: [],
    customImages: [],
    overlay: true,
    baseState: draft.baseState,
    ...(!draft.ownProgress ? { player: draft.player } : {}),
    music: draft.music || 'level',
    background: backgroundJson(draft.background),
    editor: editorState(),
    groups: [{
      startX: r((hasGates ? first.start : spawn).x), startY: r((hasGates ? first.start : spawn).y),
      endX: r((hasGates ? first.end : spawn).x), endY: r((hasGates ? first.end : spawn).y),
      ...(keepSpawn ? { keepSpawn: true } : { spawnX: r(spawn.x), spawnY: r(spawn.y) }),
      ...(xspawns.length ? { spawns: xspawns.map((s) => ({ x: r(s.x), y: r(s.y) })) } : {}),
      gates: hasGates,
      reward: first?.reward || { currency: 'Cash', amount: 0 },
      courses: full.map((c) => courseJson(c)),
      objects,
    }],
  };
}

function buildMap() {
  if (baseOn()) return buildOverlay();
  return withGroups(buildCustomMap());
}
function buildCustomMap() {
  const area = exportArea();
  if (!area) throw new Error('Place something first, or import the base map.');
  const gates = effectiveGates(area);
  const hasGates = !!(gates.start && gates.end);
  const spawn = draft.spawn || gates.start || viewSpawn();

  const inArea = (cx, cy) => cx >= area.x0 && cx <= area.x1 && cy >= area.y0 && cy <= area.y1;
  const cells = new Map();
  if (baseOn()) importBaseCells(cells, inArea);
  blocks.forEach((kind, k) => cells.set(k, { t: kind }));
  spikes.forEach((sp, k) => { const [cx, cy] = unkey(k); if (sp.c !== 'true') cells.set(k, { t: 'tile', ...spikeTile(sp.c, spikeTurn(sp, cx, cy)) }); });
  const vineCells = [];
  if (baseOn()) baseHaz.forEach((h, k) => {
    const [cx, cy] = unkey(k);
    if (h.kind === 'vine' && inArea(cx, cy) && !removedVines.has(k) && !vines.has(k)) vineCells.push([k, { layer: base.defs[h.d].layer, tile: base.defs[h.d].tile, matrix: base.mats[h.m] }]);
  });
  vines.forEach((v, k) => vineCells.push([k, vineTile(v.s, v.q)]));

  const origin = cellWorld(0, 0);
  const objects = [];
  const sorted = [...cells].map(([k, v]) => [unkey(k), v]).sort((a, b) => a[0][1] - b[0][1] || a[0][0] - b[0][0]);
  for (const [[cx, cy], v] of sorted) {
    const cellX = cx, cellY = cy;
    const art = (isGround(v.t) || BLOCK_SETS[v.t]) && blockArt(v.t, cx, cy);
    if (art) objects.push({ type: 'tile', tilemap: art.layer, tileName: art.tile, cellX, cellY, matrix: art.matrix, ...(art.spriteFrom ? { spriteFrom: art.spriteFrom } : {}) });
    else if (isGround(v.t)) objects.push({ type: 'ground', cellX, cellY });
    else if (v.t === 'blue' || v.t === 'orange') {
      const t = colouredTile(v.t, cx, cy);
      objects.push(t ? { type: 'tile', tilemap: t.layer, tileName: t.tile, cellX, cellY, matrix: t.matrix, ...(t.spriteFrom ? { spriteFrom: t.spriteFrom } : {}) } : { type: 'coloredGround', color: v.t, cellX, cellY });
    }
    else objects.push({ type: 'tile', tilemap: v.layer, tileName: v.tile, cellX, cellY, matrix: v.matrix });
  }
  if (baseOn()) for (const o of baseObjects) {
    const c = cellOf(o.x, o.y);
    if (removedObjects.has(o.id) || !inArea(c.cx, c.cy)) continue;
    const door = o.box?.door;
    objects.push({ type: 'clone', path: o.path, srcX: o.x0 ?? o.x, srcY: o.y0 ?? o.y, x: Math.round(o.x - origin.x), y: Math.round(o.y - origin.y), ...(door ? { door: door.path } : {}) });
    // The door this box opens comes along, shut until the box is bought.
    if (door && !objects.some((x) => x.type === 'clone' && x.path === door.path)) objects.push({ type: 'clone', path: door.path, srcX: door.x, srcY: door.y, x: Math.round(door.x - origin.x), y: Math.round(door.y - origin.y) });
  }
  const rel = (p) => ({ x: Math.round(p.x - origin.x), y: Math.round(p.y - origin.y) });
  for (const [k, v] of vineCells) {
    const [cx, cy] = unkey(k);
    objects.push({ type: 'tile', tilemap: v.layer, tileName: v.tile, cellX: cx, cellY: cy, matrix: v.matrix });
  }
  tiles.forEach((t, k) => objects.push({ type: 'tile', tilemap: tilemapName(t.layer), tileName: t.tile, ...rel(tileCenter(t.layer, k)), matrix: tileMatrix(t), ...(cellGroups.get(k) ? { group: cellGroups.get(k) } : {}) }));
  mossCells.forEach((_, k) => objects.push({ type: 'tile', tilemap: 'moss', tileName: 'Moss', ...rel(mossCenter(k)), matrix: [1, 0, 0, 1] }));
  spikes.forEach((sp, k) => {
    if (sp.c !== 'true') return;
    const [cx, cy] = unkey(k), w = cellWorld(cx, cy);
    objects.push(trueSpikeJson(sp, cx, cy, { x: Math.round(w.x + CELL / 2 - origin.x), y: Math.round(w.y + CELL / 2 - origin.y) }));
  });
  const ranks = stackRank();
  for (const f of freeSpikes) objects.push({ ...freeSpikeJson(f, origin.x, origin.y), order: ranks.get(f), ...(f.behind ? { behind: true, ...(f.depth === 2 ? { depth: 2 } : {}) } : {}), ...(f.group ? { group: f.group } : {}) });
  for (const sg of signs) objects.push({ ...signJson(sg, origin.x, origin.y), order: ranks.get(sg), ...(sg.behind ? { behind: true, ...(sg.depth === 2 ? { depth: 2 } : {}) } : {}), ...(sg.group ? { group: sg.group } : {}) });
  for (const tg of triggers) objects.push(triggerJson(tg, origin.x, origin.y));
  for (const cs of csprites) objects.push({ ...customSpriteJson(cs, origin.x, origin.y), order: ranks.get(cs), ...(cs.behind ? { behind: true, ...(cs.depth === 2 ? { depth: 2 } : {}) } : {}), ...(cs.group ? { group: cs.group } : {}) });
  for (const o of placed) {
    const item = catalogItem(o);
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, x: Math.round(o.x - origin.x), y: Math.round(o.y - origin.y), order: ranks.get(o), ...(o.behind ? { behind: true, ...(o.depth === 2 ? { depth: 2 } : {}) } : {}), ...(o.group ? { group: o.group } : {}), ...cloneConfig(o, item) });
  }

  return {
    formatVersion: 1,
    name: draft.name.trim() || 'Untitled map',
    description: draft.description.trim(),
    images: [],
    customImages: [],
    levelOrigin: [origin.x, origin.y],
    ...(!draft.ownProgress ? { player: draft.player } : {}),
    music: draft.music || 'level',
    background: backgroundJson(draft.background),
    editor: editorState(),
    groups: [{
      startX: Math.round((hasGates ? gates.start : spawn).x - origin.x), startY: Math.round((hasGates ? gates.start : spawn).y - origin.y),
      endX: Math.round((hasGates ? gates.end : spawn).x - origin.x), endY: Math.round((hasGates ? gates.end : spawn).y - origin.y),
      spawnX: Math.round(spawn.x - origin.x), spawnY: Math.round(spawn.y - origin.y),
      ...(xspawns.length ? { spawns: xspawns.map((s) => ({ x: Math.round(s.x - origin.x), y: Math.round(s.y - origin.y) })) } : {}),
      gates: hasGates,
      reward: completeCourses()[0]?.reward || { currency: 'Cash', amount: 0 },
      courses: completeCourses().map((c) => courseJson(c, origin.x, origin.y)),
      objects,
    }],
  };
}

function importBaseCells(cells, inArea) {
  const takeBase = (set, value) => set.forEach((k) => {
    const [cx, cy] = unkey(k);
    if (inArea(cx, cy) && !removed.has(k)) cells.set(k, value);
  });
  takeBase(mossSet, { t: 'ground' });
  takeBase(groundSet, { t: 'ground' });
  takeBase(blueSet, { t: 'blue' });
  takeBase(orangeSet, { t: 'orange' });
  baseHaz.forEach((h, k) => {
    const [cx, cy] = unkey(k);
    if (h.kind !== 'vine' && inArea(cx, cy) && !removed.has(k)) cells.set(k, { t: 'tile', layer: base.defs[h.d].layer, tile: base.defs[h.d].tile, matrix: base.mats[h.m] });
  });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipSingle(name, text) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = enc.encode(text);
  const crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x0800, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, nameBytes.length, true);
  const localSize = 30 + nameBytes.length + data.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, localSize, true);
  return new Blob([local, nameBytes, data, central, nameBytes, end], { type: 'application/zip' });
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
}

function toScreen(wx, wy) {
  return { x: (wx - cam.x) * cam.scale + canvas.width / 2, y: canvas.height / 2 - (wy - cam.y) * cam.scale };
}
function toWorld(sx, sy) {
  return { x: (sx - canvas.width / 2) / cam.scale + cam.x, y: (canvas.height / 2 - sy) / cam.scale + cam.y };
}

const IN_WORKER = typeof document === 'undefined';
function makeCanvas() {
  return IN_WORKER ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
}

// ---- motion: eased camera, living selection outlines, place / delete effects ----
const CALM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const fx = [];
let lastFx = 0;
function addFx(kind, x, y, color = COLORS.start, size = CELL) {
  if (CALM || IN_WORKER) return;
  const now = performance.now();
  if (kind === 'ripple' && now - lastFx < 45) return;
  lastFx = now;
  fx.push({ kind, x, y, color, size, t0: now });
  if (fx.length > 40) fx.shift();
  requestDraw();
}
function drawFx() {
  if (!fx.length) return;
  const now = performance.now();
  ctx.save();
  ctx.setLineDash([]);
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i], life = f.kind === 'burst' ? 420 : 360, t = (now - f.t0) / life;
    if (t >= 1) { fx.splice(i, 1); continue; }
    const e = 1 - Math.pow(1 - t, 3), c = toScreen(f.x, f.y), base = Math.max(10, f.size * cam.scale * 0.6);
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = f.color;
    ctx.fillStyle = f.color;
    if (f.kind === 'ripple') {
      ctx.lineWidth = 2 * (1 - t) + 0.5;
      ctx.beginPath(); ctx.arc(c.x, c.y, base * (0.4 + e * 1.1), 0, Math.PI * 2); ctx.stroke();
    } else {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.3, r = base * (0.3 + e * 1.3);
        ctx.beginPath(); ctx.arc(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, Math.max(1, 3.2 * (1 - t)), 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  ctx.restore();
  requestDraw();
}
// The camera glides to where it's sent (wheel zoom, jumps) instead of snapping.
const camGoal = { active: false };
function glideCamera(goal) {
  if (CALM) { Object.assign(cam, { x: goal.x ?? cam.x, y: goal.y ?? cam.y, scale: goal.scale ?? cam.scale }); requestDraw(); return; }
  Object.assign(camGoal, goal, { active: true });
  requestDraw();
}
function stepCamera() {
  if (!camGoal.active) return;
  const k = 0.28;
  if (camGoal.scale != null) {
    const anchor = camGoal.anchor, before = anchor && toWorld(anchor.sx, anchor.sy);
    cam.scale += (camGoal.scale - cam.scale) * k;
    if (Math.abs(camGoal.scale - cam.scale) < camGoal.scale * 0.002) cam.scale = camGoal.scale;
    if (anchor) { const after = toWorld(anchor.sx, anchor.sy); cam.x += before.x - after.x; cam.y += before.y - after.y; }
  }
  if (camGoal.x != null) {
    cam.x += (camGoal.x - cam.x) * k; cam.y += (camGoal.y - cam.y) * k;
    if (Math.hypot(camGoal.x - cam.x, camGoal.y - cam.y) * cam.scale < 0.5) { cam.x = camGoal.x; cam.y = camGoal.y; camGoal.x = camGoal.y = null; }
  }
  if (camGoal.scale != null && cam.scale === camGoal.scale) camGoal.scale = null;
  if (camGoal.x == null && camGoal.scale == null) camGoal.active = false;
  requestDraw();
}
// Where a target sits, for effects.
function targetPoint(t) {
  if (WORLD_KINDS.has(t.kind)) { const it = listOfKind(t.kind)[t.index]; return it && { x: it.x, y: it.y }; }
  if (t.kind === 'base' || t.kind === 'scene') return levelThing(t);
  if (t.kind === 'cell') { const [cx, cy] = unkey(t.k), w = cellWorld(cx, cy); return { x: w.x + CELL / 2, y: w.y + CELL / 2 }; }
  if (t.kind === 'tile') { const tl = tiles.get(t.key); return tl && tileCenter(tl.layer, t.key); }
  if (t.kind === 'blocks' && t.cells.length) { const [cx, cy] = unkey(t.cells[0]), w = cellWorld(cx, cy); return { x: w.x + CELL / 2, y: w.y + CELL / 2 }; }
  return null;
}

function requestDraw() {
  if (IN_WORKER || frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; stepCamera(); draw(); drawFx(); });
}

function cellRect(cx, cy, len = 1) {
  const w = cellWorld(cx, cy);
  const a = toScreen(w.x, w.y + CELL);
  const s = CELL * cam.scale;
  return { x: a.x, y: a.y, w: s * len, h: s };
}

function drawSpike(cx, cy, q, color) {
  const r = cellRect(cx, cy);
  const m = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.rotate(-q * Math.PI / 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-r.w / 2, r.h / 2);
  ctx.lineTo(0, -r.h / 2);
  ctx.lineTo(r.w / 2, r.h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawKillBox(cx, cy, box = [-16, -16, 16, 16], m = [1, 0, 0, 1]) {
  const w = cellWorld(cx, cy);
  const ox = w.x + CELL / 2, oy = w.y + CELL / 2;
  const pts = [[box[0], box[1]], [box[2], box[3]]].map(([x, y]) => [ox + m[0] * x + m[1] * y, oy + m[2] * x + m[3] * y]);
  const a = toScreen(Math.min(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1]));
  const b = toScreen(Math.max(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]));
  ctx.fillStyle = COLORS.kill;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
}

const ART_CHUNK = 512;
let atlasImg = null;
let artIndex = null;
let spriteOrders = [];
// Drawing order where the level splits for things put behind it: below it are the
// backgrounds and wall art, from it up the ground, objects and spikes.
const LEVEL_CUT = 0;
// Further back still: under every level tile layer (walls, wall art), over the far backdrop.
const WALL_CUT = -20;
// Where a thing put behind the level sits: behind the ground (1) or behind the walls (2).
const cutOf = (it) => (it.depth === 2 ? WALL_CUT : LEVEL_CUT);
// null: the whole level; 'lo:hi': the part of it drawn at orders lo (inclusive) to hi.
let renderPart = null;
const partRange = (part = renderPart) => (part ? part.split(':').map(Number) : [-Infinity, Infinity]);
const artCache = new Map();

function artReady() {
  return !!(base?.art && atlasImg?.complete && atlasImg.naturalWidth);
}

function artRank(name) {
  if (/moss/i.test(name)) return 0;
  if (/Spikes/.test(name)) return 3;
  if (/Blocks/.test(name)) return 2;
  return 1;
}

function buildArtIndex() {
  artCache.clear();
  artIndex = null;
  if (!base?.art) return;
  if (!atlasImg) {
    atlasImg = new Image();
    atlasImg.onload = () => { artCache.clear(); invalidateBase(); if (!IN_WORKER) updateCategoryButtons(); };
    atlasImg.src = '/maps/' + base.art.atlas;
  }
  const layers = base.art.layers
    .filter((l) => l.state === 'always' || l.state === draft.baseState)
    .sort((a, b) => (a.order ?? artRank(a.name)) - (b.order ?? artRank(b.name)));
  const sc = base.scene;
  const pick = (byState) => [...(byState?.always || []), ...(byState?.[draft.baseState] || [])];
  spriteOrders = [...new Set([...pick(sc?.placements).map((p) => p.o), ...(sc?.groups || []).map((g) => g.o), LEVEL_CUT, WALL_CUT])].sort((a, b) => a - b);
  const bandOf = (order) => spriteOrders.filter((o) => o <= order).length;
  artIndex = new Map();
  for (const l of layers) {
    const band = bandOf(l.order ?? artRank(l.name));
    if (!artIndex.has(band)) artIndex.set(band, new Map());
    const index = artIndex.get(band);
    for (let i = 0; i < l.runs.length; i += 5) {
      const [, , sw, sh] = base.art.sprites[l.runs[i + 3]];
      const reach = Math.max(0, Math.max(sw, sh) / 2 - l.size / 2);
      const y0 = l.oy + l.runs[i] * l.size - reach, y1 = y0 + l.size + 2 * reach;
      const x0 = l.ox + l.runs[i + 1] * l.size - reach, x1 = l.ox + (l.runs[i + 1] + l.runs[i + 2]) * l.size + reach;
      const entry = [l, i];
      for (let cy = Math.floor(y0 / ART_CHUNK); cy <= Math.floor((y1 - 1) / ART_CHUNK); cy++) {
        for (let cx = Math.floor(x0 / ART_CHUNK); cx <= Math.floor((x1 - 1) / ART_CHUNK); cx++) {
          const k = cx + ',' + cy;
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(entry);
        }
      }
    }
  }
}

function blitSprite(g, sprite, m, px, cxPx, cyPx) {
  const [sx, sy, w, h] = base.art.sprites[sprite];
  g.setTransform(px * m[0], -px * m[2], -px * m[1], px * m[3],
    cxPx + px * (-m[0] * w / 2 + m[1] * h / 2), cyPx + px * (m[2] * w / 2 - m[3] * h / 2));
  g.drawImage(atlasImg, sx, sy, w, h, 0, 0, w, h);
}

function bakeChunk(lod, band, ccx, ccy) {
  const size = Math.max(1, Math.round(ART_CHUNK * lod));
  const c = makeCanvas();
  c.width = c.height = size;
  const g = c.getContext('2d');
  const x0 = ccx * ART_CHUNK, yTop = (ccy + 1) * ART_CHUNK;
  for (const [l, i] of artIndex.get(band).get(ccx + ',' + ccy) || []) {
    const r = l.runs;
    const [, , sw, sh] = base.art.sprites[r[i + 3]];
    const reach = Math.max(sw, sh) / 2 + l.size;
    g.globalAlpha = l.alpha ?? 1;
    for (let n = 0; n < r[i + 2]; n++) {
      const wx = l.ox + (r[i + 1] + n + 0.5) * l.size, wy = l.oy + (r[i] + 0.5) * l.size;
      if (wx < x0 - reach || wx > x0 + ART_CHUNK + reach || erasedArt(l, r[i + 1] + n, r[i])) continue;
      blitSprite(g, r[i + 3], base.mats[r[i + 4]], lod, (wx - x0) * lod, (yTop - wy) * lod);
    }
  }
  return c;
}

const ERASABLE = new Set(['new awesome nikki ground', 'OvergrowthDestroyedGround', 'moss', 'OvergrowthMoss', 'blueBlocks', 'orangeBlocks',
  'Spikes', 'backgroundSpikes1', 'backgroundSpikes2', 'blueSpikes', 'orangeSpikes']);
function erasedArt(l, col, row) {
  if (removedDeco.size && removedDeco.has(l.name + '|' + col + ',' + row)) return true;
  if (!removed.size || !ERASABLE.has(l.name)) return false;
  const n = Math.max(1, Math.round(l.size / CELL));
  const c = cellOf(l.ox + col * l.size + CELL / 2, l.oy + row * l.size + CELL / 2);
  for (let dx = 0; dx < n; dx++) for (let dy = 0; dy < n; dy++) if (removed.has(key(c.cx + dx, c.cy + dy))) return true;
  return false;
}

let bakeBudget = 0;
function artChunk(lod, band, ccx, ccy) {
  const k = lod + '|' + draft.baseState + '|' + band + '|' + ccx + '|' + ccy;
  let c = artCache.get(k);
  if (c) { artCache.delete(k); artCache.set(k, c); return c; }
  if (bakeBudget-- <= 0) return null;
  c = bakeChunk(lod, band, ccx, ccy);
  artCache.set(k, c);
  while (artCache.size > 400) artCache.delete(artCache.keys().next().value);
  return c;
}

function drawBandDirect(W, H, band) {
  const index = artIndex.get(band);
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const seen = new Set();
  ctx.save();
  for (let ccy = Math.floor(br.y / ART_CHUNK); ccy <= Math.floor(tl.y / ART_CHUNK); ccy++) {
    for (let ccx = Math.floor(tl.x / ART_CHUNK); ccx <= Math.floor(br.x / ART_CHUNK); ccx++) {
      for (const entry of index.get(ccx + ',' + ccy) || []) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        const [l, i] = entry, r = l.runs;
        const [, , sw, sh] = base.art.sprites[r[i + 3]];
        const reach = Math.max(sw, sh) / 2 + l.size / 2;
        const wy = l.oy + (r[i] + 0.5) * l.size;
        if (wy < br.y - reach || wy > tl.y + reach) continue;
        ctx.globalAlpha = l.alpha ?? 1;
        for (let n = 0; n < r[i + 2]; n++) {
          const wx = l.ox + (r[i + 1] + n + 0.5) * l.size;
          if (wx < tl.x - reach || wx > br.x + reach || erasedArt(l, r[i + 1] + n, r[i])) continue;
          const c = toScreen(wx, wy);
          blitSprite(ctx, r[i + 3], base.mats[r[i + 4]], cam.scale * (1 + 1 / Math.max(8, l.size * cam.scale)), c.x, c.y);
        }
      }
    }
  }
  ctx.restore();
}

function drawArtBand(W, H, band, lod) {
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const index = artIndex.get(band);
  let pending = false;
  for (let ccy = Math.floor(br.y / ART_CHUNK); ccy <= Math.floor(tl.y / ART_CHUNK); ccy++) {
    for (let ccx = Math.floor(tl.x / ART_CHUNK); ccx <= Math.floor(br.x / ART_CHUNK); ccx++) {
      if (!index.has(ccx + ',' + ccy)) continue;
      const c = artChunk(lod, band, ccx, ccy);
      if (!c) { pending = true; continue; }
      const a = toScreen(ccx * ART_CHUNK, (ccy + 1) * ART_CHUNK), b = toScreen((ccx + 1) * ART_CHUNK, ccy * ART_CHUNK);
      const x0 = Math.round(a.x), y0 = Math.round(a.y);
      ctx.drawImage(c, x0, y0, Math.round(b.x) - x0, Math.round(b.y) - y0);
    }
  }
  return pending;
}

function drawLayered(W, H, budget = 10) {
  const lod = Math.min(1, Math.pow(2, Math.ceil(Math.log2(cam.scale))));
  bakeBudget = budget;
  ctx.imageSmoothingEnabled = true;
  const items = sceneReady() && sceneList ? sceneList.items : [];
  let next = 0, pending = false;
  const [lo, hi] = partRange();
  const bandLo = lo === -Infinity ? -1 : spriteOrders.indexOf(lo), bandHi = hi === Infinity ? Infinity : spriteOrders.indexOf(hi);
  if (lo !== -Infinity) while (next < items.length && items[next].o < lo) next++;
  const drawItemsBelow = (limit) => {
    const from = next;
    while (next < items.length && items[next].o < limit) next++;
    if (next > from) drawSceneItems(W, H, items, from, next);
  };
  for (const band of [...artIndex.keys()].sort((a, b) => a - b)) {
    if (band > bandHi) break;
    if (band <= bandLo) continue;
    drawItemsBelow(band < spriteOrders.length ? spriteOrders[band] : Infinity);
    if (staticRender) drawBandDirect(W, H, band);
    else pending = drawArtBand(W, H, band, lod) || pending;
  }
  drawItemsBelow(hi);
  if (pending) requestDraw();
}

function drawTileArt(cx, cy, tileName, m) {
  const sprite = base?.art?.tiles?.[tileName];
  if (sprite === undefined || !artReady()) return false;
  const w = cellWorld(cx, cy);
  const c = toScreen(w.x + CELL / 2, w.y + CELL / 2);
  ctx.save();
  blitSprite(ctx, sprite, m, cam.scale, c.x, c.y);
  ctx.restore();
  return true;
}

const bgImages = {};
function bgImage(src) {
  if (!bgImages[src]) { const img = new Image(); img.onload = invalidateBase; img.src = '/maps/' + src; bgImages[src] = img; }
  return bgImages[src];
}

let zoneSets = null;
function zoneAt(x, y) {
  const sc = base.scene;
  if (!zoneSets) zoneSets = Object.fromEntries(Object.entries(sc.zones || {}).map(([k, v]) => [k, new Set(v)]));
  const cx = Math.floor(x / sc.zoneCell), cy = Math.floor(y / sc.zoneCell);
  for (let r = 0; r <= 8; r++) {
    const hits = {};
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      for (const [zone, set] of Object.entries(zoneSets)) if (set.has((cx + dx) + ',' + (cy + dy))) hits[zone] = (hits[zone] || 0) + 1;
    }
    const best = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
  }
  return 'zone 1';
}

// Far out, the backdrop would be hundreds of tiny copies: it fades away and the level sits on plain dark.
const backdropFade = () => Math.max(0, Math.min(1, (cam.scale - 0.1) / 0.1));
function drawBackground(W, H) {
  const fade = backdropFade();
  if (!fade) return;
  ctx.save();
  ctx.globalAlpha = fade;
  try { drawBackdrop(W, H); if (!draft.background?.image) drawWorldBackdrops(W, H); } finally { ctx.restore(); }
  drawCredits(W, H, 'end');
}
function drawBackdrop(W, H) {
  if (draft.background?.image) return drawCustomBackground(W, H, draft.background);
  const sc = base.scene;
  if (!sc?.backgrounds?.length) return;
  const zone = zoneAt(cam.x, cam.y);
  const tl = toWorld(0, 0), br = toWorld(W, H);
  ctx.save();
  for (const b of sc.backgrounds) {
    if (b.zone !== zone || (b.state !== 'always' && b.state !== draft.baseState)) continue;
    const img = bgImage(b.img);
    if (!img.complete || !img.naturalWidth) continue;
    const w = b.size[0] * Math.abs(b.sx), h = b.size[1] * Math.abs(b.sy);
    const ox = cam.x * b.fx - w / 2, oy = cam.y * b.fy - h / 2;
    ctx.globalAlpha = (b.a ?? 1) * backdropFade();
    for (let tx = Math.floor((tl.x - ox) / w); ox + tx * w < br.x; tx++) {
      for (let ty = Math.floor((br.y - oy) / h); oy + ty * h < tl.y; ty++) {
        const a = toScreen(ox + tx * w, oy + (ty + 1) * h), sw = w * cam.scale, sh = h * cam.scale;
        if (b.sx < 0) { ctx.setTransform(-1, 0, 0, 1, a.x + sw, a.y); ctx.drawImage(img, 0, 0, sw + 1, sh + 1); ctx.setTransform(1, 0, 0, 1, 0, 0); }
        else ctx.drawImage(img, a.x, a.y, sw + 1, sh + 1);
      }
    }
  }
  ctx.restore();
}

// A parallax layer (area 3's ParallaxController) sits between its parent and the camera.
const layerAt = (b) => (b.par ? { x: b.px + (cam.x - b.px) * b.par[0], y: b.py + (cam.y - b.py) * b.par[1] } : { x: b.x, y: b.y });
// Area 3's wallpaper: big tiled strips behind the level, each drifting with the view by its parallax.
// Area 3's layers follow the camera (parallax), so they're only there while the view is in area 3.
const inAreaOf = (path) => zoneAt(cam.x, cam.y) === String(path || '').split('/')[0].toLowerCase();
function drawWorldBackdrops(W, H) {
  const list = base?.scene?.worldBackdrops;
  if (!list?.length || !inAreaOf(list[0].path)) return;
  const k = cam.scale;
  for (const b of list) {
    const img = bgImage(b.img);
    if (!img.complete || !img.naturalWidth) continue;
    const [a, bb, c, d] = b.m, reach = Math.hypot(b.size[0], b.size[1]) * Math.max(Math.hypot(a, c), Math.hypot(bb, d)) / 2;
    const at = layerAt(b), tl = toWorld(0, 0), br = toWorld(W, H);
    if (at.x + reach < tl.x || at.x - reach > br.x || at.y + reach < br.y || at.y - reach > tl.y) continue;
    const o = toScreen(at.x, at.y);
    ctx.save();
    ctx.globalAlpha *= b.a ?? 1;
    ctx.setTransform(k * a, -k * c, -k * bb, k * d, o.x, o.y);
    const [w, h] = b.size, [tw, th] = b.tile;
    // The screen's corners in the strip's own units: only the tiles they cover are drawn.
    const inv = ctx.getTransform().inverse(), pts = [[0, 0], [W, 0], [0, H], [W, H]].map(([px, py]) => inv.transformPoint(new DOMPoint(px, py)));
    const u0 = Math.max(-w / 2, Math.min(...pts.map((q) => q.x))), u1 = Math.min(w / 2, Math.max(...pts.map((q) => q.x)));
    const v0 = Math.max(-h / 2, Math.min(...pts.map((q) => q.y))), v1 = Math.min(h / 2, Math.max(...pts.map((q) => q.y)));
    if (u1 <= u0 || v1 <= v0) { ctx.restore(); continue; }
    const su = -w / 2 + Math.floor((u0 + w / 2) / tw) * tw, sv = -h / 2 + Math.floor((v0 + h / 2) / th) * th;
    for (let u = su; u < u1; u += tw) for (let v = sv; v < v1; v += th) {
      const cw = Math.min(tw, w / 2 - u), ch = Math.min(th, h / 2 - v);
      ctx.drawImage(img, 0, 0, img.naturalWidth * (cw / tw), img.naturalHeight * (ch / th), u, v, cw + 0.5, ch + 0.5);
    }
    ctx.restore();
  }
}

// ---- the game's credits (the end credits, the fake credits), played while Simulate is on ----
let simStart = 0;
const CREDIT_ICON = 'credits';
function creditsTimeline(g, t) {
  // What the game's scripts do, second by second (their fades step every 0.02 s fixed update).
  const sc = g.scroll, scrollFor = sc ? (sc.to - sc.from) / sc.rate : 0;
  const out = { scrollAt: null, alpha: {} };
  if (g.kind === 'end') {
    out.scrollAt = sc ? sc.from + sc.rate * Math.min(t, scrollFor) : null;
    const logo = t < 0.75 ? 0 : t < 1 ? (t - 0.75) / 0.25 : t < 4.2 ? 1 : Math.max(0, 1 - (t - 4.2) / 1.25);
    out.alpha.logo = logo;
    out.length = Math.max(scrollFor, 5.5) + 3;
  } else {
    const n = g.texts.filter((x) => x.role === 'message').length, each = 1.11 + 1.2, fadeAt = n * each + 1.2, scrollFrom = fadeAt + 5;
    out.alpha.message = (i) => {
      if (t < i * each) return 0;
      const up = Math.min(1, (t - i * each) / 1.11);
      if (t < fadeAt) return up;
      if (t < scrollFrom) return Math.max(0, 1 - (t - fadeAt) / 5);
      return t > scrollFrom + scrollFor ? Math.min(1, (t - scrollFrom - scrollFor) / 1.11) : 0;
    };
    out.scrollAt = sc && t >= scrollFrom ? sc.from + sc.rate * Math.min(t - scrollFrom, scrollFor) : null;
    out.length = scrollFrom + scrollFor + 5;
  }
  return out;
}
function drawCreditText(tx, x, y, alpha) {
  if (alpha <= 0.01) return;
  let baked = textCache.get(tx);
  if (baked === undefined) { baked = bakeText(tx); textCache.set(tx, baked); }
  if (!baked) return;
  const c = toScreen(x, y);
  ctx.setTransform(1, 0, 0, 1, c.x, c.y);
  ctx.rotate(-(tx.r || 0));
  ctx.scale(cam.scale / baked.px, cam.scale / baked.px);
  ctx.globalAlpha = alpha * (tx.a ?? 1);
  ctx.drawImage(baked.canvas, baked.x0 * baked.px, -baked.top * baked.px);
}
function drawCredits(W, H, kind) {
  const list = base?.scene?.credits;
  if (!draft.simulate || !list?.length) return;
  const fonts = base.scene.fonts || [];
  if (!fonts.every((f, i) => !f || fontImage(i).complete)) return;
  const tl = toWorld(0, 0), br = toWorld(W, H), now = (performance.now() - simStart) / 1000;
  let shown = false;
  for (const g of list) {
    if (g.kind !== kind) continue;
    const tr = g.trigger;
    if (g.layer && !inAreaOf(tr?.path)) continue;
    // The fake credits play on their screen; the end credits across area 3's sky, riding their parallax layer.
    const lay = g.layer ? layerAt(g.layer) : null, ox = lay ? lay.x - g.layer.x : 0, oy = lay ? lay.y - g.layer.y : 0;
    const tlAll = creditsTimeline(g, 0), t = now % tlAll.length, s = creditsTimeline(g, t);
    ctx.save();
    if (kind === 'fake' && tr?.box) {
      const a = toScreen(tr.x + tr.box.dx - tr.box.w / 2, tr.y + tr.box.dy + tr.box.h / 2);
      ctx.beginPath(); ctx.rect(a.x, a.y, tr.box.w * cam.scale, tr.box.h * cam.scale); ctx.clip();
    }
    for (const tx of g.texts) {
      let x = tx.x + ox, y = tx.y + oy, alpha = 1;
      if (tx.role === 'scroll') {
        if (s.scrollAt == null) continue;
        const d = s.scrollAt - (g.scroll.y0 || 0);
        x += g.scroll.up[0] * d; y += g.scroll.up[1] * d;
      } else if (tx.role === 'logo') alpha = s.alpha.logo;
      else if (tx.role === 'message') alpha = s.alpha.message(tx.n);
      if (x < tl.x - 3000 || x > br.x + 3000 || y < br.y - 3000 || y > tl.y + 3000) continue;
      drawCreditText(tx, x, y, alpha);
      shown = true;
    }
    ctx.restore();
  }
  if (shown && !drawCredits.timer) drawCredits.timer = setTimeout(() => { drawCredits.timer = 0; requestDraw(); }, 33);
}

// The map's own background image, drifting with the view by its parallax and tiled.
function drawCustomBackground(W, H, bg) {
  const img = assetImage(bg.image);
  if (!img.complete || !img.naturalWidth) return;
  const s = bg.scale ?? 1, p = bg.parallax ?? 0.8, w = img.naturalWidth * s, h = img.naturalHeight * s;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const ox = cam.x - (((cam.x * (1 - p)) % w) + w) % w - w / 2, oy = cam.y - (((cam.y * (1 - p)) % h) + h) % h - h / 2;
  ctx.save();
  for (let tx = Math.floor((tl.x - ox) / w) - 1; ox + tx * w < br.x; tx++) {
    for (let ty = Math.floor((br.y - oy) / h) - 1; oy + ty * h < tl.y; ty++) {
      const a = toScreen(ox + tx * w, oy + (ty + 1) * h);
      ctx.drawImage(img, a.x, a.y, w * cam.scale + 1, h * cam.scale + 1);
    }
  }
  ctx.restore();
}

let sceneImg = null;
let sceneList = null;
let animTimer = 0;

function sceneReady() {
  return !!(base?.scene && sceneImg?.complete && sceneImg.naturalWidth);
}

function buildScene() {
  sceneList = null;
  const sc = base?.scene;
  if (!sc) return;
  if (!sceneImg) {
    sceneImg = new Image();
    sceneImg.onload = () => { invalidateBase(); if (!IN_WORKER) updateCategoryButtons(); };
    sceneImg.src = '/maps/' + sc.atlas;
  }
  const pick = (byState) => [...(byState.always || []), ...(byState[draft.baseState] || [])];
  const all = pick(sc.placements).map((p) => {
    const [, , sw, sh] = sc.sprites[p.s];
    const [w, h] = p.dm ? p.sz : [sw, sh];
    const reach = Math.hypot(w, h) * Math.max(Math.hypot(p.m[0], p.m[2]), Math.hypot(p.m[1], p.m[3]));
    return { ...p, reach, anim: !!(p.frames || p.sc), live: false, id: p.p ? p.p + '@' + p.x + ',' + p.y : null };
  }).sort((a, b) => a.o - b.o);
  const groups = (sc.groups || []).map((g) => ({ ...g, group: true, canvas: null }));
  sceneList = {
    items: [...all, ...groups].sort((a, b) => a.o - b.o),
    images: pick(sc.images || {}),
    texts: pick(sc.texts),
    paths: sc.paths.filter((p) => p.state === 'always' || p.state === draft.baseState),
  };
  textCache.clear();
  sizeCache.clear();
}

const tintCache = new Map();
function tintedSprite(sprite, c) {
  const k = sprite + '|' + c.join(',');
  let cv = tintCache.get(k);
  if (cv) return cv;
  const [sx, sy, w, h] = base.scene.sprites[sprite];
  cv = makeCanvas();
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.drawImage(sceneImg, sx, sy, w, h, 0, 0, w, h);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(sceneImg, sx, sy, w, h, 0, 0, w, h);
  tintCache.set(k, cv);
  return cv;
}

function blitScene(sprite, m, x, y, alpha, dm, sz, tint, scroll, now) {
  let [sx, sy, w, h, pvx, pvy, bl = 0, bb = 0, br = 0, bt = 0] = base.scene.sprites[sprite];
  let img = sceneImg;
  if (tint && sceneImg.complete) { img = tintedSprite(sprite, tint); sx = 0; sy = 0; }
  const W = dm ? sz[0] : w, H = dm ? sz[1] : h;
  const s = cam.scale, c = toScreen(x, y);
  ctx.setTransform(s * m[0], -s * m[2], -s * m[1], s * m[3],
    c.x + s * (-m[0] * pvx * W + m[1] * H * (1 - pvy)), c.y + s * (m[2] * pvx * W - m[3] * H * (1 - pvy)));
  ctx.globalAlpha = alpha ?? 1;
  if (!dm && scroll) {
    const u = ((now * scroll[0]) % 1 + 1) % 1, v = ((now * scroll[1]) % 1 + 1) % 1;
    const cx = Math.round(u * w), cy = Math.round((1 - v) * h) % h;
    for (const [ox, ow, dx] of [[cx, w - cx, 0], [0, cx, w - cx]]) {
      for (const [oy, oh, dy] of [[cy, h - cy, 0], [0, cy, h - cy]]) {
        if (ow > 0 && oh > 0) ctx.drawImage(img, sx + ox, sy + oy, ow, oh, dx, dy, ow + 0.3, oh + 0.3);
      }
    }
    return;
  }
  if (!dm) { ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h); return; }
  if (dm === 2) {
    const srcX = [sx, sx + bl, sx + w - br, sx + w], srcY = [sy, sy + bt, sy + h - bb, sy + h];
    const dstX = [0, bl, W - br, W], dstY = [0, bt, H - bb, H];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const sW = srcX[i + 1] - srcX[i], sH = srcY[j + 1] - srcY[j];
      const d0x = dstX[i], d1x = dstX[i + 1], d0y = dstY[j], d1y = dstY[j + 1];
      if (sW <= 0 || sH <= 0 || d1x <= d0x || d1y <= d0y) continue;
      for (let ty = d0y; ty < d1y; ty += sH) for (let tx = d0x; tx < d1x; tx += sW) {
        const cw = Math.min(sW, d1x - tx), ch = Math.min(sH, d1y - ty);
        ctx.drawImage(img, srcX[i], srcY[j], cw, ch, tx, ty, cw + 0.3, ch + 0.3);
      }
    }
    return;
  }
  const srcX = [sx, sx + bl, sx + w - br, sx + w], srcY = [sy, sy + bt, sy + h - bb, sy + h];
  const dstX = [0, bl, W - br, W], dstY = [0, bt, H - bb, H];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const sW = srcX[i + 1] - srcX[i], sH = srcY[j + 1] - srcY[j], dW = dstX[i + 1] - dstX[i], dH = dstY[j + 1] - dstY[j];
    if (sW > 0 && sH > 0 && dW > 0 && dH > 0) ctx.drawImage(img, srcX[i], srcY[j], sW, sH, dstX[i], dstY[j], dW + 0.3, dH + 0.3);
  }
}

function bakeGroup(g) {
  const sprites = base.scene.sprites;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y, s] of g.cells) {
    const [, , w, h, , , , , , , ppu = 1] = sprites[s];
    const r = Math.max(w, h) / ppu;
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r); minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  }
  const px = Math.min(2, 2048 / Math.max(maxX - minX, maxY - minY, 1));
  const cv = makeCanvas();
  cv.width = Math.ceil((maxX - minX) * px);
  cv.height = Math.ceil((maxY - minY) * px);
  const gx = cv.getContext('2d');
  for (const [x, y, s, t0, t1, t2, t3] of g.cells) {
    const [sx, sy, w, h, pvx, pvy, , , , , ppu = 1] = sprites[s];
    const k = px / ppu;
    gx.setTransform(k * t0, -k * t2, -k * t1, k * t3,
      (x - minX) * px + k * (-t0 * pvx * w + t1 * h * (1 - pvy)), (maxY - y) * px + k * (t2 * pvx * w - t3 * h * (1 - pvy)));
    gx.drawImage(sceneImg, sx, sy, w, h, 0, 0, w, h);
  }
  return { canvas: cv, minX, maxY, px, reach: Math.hypot(maxX - minX, maxY - minY) * Math.hypot(g.m[0], g.m[2], g.m[1], g.m[3]) };
}

function drawGroups(list, tl, br) {
  for (const g of list) {
    if (!g.canvas) g.canvas = bakeGroup(g);
    const b = g.canvas;
    if (g.x + b.reach < tl.x || g.x - b.reach > br.x || g.y + b.reach < br.y || g.y - b.reach > tl.y) continue;
    const s = cam.scale / b.px, c = toScreen(g.x, g.y), [a, bb, cc, d] = g.m;
    ctx.setTransform(s * a, -s * cc, -s * bb, s * d,
      c.x + cam.scale * (a * b.minX + bb * b.maxY), c.y - cam.scale * (cc * b.minX + d * b.maxY));
    ctx.drawImage(b.canvas, 0, 0);
  }
}

const spriteAlpha = new Map();
function spriteOpaqueAt(sprite, u, v) {
  let a = spriteAlpha.get(sprite);
  if (!a) {
    const [sx, sy, w, h] = base.scene.sprites[sprite];
    const cv = makeCanvas();
    cv.width = Math.max(1, w); cv.height = Math.max(1, h);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(sceneImg, sx, sy, w, h, 0, 0, w, h);
    a = { w, h, data: g.getImageData(0, 0, cv.width, cv.height).data };
    spriteAlpha.set(sprite, a);
  }
  const x = Math.floor(u), y = Math.floor(v);
  return x >= 0 && y >= 0 && x < a.w && y < a.h && a.data[(y * a.w + x) * 4 + 3] > 24;
}

function sceneSpriteAt(wx, wy) {
  if (!sceneReady() || !sceneList) return null;
  const items = sceneList.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const p = items[i];
    if (p.group || !p.id || p.a === 0 || removedScene.has(p.id)) continue;
    if (Math.abs(wx - p.x) > p.reach || Math.abs(wy - p.y) > p.reach) continue;
    const [, , w, h, pvx, pvy] = base.scene.sprites[p.s];
    const W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h;
    const [a, b, c, d] = p.m, det = a * d - b * c;
    if (!det) continue;
    const size = Math.max(W * Math.hypot(a, c), H * Math.hypot(b, d));
    if (size > 1200) continue;
    const dx = wx - p.x, dy = wy - p.y;
    const lx = (d * dx - b * dy) / det, ly = (-c * dx + a * dy) / det;
    const u = lx + pvx * W, v = (1 - pvy) * H - ly;
    if (u < 0 || v < 0 || u >= W || v >= H) continue;
    if (spriteOpaqueAt(p.s, (u * w) / W, (v * h) / H)) return p;
  }
  return null;
}

function drawSceneItems(W, H, items, from, to) {
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const now = performance.now() / 1000;
  let animated = false;
  ctx.save();
  for (let i = from; i < to; i++) {
    const p = items[i];
    if (p.group) { drawGroups([p], tl, br); continue; }
    if (p.id && removedScene.has(p.id)) continue;
    if (removedPaths.length && p.p && removedPaths.some((rp) => p.p === rp || p.p.startsWith(rp + '/'))) continue;
    if (p.x + p.reach < tl.x || p.x - p.reach > br.x || p.y + p.reach < br.y || p.y - p.reach > tl.y) continue;
    if (p.live && (skipLive || (staticRender && cam.scale >= LIVE_MIN_SCALE))) continue;
    let sprite = p.s;
    if (p.frames && !staticRender) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; animated = true; }
    if (p.sc && !staticRender) animated = true;
    blitScene(sprite, p.m, p.x, p.y, p.a, p.dm, p.sz, p.c, p.sc && !staticRender ? p.sc : null, now);
  }
  ctx.restore();
  if (animated && !animTimer) animTimer = setTimeout(() => { animTimer = 0; requestDraw(); }, 100);
}

const LIVE_MIN_SCALE = 0.51;
// Set while the level above live sprites is drawn again over them: the live ones themselves are skipped.
let skipLive = false;

function drawLiveItems(W, H) {
  if (!sceneReady() || !sceneList || cam.scale < LIVE_MIN_SCALE) return;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const visible = sceneList.items.filter((p) => p.live && !(p.id && removedScene.has(p.id)) && !(p.x + p.reach < tl.x || p.x - p.reach > br.x || p.y + p.reach < br.y || p.y - p.reach > tl.y));
  if (!visible.length) return;
  // Each order's live sprites, then the level's layers above them drawn again over just
  // that patch - so the ground and its moss cover them exactly as in the game.
  for (let i = 0; i < visible.length;) {
    const o = visible[i].o;
    let j = i;
    while (j < visible.length && visible[j].o === o) j++;
    drawSceneItems(W, H, visible, i, j);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let n = i; n < j; n++) { const p = visible[n]; x0 = Math.min(x0, p.x - p.reach); x1 = Math.max(x1, p.x + p.reach); y0 = Math.min(y0, p.y - p.reach); y1 = Math.max(y1, p.y + p.reach); }
    const a = toScreen(Math.max(x0, tl.x), Math.min(y1, tl.y)), b = toScreen(Math.min(x1, br.x), Math.max(y0, br.y));
    if (b.x > a.x && b.y > a.y && spriteOrders.includes(o)) {
      const savedPart = renderPart;
      ctx.save();
      ctx.beginPath(); ctx.rect(Math.floor(a.x), Math.floor(a.y), Math.ceil(b.x - a.x) + 1, Math.ceil(b.y - a.y) + 1); ctx.clip();
      renderPart = o + ':Infinity'; skipLive = true;
      try { drawLayered(W, H, 4); } finally { renderPart = savedPart; skipLive = false; ctx.restore(); }
    }
    i = j;
  }
}

function drawSceneOverlays(W, H) {
  if (!sceneReady() || !sceneList) return;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  drawSceneImages(tl, br);
  drawSceneText(tl, br);
  drawZipPaths();
}

function drawSceneImages(tl, br) {
  ctx.save();
  for (const im of sceneList.images) {
    const reach = Math.hypot(im.w, im.h);
    if (im.x + reach < tl.x || im.x - reach > br.x || im.y + reach < br.y || im.y - reach > tl.y) continue;
    const [sx, sy, sw, sh, , , bl = 0, bb = 0, brd = 0, bt = 0] = base.scene.sprites[im.s];
    const c = toScreen(im.x, im.y);
    const k = cam.scale;
    ctx.setTransform(1, 0, 0, 1, c.x, c.y);
    ctx.rotate(-im.r);
    ctx.globalAlpha = im.a ?? 1;
    const L = -im.w / 2 * k, T = -im.h / 2 * k, W = im.w * k, H = im.h * k;
    if (!im.b) { ctx.drawImage(sceneImg, sx, sy, sw, sh, L, T, W, H); continue; }
    const [wl, wb, wr, wt] = im.b.map((v) => v * k);
    const srcX = [sx, sx + bl, sx + sw - brd, sx + sw], srcY = [sy, sy + bt, sy + sh - bb, sy + sh];
    const dstX = [L, L + wl, L + W - wr, L + W], dstY = [T, T + wt, T + H - wb, T + H];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const sW = srcX[i + 1] - srcX[i], sH = srcY[j + 1] - srcY[j], dW = dstX[i + 1] - dstX[i], dH = dstY[j + 1] - dstY[j];
      if (sW > 0 && sH > 0 && dW > 0 && dH > 0) ctx.drawImage(sceneImg, srcX[i], srcY[j], sW, sH, dstX[i], dstY[j], dW + 0.5, dH + 0.5);
    }
  }
  ctx.restore();
}

const fontImages = [];
function fontImage(i) {
  if (!fontImages[i]) {
    if (IN_WORKER) return { complete: false };
    const img = new Image();
    img.onload = () => { textCache.clear(); invalidateBase(); };
    img.src = '/maps/' + base.scene.fonts[i].atlas;
    fontImages[i] = img;
  }
  return fontImages[i];
}

function glyphFor(fontIdx, code) {
  const fonts = base.scene.fonts;
  const own = fonts[fontIdx];
  if (own && own.chars[code]) return [fontIdx, own.chars[code]];
  for (let i = 0; i < fonts.length; i++) if (fonts[i] && fonts[i].chars[code]) return [i, fonts[i].chars[code]];
  return null;
}

function layoutText(t, fontSize) {
  const font = base.scene.fonts[t.f] || base.scene.fonts.find(Boolean);
  const unit = fontSize * t.k / font.point * (font.scale || 1);
  const lineStep = font.line * unit + t.ls * 0.01 * fontSize * t.k;
  const charSpace = t.cs * 0.01 * fontSize * t.k;
  const innerW = t.w - (t.m[0] + t.m[2]) * t.k, innerH = t.h - (t.m[1] + t.m[3]) * t.k;
  const advanceOf = (ch) => { const g = glyphFor(t.f, ch.codePointAt(0)); return g ? g[1][6] * (fontSize * t.k / base.scene.fonts[g[0]].point) + charSpace : fontSize * t.k * 0.3; };
  const lines = [];
  for (const para of t.t.split('\n')) {
    let line = '', width = 0;
    for (const word of para.split(/(?<= )/)) {
      const w = [...word].reduce((a, ch) => a + advanceOf(ch), 0);
      if (t.wrap && line && width + w > innerW + 0.01) { lines.push([line, width]); line = word.trimStart(); width = [...line].reduce((a, ch) => a + advanceOf(ch), 0); }
      else { line += word; width += w; }
    }
    lines.push([line, width]);
  }
  const ascent = font.ascent * unit, descent = Math.abs(font.descent || 0) * unit;
  const blockH = ascent + descent + (lines.length - 1) * lineStep;
  const widest = Math.max(...lines.map((l) => l[1]));
  return { lines, unit, lineStep, ascent, blockH, widest, innerW, innerH };
}

function fits(t, fontSize) {
  const l = layoutText(t, fontSize);
  return l.widest <= l.innerW + 0.01 && l.blockH <= l.innerH + 0.01;
}

function textSize(t) {
  if (!t.auto) return t.size;
  let lo = t.auto[0], hi = Math.min(t.auto[1], 600);
  if (fits(t, hi)) return hi;
  for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fits(t, mid)) lo = mid; else hi = mid; }
  return lo;
}

const textCache = new Map();
const sizeCache = new Map();

function bakeText(t) {
  const size = sizeCache.get(t) ?? textSize(t);
  const L = layoutText(t, size);
  const left = -t.w / 2 + t.m[0] * t.k, right = t.w / 2 - t.m[2] * t.k;
  const top = t.h / 2 - t.m[1] * t.k, bottom = -t.h / 2 + t.m[3] * t.k;
  const va = t.va & 256 ? 'top' : t.va & 1024 ? 'bottom' : 'middle';
  const blockTop = va === 'top' ? top : va === 'bottom' ? bottom + L.blockH : (top + bottom) / 2 + L.blockH / 2;
  const quads = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  L.lines.forEach(([line, width], i) => {
    const align = t.ha & 4 ? 'right' : t.ha & (2 | 32) ? 'center' : 'left';
    let pen = align === 'right' ? right - width : align === 'center' ? (left + right) / 2 - width / 2 : left;
    const baseline = blockTop - L.ascent - i * L.lineStep;
    for (const ch of line) {
      const g = glyphFor(t.f, ch.codePointAt(0));
      if (!g) { pen += size * t.k * 0.3; continue; }
      const [fi, [ax, ay, aw, ah, bx, by, adv, mw, mh]] = g;
      const u = size * t.k / base.scene.fonts[fi].point;
      const q = { fi, ax, ay, aw, ah, x: pen + bx * u, y: baseline + by * u, w: mw * u, h: mh * u };
      if (q.w > 0 && q.h > 0) {
        quads.push(q);
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x + q.w); minY = Math.min(minY, q.y - q.h); maxY = Math.max(maxY, q.y);
      }
      pen += adv * u + t.cs * 0.01 * size * t.k;
    }
  });
  if (!quads.length) return null;
  const px = Math.min(3, 1024 / Math.max(maxX - minX, maxY - minY, 1));
  const cv = makeCanvas();
  cv.width = Math.max(1, Math.ceil((maxX - minX) * px));
  cv.height = Math.max(1, Math.ceil((maxY - minY) * px));
  const g = cv.getContext('2d');
  for (const q of quads) g.drawImage(fontImage(q.fi), q.ax, q.ay, q.aw, q.ah, (q.x - minX) * px, (maxY - q.y) * px, q.w * px, q.h * px);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = t.c;
  g.fillRect(0, 0, cv.width, cv.height);
  return { canvas: cv, x0: minX, top: maxY, px };
}

// Level texts that only appear later in the game (the statue's line once its power is awakened).
const LATER_TEXTS = new Set(['I have boosted all previous courses', 'Quaeso, ad locum generatoris redi;', 'ulteriores decessiones ruina violenta punientur.']);

function drawSceneText(tl, br, liveOnly = false) {
  const fonts = base.scene.fonts || [];
  if (!fonts.length || !fonts.every((f, i) => !f || fontImage(i).complete)) return;
  ctx.save();
  for (const t of sceneList.texts) {
    if (LATER_TEXTS.has(t.t)) continue;
    if (liveOnly ? !t.mover : t.mover && staticRender && cam.scale >= LIVE_MIN_SCALE) continue;
    const reach = Math.max(t.w, t.h) + t.size * t.k * 4;
    if (t.x + reach < tl.x || t.x - reach > br.x || t.y + reach < br.y || t.y - reach > tl.y) continue;
    if (!sizeCache.has(t)) sizeCache.set(t, textSize(t));
    if (sizeCache.get(t) * t.k * cam.scale < 2.5) continue;
    if (removedObjects.size && baseObjects.some((o) => removedObjects.has(o.id) && Math.abs((t.x0 ?? t.x) - (o.x0 ?? o.x)) <= o.w / 2 && Math.abs((t.y0 ?? t.y) - (o.y0 ?? o.y)) <= o.h / 2)) continue;
    const edited = Object.keys(draft.baseEdits || {}).length ? editedBoxText(t) : null;
    if (edited) { ctx.save(); drawTextAt(edited, t.x, t.y); ctx.restore(); continue; }
    let baked = textCache.get(t);
    if (baked === undefined) { baked = bakeText(t); textCache.set(t, baked); }
    if (!baked) continue;
    const c = toScreen(t.x, t.y);
    ctx.setTransform(1, 0, 0, 1, c.x, c.y);
    ctx.rotate(-t.r);
    ctx.scale(cam.scale / baked.px, cam.scale / baked.px);
    ctx.globalAlpha = t.a;
    ctx.drawImage(baked.canvas, baked.x0 * baked.px, -baked.top * baked.px);
  }
  ctx.restore();
}

function drawZipPaths() {
  ctx.save();
  for (const p of sceneList.paths) {
    ctx.strokeStyle = p.zip ? 'rgba(94, 200, 240, 0.8)' : 'rgba(232, 216, 90, 0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    p.pts.forEach(([x, y], i) => { const c = toScreen(x, y); i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y); });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    for (const [x, y] of p.pts) { const c = toScreen(x, y); ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

const vineImages = {};
function vineImage(name) {
  if (!vineImages[name]) {
    if (IN_WORKER) return { complete: false };
    const img = new Image();
    img.onload = invalidateBase;
    img.src = '/maps/vines/' + encodeURIComponent(name) + '.png';
    vineImages[name] = img;
  }
  return vineImages[name];
}

function drawVine(cx, cy, sprite, m) {
  const img = vineImage(sprite);
  if (!img.complete || !img.naturalWidth) return;
  const w = cellWorld(cx, cy);
  const c = toScreen(w.x + CELL / 2, w.y + CELL / 2);
  const s = cam.scale, iw = img.naturalWidth, ih = img.naturalHeight;
  ctx.save();
  ctx.setTransform(s * m[0], -s * m[2], -s * m[1], s * m[3],
    c.x + s * (-m[0] * iw / 2 + m[1] * ih / 2), c.y + s * (m[2] * iw / 2 - m[3] * ih / 2));
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawGate(g, box, color, label) {
  const c = toScreen(g.x + box.dx, g.y + box.dy);
  const w = Math.max(4, box.w * cam.scale), h = Math.max(3, box.h * cam.scale);
  ctx.fillStyle = color;
  ctx.save();
  ctx.globalAlpha *= 0.18;
  ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h);
  ctx.restore();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
  if (cam.scale < 0.05) return;
  const icon = /^LONG FALL/.test(label) ? 'fall' : /^START/.test(label) ? 'flag' : /^END/.test(label) ? 'finish' : /^SPAWN \d/.test(label) ? 'pin' : /^SPAWN/.test(label) ? 'spawn' : /TIMER/.test(label) ? 'timer' : /RESPAWN/.test(label) ? 'respawn' : 'checkpoint';
  drawBadge(icon, c.x, c.y - h / 2 - 14, color, cam.scale >= 0.2 ? label : '');
}

const TILE_PX = 128;
const TILE_BUDGET_MS = 6;
const MAX_TILES = 3000;
const tileCache = new Map();
let baseVersion = 0;
let staticRender = false;
let lastVineSig = '';

function invalidateBase() { baseVersion++; stateVersion++; requestDraw(); }

// Only the cached level tiles over what changed are drawn again, not the whole level.
let stateVersion = 0, lastLevelEdits = null;
const dirtyGen = new Map();
function invalidateRegion(rects, belowZ = Infinity) {
  if (!rects.length) return;
  stateVersion++;
  const hits = (k) => {
    const parts = k.split('|'), z = +parts[2], tx = +parts[3], ty = +parts[4], T = TILE_PX / Math.pow(2, z);
    if (z >= belowZ) return false;
    const x0 = tx * T, y0 = ty * T, x1 = x0 + T, y1 = y0 + T;
    return rects.some((r) => r[0] < x1 && r[2] > x0 && r[1] < y1 && r[3] > y0);
  };
  for (const [k, c] of [...tileCache]) if (hits(k)) { tileCache.delete(k); c?.close?.(); dirtyGen.set(k, stateVersion); }
  for (const k of pool.inflight?.keys?.() || []) if (hits(k)) dirtyGen.set(k, stateVersion);
  for (const k of [...tileJobs.keys()]) if (hits(k)) tileJobs.delete(k);
  requestDraw();
}
const levelEditSets = () => ({ removed: new Set(removed), removedVines: new Set(removedVines), removedScene: new Set(removedScene), removedObjects: new Set(removedObjects), removedDeco: new Set(removedDeco), movedScene: new Map([...movedScene].map(([k, d]) => [k, d.join(',')])), movedObjects: new Map([...movedObjects].map(([k, d]) => [k, d.join(',')])), levelTf: new Map([...levelTf].map(([k, v]) => [k, JSON.stringify(v)])), levelOrder: new Map([...levelOrder].map(([k, v]) => [k, String(v)])), baseEdits: new Map(Object.entries(draft.baseEdits || {}).map(([k, v]) => [k, JSON.stringify(v)])) });
function changedKeys(a, b) {
  const out = [];
  if (a instanceof Map) { for (const [k, v] of a) if (b.get(k) !== v) out.push(k); for (const k of b.keys()) if (!a.has(k)) out.push(k); }
  else { for (const k of a) if (!b.has(k)) out.push(k); for (const k of b) if (!a.has(k)) out.push(k); }
  return out;
}
function sceneRects(p, out) {
  if (!p) return;
  for (const [x, y] of [[p.x, p.y], [p.x0 ?? p.x, p.y0 ?? p.y], ...(p.drawnAt ? [p.drawnAt] : [])]) out.push([x - p.reach, y - p.reach, x + p.reach, y + p.reach]);
  p.drawnAt = [p.x, p.y];
}
function objectRects(o, out) {
  if (!o) return;
  const r = Math.max(o.w || 64, o.h || 64);
  for (const [x, y] of [[o.x, o.y], [o.x0 ?? o.x, o.y0 ?? o.y]]) out.push([x - r, y - r, x + r, y + r]);
  for (const p of sceneList?.items || []) if (p.p && (p.p === o.path || p.p.startsWith(o.path + '/'))) sceneRects(p, out);
}
function redrawChangedLevel() {
  const now = levelEditSets(), was = lastLevelEdits;
  lastLevelEdits = now;
  if (!was || !baseOn()) return;
  const rects = [], byId = new Map((sceneList?.items || []).filter((p) => p.id).map((p) => [p.id, p]));
  const cellRect = (k, m) => { const [cx, cy] = unkey(k), w = cellWorld(cx, cy); rects.push([w.x - m * CELL, w.y - m * CELL, w.x + (m + 1) * CELL, w.y + (m + 1) * CELL]); };
  changedKeys(was.removed, now.removed).forEach((k) => cellRect(k, 2));
  changedKeys(was.removedVines, now.removedVines).forEach((k) => cellRect(k, 5));
  changedKeys(was.removedDeco, now.removedDeco).forEach((k) => { const layer = k.slice(0, k.lastIndexOf('|')), c = tileCenter(layer, k), g = layerGrid(layer).size * 2; rects.push([c.x - g, c.y - g, c.x + g, c.y + g]); });
  // A moved thing that only moved further is drawn live: only far zooms, where it's part of the cached level, redraw.
  const slid = [], onlySlid = (a, b) => (k) => a.has(k) && b.has(k);
  const ms = changedKeys(was.movedScene, now.movedScene), mo = changedKeys(was.movedObjects, now.movedObjects);
  ms.filter(onlySlid(was.movedScene, now.movedScene)).forEach((id) => sceneRects(byId.get(id), slid));
  mo.filter(onlySlid(was.movedObjects, now.movedObjects)).forEach((id) => objectRects(baseObjects.find((o) => o.id === id), slid));
  [...changedKeys(was.removedScene, now.removedScene), ...ms.filter((k) => !onlySlid(was.movedScene, now.movedScene)(k))].forEach((id) => sceneRects(byId.get(id), rects));
  [...changedKeys(was.removedObjects, now.removedObjects), ...mo.filter((k) => !onlySlid(was.movedObjects, now.movedObjects)(k)), ...changedKeys(was.baseEdits, now.baseEdits)].forEach((id) => objectRects(baseObjects.find((o) => o.id === id), rects));
  [...changedKeys(was.levelTf, now.levelTf), ...changedKeys(was.levelOrder, now.levelOrder)].forEach((k) => (k.startsWith('o:') ? objectRects(baseObjects.find((o) => o.id === k.slice(2)), rects) : sceneRects(byId.get(k), rects)));
  if (rects.length > 600) { baseVersion++; stateVersion++; requestDraw(); return; }
  invalidateRegion(rects);
  invalidateRegion(slid, lodFor(LIVE_MIN_SCALE) + 1);
}
// Moved level things sit at their new place and are drawn live, over the cached level.
const tfMatrix = (tf) => mul2(rot2(((tf.rot || 0) * Math.PI) / 180), [(tf.scale || 1) * (tf.sx || 1) * (tf.fx ? -1 : 1), 0, 0, (tf.scale || 1) * (tf.sy || 1) * (tf.fy ? -1 : 1)]);
let lastOrderSig = '';
function applyBaseMoves() {
  if (!sceneList) return;
  const objMoves = baseObjects.filter((o) => movedObjects.has(o.id)).map((o) => [o.path, movedObjects.get(o.id)]);
  const objTf = baseObjects.filter((o) => levelTf.has('o:' + o.id)).map((o) => [o, tfMatrix(levelTf.get('o:' + o.id))]);
  const objOrder = baseObjects.filter((o) => levelOrder.has('o:' + o.id)).map((o) => [o.path, levelOrder.get('o:' + o.id)]);
  for (const o of baseObjects) {
    o.x0 ??= o.x; o.y0 ??= o.y;
    const d = movedObjects.get(o.id) || [0, 0];
    o.x = o.x0 + d[0]; o.y = o.y0 + d[1];
  }
  for (const p of sceneList.items) {
    if (!p.id) continue;
    p.x0 ??= p.x; p.y0 ??= p.y; p.m0 ??= p.m; p.o0 ??= p.o; p.reach0 ??= p.reach;
    const under = (path) => p.p === path || p.p.startsWith(path + '/');
    let dx = 0, dy = 0, bx = p.x0, by = p.y0, m = p.m0, grow = 1, order = p.o0, touched = false;
    const own = movedScene.get(p.id);
    if (own) { dx += own[0]; dy += own[1]; touched = true; }
    for (const [path, d] of objMoves) if (under(path)) { dx += d[0]; dy += d[1]; touched = true; }
    const ownTf = levelTf.get(p.id);
    if (ownTf) { const M = tfMatrix(ownTf); m = mul2(M, m); grow *= Math.max(Math.hypot(M[0], M[2]), Math.hypot(M[1], M[3])); touched = true; }
    for (const [o, M] of objTf) if (under(o.path)) {
      const rx = bx - o.x0, ry = by - o.y0;
      bx = o.x0 + M[0] * rx + M[1] * ry; by = o.y0 + M[2] * rx + M[3] * ry;
      m = mul2(M, m); grow *= Math.max(Math.hypot(M[0], M[2]), Math.hypot(M[1], M[3])); touched = true;
    }
    if (levelOrder.has(p.id)) { order += levelOrder.get(p.id); touched = true; }
    for (const [path, d] of objOrder) if (under(path)) { order += d; touched = true; }
    p.x = bx + dx; p.y = by + dy; p.m = m; p.o = order; p.reach = p.reach0 * grow;
    // Animated level sprites move only while Simulate is on; otherwise they're part of the cached level.
    p.live = (p.anim && !!draft.simulate) || touched;
  }
  const orderSig = [...levelOrder].join(';');
  if (orderSig !== lastOrderSig) { lastOrderSig = orderSig; sceneList.items.sort((a, b) => a.o - b.o); }
  // A moved box's texts (price, label) have no path: they go with the box they sit in.
  const movers = baseObjects.filter((o) => movedObjects.has(o.id) || levelTf.has('o:' + o.id));
  for (const t of sceneList.texts || []) {
    t.x0 ??= t.x; t.y0 ??= t.y; t.r0 ??= t.r || 0;
    const o = movers.find((b) => Math.abs(t.x0 - b.x0) <= b.w / 2 && Math.abs(t.y0 - b.y0) <= b.h / 2);
    const d = (o && movedObjects.get(o.id)) || [0, 0], tf = o && levelTf.get('o:' + o.id);
    let x = t.x0, y = t.y0, r = t.r0;
    if (tf) {
      const M = tfMatrix(tf), rx = x - o.x0, ry = y - o.y0;
      x = o.x0 + M[0] * rx + M[1] * ry; y = o.y0 + M[2] * rx + M[3] * ry;
      r = t.r0 + ((tf.rot || 0) * Math.PI) / 180;
    }
    if (t.r !== r) textCache.delete(t);
    t.x = x + d[0]; t.y = y + d[1]; t.r = r; t.mover = !!o;
  }
}
function moveLevelThing(t, dx, dy) {
  if (t.kind === 'scene') { const d = movedScene.get(t.id) || [0, 0]; if (!movedScene.has(t.id)) liftForMove(); movedScene.set(t.id, [d[0] + dx, d[1] + dy]); }
  else { const d = movedObjects.get(t.id) || [0, 0]; if (!movedObjects.has(t.id)) liftForMove(); movedObjects.set(t.id, [d[0] + dx, d[1] + dy]); }
  applyBaseMoves();
  return true;
}
// A level thing about to move leaves the cached level: redraw only where it was.
function liftForMove() { queueMicrotask(() => { redrawChangedLevel(); tileWorkersReady(); }); }

function lodFor(scale) { return Math.max(-8, Math.min(1, Math.ceil(Math.log2(scale)))); }
function tileKey(z, tx, ty, part = null) { return baseVersion + '|' + draft.baseState + '|' + z + '|' + tx + '|' + ty + (part ? '|' + part : ''); }

function cachedTile(key) {
  const c = tileCache.get(key);
  if (c) { tileCache.delete(key); tileCache.set(key, c); }
  return c;
}

function renderBaseLayer(W, H, useArt) {
  const tl = cellOf(toWorld(0, 0).x, toWorld(0, 0).y);
  const br = cellOf(toWorld(W, H).x, toWorld(W, H).y);
  const minCx = tl.cx - 1, maxCx = br.cx + 1, minCy = br.cy - 1, maxCy = tl.cy + 1;
  if (partRange()[1] !== Infinity) { if (useArt) drawLayered(W, H, Infinity); return; }
  if (useArt) {
    drawLayered(W, H, Infinity);
  } else {
    const drawRuns = (runs, color) => {
      ctx.fillStyle = color;
      for (let i = 0; i < runs.length; i += 3) {
        const cy = runs[i], cx = runs[i + 1], len = runs[i + 2];
        if (cy < minCy || cy > maxCy || cx + len < minCx || cx > maxCx) continue;
        const r = cellRect(cx, cy, len);
        const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
        ctx.fillRect(x0, y0, Math.ceil(r.x + r.w) - x0, Math.ceil(r.y + r.h) - y0);
      }
    };
    layer.moss.forEach((r) => drawRuns(r, COLORS.moss));
    layer.ground.forEach((r) => drawRuns(r, COLORS.ground));
    layer.blue.forEach((r) => drawRuns(r, COLORS.blue));
    layer.orange.forEach((r) => drawRuns(r, COLORS.orange));
    removed.forEach((k) => {
      const [cx, cy] = unkey(k);
      if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) return;
      const r = cellRect(cx, cy);
      ctx.clearRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);
    });
    baseHaz.forEach((h, k) => {
      if (h.kind === 'vine' || removed.has(k)) return;
      const [cx, cy] = unkey(k);
      if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) return;
      if (h.kind === 'spike') drawSpike(cx, cy, h.q, COLORS[h.c]);
      else drawKillBox(cx, cy, base.defs[h.d].box, base.mats[h.m]);
    });
  }
  baseHaz.forEach((h, k) => {
    if (h.kind !== 'vine' || removedVines.has(k)) return;
    const [cx, cy] = unkey(k);
    if (cx >= minCx - 6 && cx <= maxCx + 6 && cy >= minCy - 6 && cy <= maxCy + 6) drawVine(cx, cy, base.defs[h.d].sprite, base.mats[h.m]);
  });
  if (useArt) drawSceneOverlays(W, H);
}

function renderRegion(cv, x, y, scale, part = null) {
  const saved = [canvas, ctx, cam, renderPart];
  renderPart = part;
  canvas = cv;
  ctx = cv.getContext('2d');
  cam = { x, y, scale };
  staticRender = true;
  try {
    renderBaseLayer(cv.width, cv.height, artReady());
  } finally {
    staticRender = false;
    [canvas, ctx, cam, renderPart] = saved;
  }
}

function renderTile(z, tx, ty, part = null) {
  const s = Math.pow(2, z), T = TILE_PX / s;
  const cv = makeCanvas();
  cv.width = cv.height = TILE_PX;
  renderRegion(cv, (tx + 0.5) * T, (ty + 0.5) * T, s, part);
  return cv;
}

const tileJobs = new Map();
let pieceCanvas = null;

function tileJob(key, z) {
  let job = tileJobs.get(key);
  if (!job) {
    const n = z >= -1 ? 1 : z >= -3 ? 2 : 4;
    const cv = makeCanvas();
    cv.width = cv.height = TILE_PX;
    job = { cv, g: cv.getContext('2d'), n, next: 0 };
    tileJobs.set(key, job);
  }
  return job;
}

function stepTileJob(job, z, tx, ty, part = null) {
  const s = Math.pow(2, z), T = TILE_PX / s, size = TILE_PX / job.n;
  const px = job.next % job.n, py = Math.floor(job.next / job.n);
  if (!pieceCanvas) pieceCanvas = makeCanvas();
  pieceCanvas.width = pieceCanvas.height = size;
  renderRegion(pieceCanvas, tx * T + ((px + 0.5) * T) / job.n, (ty + 1) * T - ((py + 0.5) * T) / job.n, s, part);
  job.g.drawImage(pieceCanvas, px * size, py * size);
  return ++job.next >= job.n * job.n;
}

function coarserTile(z, tx, ty, part = null) {
  const T = TILE_PX / Math.pow(2, z);
  for (let z2 = z - 1; z2 >= z - 4; z2--) {
    const s2 = Math.pow(2, z2), T2 = TILE_PX / s2;
    const tx2 = Math.floor((tx * T) / T2), ty2 = Math.floor((ty * T) / T2);
    const c = tileCache.get(tileKey(z2, tx2, ty2, part));
    if (c) return [c, (tx * T - tx2 * T2) * s2, (T2 * (ty2 + 1) - (ty + 1) * T) * s2, T * s2, T * s2];
  }
  return null;
}

function drawFromFiner(z, tx, ty, x0, y0, w, h, part = null) {
  let any = false;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const c = tileCache.get(tileKey(z + 1, tx * 2 + dx, ty * 2 + dy, part));
      if (!c) continue;
      ctx.drawImage(c, x0 + (dx * w) / 2, y0 + ((1 - dy) * h) / 2, w / 2, h / 2);
      any = true;
    }
  }
  return any;
}

function storeTile(key, tile) {
  tileCache.set(key, tile);
  while (tileCache.size > MAX_TILES) {
    const oldest = tileCache.keys().next().value;
    tileCache.get(oldest)?.close?.();
    tileCache.delete(oldest);
  }
}

// Without workers: the tiles just outside the view, drawn in idle moments so panning finds them ready.
const aheadQueue = new Map();
let aheadTimer = 0;
function drawAhead() {
  aheadTimer = 0;
  const deadline = performance.now() + 6;
  for (const [key, [z, tx, ty, part]] of aheadQueue) {
    aheadQueue.delete(key);
    if (tileCache.has(key) || !key.startsWith(baseVersion + '|')) continue;
    const job = tileJob(key, z);
    while (!stepTileJob(job, z, tx, ty, part)) { /* finish it */ }
    storeTile(key, job.cv); tileJobs.delete(key);
    if (performance.now() > deadline) break;
  }
  if (aheadQueue.size) scheduleAhead();
}
function scheduleAhead() {
  if (aheadTimer || !aheadQueue.size) return;
  aheadTimer = typeof requestIdleCallback === 'function' ? requestIdleCallback(drawAhead, { timeout: 200 }) : setTimeout(drawAhead, 30);
}
function drawBaseTiles(W, H, useArt, part = null) {
  aheadQueue.clear();
  if (useArt && partRange(part)[0] === -Infinity) drawBackground(W, H);
  // While the camera glides, tiles are drawn once for the zoom it's heading to, not every zoom on the way.
  const z = lodFor(camGoal.active && camGoal.scale != null ? camGoal.scale : cam.scale), s = Math.pow(2, z), T = TILE_PX / s;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const tiles = [];
  for (let ty = Math.floor(br.y / T) - 1; ty <= Math.floor(tl.y / T) + 1; ty++) {
    for (let tx = Math.floor(tl.x / T) - 1; tx <= Math.floor(br.x / T) + 1; tx++) {
      const visible = ty >= Math.floor(br.y / T) && ty <= Math.floor(tl.y / T) && tx >= Math.floor(tl.x / T) && tx <= Math.floor(br.x / T);
      tiles.push([tx, ty, visible]);
    }
  }
  const dist = (t) => (t[2] ? 0 : 1e12) + Math.hypot((t[0] + 0.5) * T - cam.x, (t[1] + 0.5) * T - cam.y);
  tiles.sort((a, b) => dist(a) - dist(b));
  const workers = tileWorkersReady();
  const deadline = performance.now() + (loading ? 40 : TILE_BUDGET_MS);
  let missing = false, shown = 0, inView = 0;
  for (const [tx, ty, visible] of tiles) {
    const key = tileKey(z, tx, ty, part);
    let c = cachedTile(key);
    let job = null;
    if (!c) {
      // Every tile in view is drawn now, never left for later; the workers only draw ahead.
      if (visible) {
        job = tileJob(key, z);
        while (!stepTileJob(job, z, tx, ty, part)) { /* finish it */ }
        c = job.cv; storeTile(key, c); tileJobs.delete(key); job = null;
        if (pool.inflight?.has(key)) dirtyGen.set(key, stateVersion + 1);
      } else if (workers) requestTile(key, z, tx, ty, part);
      else aheadQueue.set(key, [z, tx, ty, part]);
    }
    if (!visible) continue;
    inView++;
    const a = toScreen(tx * T, (ty + 1) * T), b = toScreen((tx + 1) * T, ty * T);
    const x0 = Math.round(a.x), y0 = Math.round(a.y), w = Math.round(b.x) - x0, h = Math.round(b.y) - y0;
    if (c) { ctx.drawImage(c, x0, y0, w, h); shown++; continue; }
    missing = true;
    const coarse = coarserTile(z, tx, ty, part);
    if (coarse) ctx.drawImage(coarse[0], coarse[1], coarse[2], coarse[3], coarse[4], x0, y0, w, h);
    else drawFromFiner(z, tx, ty, x0, y0, w, h, part);
    if (job?.next) ctx.drawImage(job.cv, x0, y0, w, h);
  }
  if (tileJobs.size > 256) {
    const current = baseVersion + '|' + draft.baseState + '|' + z + '|', coarse = baseVersion + '|' + draft.baseState + '|' + PRELOAD_Z + '|';
    for (const k of tileJobs.keys()) if (!k.startsWith(current) && !k.startsWith(coarse)) tileJobs.delete(k);
  }
  if (loading?.render && !prefetch) planPrefetch(W, H, true);
  const pending = pumpPrefetch(workers);
  if (loading?.render && !missing && !pending) hideLoading();
  if (!loading && !missing && !pending) {
    const at = z + '|' + Math.floor(cam.x / (T * 4)) + '|' + Math.floor(cam.y / (T * 4));
    if (at !== prefetchAt) { prefetchAt = at; planPrefetch(W, H, false); }
  }
  if (missing && !workers) requestDraw();
  scheduleAhead();
}

const PRELOAD_Z = -4;
let prefetch = null;
let prefetchAt = '';
let boundsCache = null;
function levelBounds() {
  if (boundsCache?.state === draft.baseState) return boundsCache;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of base.art.layers) {
    if (l.state !== 'always' && l.state !== draft.baseState) continue;
    if (/^(OOB|Background)/.test(l.name)) continue;
    for (let i = 0; i < l.runs.length; i += 5) {
      const y = l.oy + l.runs[i] * l.size, x = l.ox + l.runs[i + 1] * l.size;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + l.runs[i + 2] * l.size); y0 = Math.min(y0, y); y1 = Math.max(y1, y + l.size);
    }
  }
  return (boundsCache = { state: draft.baseState, x0, y0, x1, y1 });
}
function planPrefetch(W, H, full) {
  const q = [], seen = new Set();
  const add = (z, x0, y0, x1, y1) => {
    const T = TILE_PX / Math.pow(2, z);
    for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++) for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) {
      const k = z + ',' + tx + ',' + ty;
      if (!seen.has(k)) { seen.add(k); q.push([z, tx, ty]); }
    }
  };
  const z = lodFor(cam.scale), tl = toWorld(0, 0), br = toWorld(W, H), wv = br.x - tl.x, hv = tl.y - br.y;
  const d = (t) => Math.hypot((t[1] + 0.5) * TILE_PX / Math.pow(2, t[0]) - cam.x, (t[2] + 0.5) * TILE_PX / Math.pow(2, t[0]) - cam.y);
  add(z, tl.x - wv * (full ? 1 : 0.6), br.y - hv * (full ? 1 : 0.6), br.x + wv * (full ? 1 : 0.6), tl.y + hv * (full ? 1 : 0.6));
  q.sort((a, b) => d(a) - d(b));
  if (full && z > PRELOAD_Z) { const b = levelBounds(); if (Number.isFinite(b.x0)) add(PRELOAD_Z, b.x0, b.y0, b.x1, b.y1); }
  prefetch = { queue: q, total: q.length };
}
function pumpPrefetch(workers) {
  if (!prefetch) return false;
  prefetch.queue = prefetch.queue.filter(([z, tx, ty]) => !tileCache.has(tileKey(z, tx, ty)));
  const deadline = performance.now() + (loading ? 40 : 3);
  for (const [z, tx, ty] of prefetch.queue) {
    const key = tileKey(z, tx, ty);
    if (workers) { requestTile(key, z, tx, ty); continue; }
    if (performance.now() > deadline) break;
    const job = tileJob(key, z);
    while (performance.now() < deadline) if (stepTileJob(job, z, tx, ty)) { storeTile(key, job.cv); tileJobs.delete(key); break; }
  }
  const left = prefetch.queue.length;
  if (loading?.render) setLoading(0.7 + 0.3 * (1 - left / Math.max(1, prefetch.total)), `Rendering the level ${prefetch.total - left} / ${prefetch.total}`);
  if (!left) { prefetch = null; return false; }
  if (!workers) requestDraw();
  return true;
}

const pool = { workers: [], ready: 0, failed: false, inflight: new Map(), version: -1 };

function startTileWorkers() {
  let off = false;
  try { off = !!localStorage.getItem('mapMakerNoWorkers'); } catch {}
  if (off || pool.workers.length || pool.failed || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;
  const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  for (let n = 0; n < count; n++) {
    let worker;
    try { worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' }); } catch { pool.failed = true; return; }
    worker.jobs = 0;
    worker.ready = false;
    worker.onmessage = (e) => onWorkerMessage(worker, e.data);
    worker.onerror = () => failWorkers();
    worker.postMessage({ type: 'init', state: workerState() });
    pool.workers.push(worker);
  }
  setTimeout(() => { if (!pool.ready && pool.workers.length) failWorkers(); }, 5000);
}

function failWorkers() {
  pool.failed = true;
  for (const w of pool.workers) w.terminate();
  pool.workers = [];
  pool.ready = 0;
  pool.inflight.clear();
  requestDraw();
}

function workerState() {
  return { baseState: draft.baseState, removed: [...removed], removedVines: [...removedVines], removedScene: [...removedScene], removedDeco: [...removedDeco], removedObjects: [...removedObjects], movedScene: [...movedScene], movedObjects: [...movedObjects], levelOrder: [...levelOrder], levelTf: [...levelTf], simulate: !!draft.simulate, baseEdits: draft.baseEdits || {}, version: baseVersion };
}

function onWorkerMessage(worker, m) {
  if (m.type === 'ready') { worker.ready = true; pool.ready++; requestDraw(); return; }
  if (m.type === 'unsupported') { failWorkers(); return; }
  if (m.type !== 'tile') return;
  worker.jobs--;
  pool.inflight.delete(m.key);
  if (m.bitmap && m.key.startsWith(baseVersion + '|') && (m.gen ?? 0) >= (dirtyGen.get(m.key) || 0)) { storeTile(m.key, m.bitmap); requestDraw(); }
  else m.bitmap?.close?.();
}

function tileWorkersReady() {
  if (!pool.ready) return false;
  if (pool.version !== baseVersion + '/' + stateVersion) {
    pool.version = baseVersion + '/' + stateVersion;
    pool.inflight.clear();
    const state = workerState();
    for (const w of pool.workers) w.postMessage({ type: 'state', state });
  }
  return true;
}

function requestTile(key, z, tx, ty, part = null) {
  if (pool.inflight.has(key)) return;
  const free = pool.workers.filter((w) => w.ready).sort((a, b) => a.jobs - b.jobs)[0];
  if (!free || free.jobs >= 3) return;
  free.jobs++;
  pool.inflight.set(key, free);
  free.postMessage({ type: 'tile', key, z, tx, ty, part, gen: stateVersion });
}

export async function workerInit(state) {
  if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('2d')) throw new Error('no OffscreenCanvas 2D');
  const bitmap = async (url) => {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    img.complete = true;
    img.naturalWidth = img.width;
    img.naturalHeight = img.height;
    return img;
  };
  base = await (await fetch('/maps/basemap.json')).json();
  pieceStamps = null;
  const vines = [...new Set(base.defs.filter((d) => d.kind === 'vine').map((d) => d.sprite))];
  [atlasImg, sceneImg] = await Promise.all([bitmap('/maps/' + base.art.atlas), bitmap('/maps/' + base.scene.atlas)]);
  const fonts = await Promise.all((base.scene.fonts || []).map((f) => (f ? bitmap('/maps/' + f.atlas) : null)));
  fonts.forEach((f, n) => { fontImages[n] = f; });
  const vineBitmaps = await Promise.all(vines.map((v) => bitmap('/maps/vines/' + encodeURIComponent(v) + '.png').catch(() => null)));
  vines.forEach((v, n) => { if (vineBitmaps[n]) vineImages[v] = vineBitmaps[n]; });
  draft.useBase = true;
  workerSetState(state);
  const probe = new OffscreenCanvas(4, 4);
  probe.getContext('2d').drawImage(atlasImg, 0, 0, 4, 4);
  probe.transferToImageBitmap().close();
}

export function workerSetState(state) {
  removed = new Set(state.removed);
  removedVines = new Set(state.removedVines);
  removedScene = new Set(state.removedScene || []);
  removedObjects = new Set(state.removedObjects || []);
  removedDeco = new Set(state.removedDeco || []);
  movedScene = new Map(state.movedScene || []);
  movedObjects = new Map(state.movedObjects || []);
  levelOrder = new Map(state.levelOrder || []);
  levelTf = new Map(state.levelTf || []);
  draft.simulate = !!state.simulate;
  draft.baseEdits = state.baseEdits || {};
  syncRemovedPaths();
  if (!layer || draft.baseState !== state.baseState) {
    draft.baseState = state.baseState;
    applyBaseState();
  }
  applyBaseMoves();
  baseVersion = state.version;
}

export function workerRenderTile(z, tx, ty, part = null) {
  return renderTile(z, tx, ty, part).transferToImageBitmap();
}

function draw() {
  if (!ctx) return;
  if (loading?.render && !baseOn()) hideLoading();
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  const tl = cellOf(toWorld(0, 0).x, toWorld(0, 0).y);
  const br = cellOf(toWorld(W, H).x, toWorld(W, H).y);
  const minCx = tl.cx - 1, maxCx = br.cx + 1, minCy = br.cy - 1, maxCy = tl.cy + 1;
  const cellPx = CELL * cam.scale;

  if (cellPx >= 10 && !draft.noGrid) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let cx = minCx; cx <= maxCx; cx++) { const x = Math.round(cellRect(cx, 0).x) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let cy = minCy; cy <= maxCy; cy++) { const y = Math.round(cellRect(0, cy).y) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  const pad = cellPx < 2 ? 0.6 : 0.5;
  const drawRuns = (runs, color) => {
    ctx.fillStyle = color;
    for (let i = 0; i < runs.length; i += 3) {
      const cy = runs[i], cx = runs[i + 1], len = runs[i + 2];
      if (cy < minCy || cy > maxCy || cx + len < minCx || cx > maxCx) continue;
      const r = cellRect(cx, cy, len);
      const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
      ctx.fillRect(x0, y0, Math.ceil(r.x + r.w) - x0, Math.ceil(r.y + r.h) - y0);
    }
  };
  const useArt = artReady();
  if (baseOn() && !layerHidden('level')) {
    const behind = stack().filter((e) => e.it.behind);
    if (behind.length && useArt) {
      // The level in bands, split where things were put behind it, each thing between them.
      const cuts = [...new Set(behind.map((e) => cutOf(e.it)))].sort((a, b) => a - b);
      let lo = -Infinity;
      for (const cut of cuts) {
        drawBaseTiles(W, H, useArt, lo + ':' + cut);
        drawStackEntries(behind.filter((e) => cutOf(e.it) === cut));
        lo = cut;
      }
      drawBaseTiles(W, H, useArt, lo + ':Infinity');
    } else drawBaseTiles(W, H, useArt);
    if (useArt) drawLiveItems(W, H);
    if (useArt) drawCredits(W, H, 'fake');
    if (useArt && cam.scale >= LIVE_MIN_SCALE && sceneList?.texts?.some((t) => t.mover)) drawSceneText(toWorld(0, 0), toWorld(W, H), true);
    ctx.save();
    ctx.strokeStyle = COLORS.removed;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    removed.forEach((k) => {
      if (blocks.has(k) || spikes.has(k)) return;
      const [cx, cy] = unkey(k);
      if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) return;
      const r = cellRect(cx, cy);
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
    });
    ctx.restore();
  } else {
    const o = toScreen(0, OFFSET_Y);
    ctx.strokeStyle = COLORS.grid.replace('0.05', '0.18');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(o.x) + 0.5, 0); ctx.lineTo(Math.round(o.x) + 0.5, H);
    ctx.moveTo(0, Math.round(o.y) + 0.5); ctx.lineTo(W, Math.round(o.y) + 0.5);
    ctx.stroke();
  }

  if (useArt && !layerHidden('tiles')) drawPlacedTiles(false);
  if (!layerHidden('blocks')) blocks.forEach((kind, k) => {
    const [cx, cy] = unkey(k);
    if (useArt) {
      const art = blockArt(kind, cx, cy);
      if (art && drawGroundArt(cx, cy, art)) return;
    }
    const r = cellRect(cx, cy);
    ctx.fillStyle = COLORS[kind] || BLOCK_SETS[kind]?.color || COLORS.ground;
    ctx.fillRect(r.x, r.y, r.w + pad, r.h + pad);
  });
  if (!layerHidden('hazards')) spikes.forEach((sp, k) => {
    const [cx, cy] = unkey(k);
    const q = spikeTurn(sp, cx, cy);
    if (sp.c === 'true') return drawTrueSpike(cx, cy, q);
    if (useArt && base) { const t = spikeTile(sp.c, q); if (drawTileArt(cx, cy, t.tile, t.matrix)) return; }
    drawSpike(cx, cy, q, COLORS[sp.c]);
  });

  const near = (cx, cy) => cx >= minCx - 6 && cx <= maxCx + 6 && cy >= minCy - 6 && cy <= maxCy + 6;
  if (!layerHidden('hazards')) vines.forEach((v, k) => { const [cx, cy] = unkey(k); if (near(cx, cy)) drawVine(cx, cy, v.s, rotMatrix(v.q)); });
  if (!layerHidden('blocks')) mossCells.forEach((_, k) => { if (!useArt || !drawMoss(k)) { const c = mossCenter(k), g = layerGrid('moss'), a = toScreen(c.x - g.size / 2, c.y + g.size / 2); ctx.fillStyle = COLORS.moss; ctx.fillRect(a.x, a.y, g.size * cam.scale, g.size * cam.scale); } });
  if (useArt && !layerHidden('tiles')) drawPlacedTiles(true);
  // Course screens show in front of the walls, as in the game; placed objects still go over them.
  if (!layerHidden('course')) for (const c of courses()) drawCourseScreen(c, courseColor(c.id), courseNumber(c.id));
  // Things behind the level are drawn with it (above); without the level, before your blocks.
  if (!(baseOn() && !layerHidden('level') && useArt)) drawStackEntries(stack().filter((e) => e.it.behind));
  drawStackEntries(stack().filter((e) => !e.it.behind));
  drawSelection();
  if (draft.hitboxes) drawHitboxes(minCx, maxCx, minCy, maxCy);

  if (baseOn()) for (const o of baseObjects) {
    const c = toScreen(o.x, o.y);
    if (removedObjects.has(o.id)) continue;
    if (useArt && sceneReady() && o.kind === 'upgrade') continue;
    if (o.kind === 'trigger' && cam.scale < (o.cls === 'EndCreditsTrigger' || o.cls === 'FakeCreditsControlScript' ? 0.03 : 0.15)) continue;
    if (cam.scale < 0.1) {
      ctx.fillStyle = COLORS.upgrade;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    const w = Math.max(4, o.w * cam.scale), h = Math.max(4, o.h * cam.scale);
    if (c.x + w < 0 || c.x - w > W || c.y + h < 0 || c.y - h > H) continue;
    const credits = o.cls === 'EndCreditsTrigger' || o.cls === 'FakeCreditsControlScript';
    const color = o.kind === 'upgrade' ? COLORS.upgrade : o.cls === 'longFallColliderController' ? COLORS.fall : credits ? '#f0a0d0' : COLORS.trigger;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (o.kind === 'trigger') ctx.setLineDash([5, 4]);
    else { ctx.fillStyle = color; ctx.globalAlpha = 0.18; ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h); ctx.globalAlpha = 1; }
    ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
    if (cam.scale >= 0.12 && !(useArt && sceneReady())) {
      ctx.fillStyle = color;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(o.label, c.x, c.y - h / 2 - 4);
    }
    ctx.restore();
    if (o.cls === 'longFallColliderController') drawBadge('fall', c.x, c.y - h / 2 - 14, color, cam.scale >= 0.2 ? o.label.toUpperCase() : '');
    if (credits && cam.scale >= 0.03) drawBadge(CREDIT_ICON, c.x, c.y - h / 2 - 14, color, (o.cls === 'EndCreditsTrigger' ? 'END CREDITS' : 'FAKE CREDITS') + (draft.simulate ? ' ▶ PLAYING' : ' · SIMULATE (T) TO PLAY'));
  }

  if (baseOn()) {
    for (const c of base.courses) {
      ctx.globalAlpha = courses().length ? 0.35 : 1;
      if (c.start) drawGate(c.start, c.start.box || START_BOX, COLORS.start, 'START');
      ctx.globalAlpha = courses().length ? 0.35 : 1;
      if (c.end) drawGate(c.end, c.end.box || END_BOX, COLORS.end, 'END');
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.55;
      if (cam.scale >= 0.15) for (const r of c.resets || []) if (r.box) drawGate(r, r.box, COLORS.reset, 'TIMER RESET');
    }
    ctx.globalAlpha = 1;
  }
  if (baseOn() && base.scene && cam.scale >= 0.15 && !layerHidden('level')) drawMarkers();
  if (baseOn() && !layerHidden('level')) drawStageMask(minCx, maxCx, minCy, maxCy);
  if (!layerHidden('course')) { drawCourses(); triggers.forEach(drawTrigger); }
  if (platformEdit != null) drawPlatformEdit();
  if (!layerHidden('objects')) drawTeleportLinks();

  const area = baseOn() ? null : exportArea();
  if (area) {
    const a = cellRect(area.x0, area.y1);
    const b = cellRect(area.x1, area.y0);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = COLORS.area;
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x + b.w - a.x, b.y + b.h - a.y);
    ctx.setLineDash([]);
  }

  if (hover && !drag?.pan) {
    const { cx, cy } = hover;
    ctx.globalAlpha = 0.5;
    if (BLOCK_KIND[tool]) { ctx.fillStyle = COLORS[BLOCK_KIND[tool]]; const r = cellRect(cx, cy); ctx.fillRect(r.x, r.y, r.w, r.h); }
    else if (tool === 'trueSpike') { ctx.globalAlpha = 0.7; drawTrueSpike(cx, cy, spikePlaceTurn ?? autoSpikeTurn(cx, cy)); }
    else if (SPIKE_KIND[tool]) drawSpike(cx, cy, spikePlaceTurn ?? autoSpikeTurn(cx, cy), COLORS[SPIKE_KIND[tool]]);
    else if (tool === 'vine' && base) drawVine(cx, cy, draft.vineSprite, rotMatrix(placeRot));
    else if (tool === 'moss' && base) { const w = cellWorld(cx, cy), c = mossCenter(mossKeyAt(w.x + CELL / 2, w.y + CELL / 2)), g = layerGrid('moss'), a = toScreen(c.x - g.size / 2, c.y + g.size / 2); ctx.fillStyle = COLORS.moss; ctx.fillRect(a.x, a.y, g.size * cam.scale, g.size * cam.scale); }
    else if (tool === 'tile' && base && draft.pick.tile) { const w = cellWorld(cx, cy); const tk = tileKeyAt(draft.pick.tileLayer, w.x + CELL / 2, w.y + CELL / 2); ctx.globalAlpha = 1; drawPlacedTile({ layer: draft.pick.tileLayer, tile: draft.pick.tile, q: 0 }, tk, 0.6); }
    else if ((tool === 'object' || tool === 'decor') && base) { const w = cellWorld(cx, cy); const cat = tool === 'object' ? 'objects' : 'decor'; ctx.globalAlpha = 1; (() => { const i = tool === 'object' ? draft.pick.obj ?? 0 : draft.pick.decorObj ?? 0; drawPlacedObject({ cat, i, ...placementFor(catalogItem({ cat, i }), cx, cy) }, 0.6); })(); }
    else if (tool === 'stamp' && allStamps()[draft.pick.stamp]) { const w = cellWorld(cx, cy); ctx.globalAlpha = 1; for (const [tk, t] of stampTiles(allStamps()[draft.pick.stamp], w.x + CELL / 2, w.y + CELL / 2, placeRot, placeFlip)) drawPlacedTile(t, tk, 0.6); }
    else if (tool === 'arrow' && base) { ctx.globalAlpha = 1; drawArrowNodes(cx, cy); }
    else if (tool === 'paste' && brush) { ctx.globalAlpha = 1; drawBrush(cx, cy); }
    else if (tool === 'select') {
      const t = hoverWorld && !drag && itemAt(hoverWorld.x, hoverWorld.y);
      if (t && !targetsOf(selection).some((x) => sameTarget(x, t))) { ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([]); drawTarget(t); }
    }
    else if (tool === 'start') drawGate(gateAt(cx, cy, 'start'), START_BOX, COLORS.start, 'START');
    else if (tool === 'end') drawGate(gateAt(cx, cy, 'end'), END_BOX, COLORS.end, 'END');
    else if (tool === 'spawn') drawGate(gateAt(cx, cy, 'spawn'), SPAWN_BOX, COLORS.spawn, 'SPAWN');
    else { ctx.strokeStyle = COLORS.end; ctx.lineWidth = 2; const r = cellRect(cx, cy); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    ctx.globalAlpha = 1;
  }
}

function drawMarkers() {
  const sc = base.scene, inState = (m) => m.state === 'always' || m.state === draft.baseState || !m.state;
  ctx.save();
  ctx.globalAlpha = 0.55;
  for (const cp of sc.checkpoints || []) {
    if (!inState(cp) || !cp.box) continue;
    drawGate({ x: cp.at[0], y: cp.at[1] }, cp.box, COLORS.checkpoint, 'CHECKPOINT');
  }
  for (const r of sc.respawns || []) drawGate({ x: r.at[0], y: r.at[1] }, SPAWN_BOX, COLORS.respawn, 'C' + r.course + ' RESPAWN');
  ctx.restore();
}


function toggleHitboxes() {
  draft.hitboxes = !draft.hitboxes;
  root.querySelector('#mm-hitbox').classList.toggle('active', draft.hitboxes);
  saveDraft();
  requestDraw();
}

const HIT = { solid: 'rgba(65, 248, 141, 0.9)', solidFill: 'rgba(65, 248, 141, 0.12)', kill: 'rgba(255, 70, 90, 0.95)', killFill: 'rgba(255, 70, 90, 0.28)' };

function defByTile(tile) {
  if (!base) return null;
  if (!defByTile.map) defByTile.map = new Map(base.defs.map((d) => [d.layer + '|' + d.tile, d]));
  return defByTile.map.get(tile);
}

function scratchCanvas(name) {
  const c = (scratchCanvas[name] ||= makeCanvas());
  if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
  return c;
}
const killMask = () => scratchCanvas('mask');
const killEdge = () => scratchCanvas('edge');

function shapeBox(shape, m) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of shape) for (const [x, y] of poly) {
    const px = m[0] * x + m[1] * y, py = m[2] * x + m[3] * y;
    b[0] = Math.min(b[0], px); b[1] = Math.min(b[1], py); b[2] = Math.max(b[2], px); b[3] = Math.max(b[3], py);
  }
  return b;
}

function fillHitShape(cx, cy, shape, m) {
  const w = cellWorld(cx, cy), ox = w.x + CELL / 2, oy = w.y + CELL / 2;
  ctx.beginPath();
  for (const poly of shape) {
    poly.forEach(([x, y], i) => {
      const p = toScreen(ox + m[0] * x + m[1] * y, oy + m[2] * x + m[3] * y);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  }
  ctx.fill();
}

function drawHitboxes(minCx, maxCx, minCy, maxCy) {
  ctx.save();
  ctx.lineWidth = 1;
  const inView = (cx, cy, pad = 0) => cx >= minCx - pad && cx <= maxCx + pad && cy >= minCy - pad && cy <= maxCy + pad;
  const cellBox = (cx, cy, len = 1) => { const r = cellRect(cx, cy, len); ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1); };
  const solidRuns = (runsList, stroke, fill) => {
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fill;
    for (const runs of runsList) {
      for (let i = 0; i < runs.length; i += 3) {
        const cy = runs[i], cx = runs[i + 1], len = runs[i + 2];
        if (cy < minCy || cy > maxCy || cx + len < minCx || cx > maxCx) continue;
        let start = cx;
        for (let x = cx; x <= cx + len; x++) {
          if (x === cx + len || removed.has(key(x, cy))) { if (x > start) cellBox(start, cy, x - start); start = x + 1; }
        }
      }
    }
  };
  if (baseOn()) {
    solidRuns([...layer.ground, ...layer.moss], HIT.solid, HIT.solidFill);
    solidRuns(layer.blue, COLORS.blue, 'rgba(63, 127, 224, 0.2)');
    solidRuns(layer.orange, COLORS.orange, 'rgba(224, 138, 63, 0.2)');
  }
  blocks.forEach((kind, k) => {
    const [cx, cy] = unkey(k);
    if (!inView(cx, cy)) return;
    ctx.strokeStyle = isGround(kind) ? HIT.solid : COLORS[kind];
    ctx.fillStyle = isGround(kind) ? HIT.solidFill : 'rgba(255,255,255,0.12)';
    cellBox(cx, cy);
  });
  const mask = killMask();
  const g = mask.getContext('2d');
  g.clearRect(0, 0, mask.width, mask.height);
  g.fillStyle = '#000';
  const saved = ctx;
  ctx = g;
  const hazards = new Map();
  const addShape = (cx, cy, d, m, vine) => {
    if (!d?.shape) return;
    fillHitShape(cx, cy, d.shape, m);
    if (!vine) hazards.set(key(cx, cy), { layer: d.layer, box: shapeBox(d.shape, m) });
  };
  if (baseOn()) baseHaz.forEach((h, k) => {
    const [cx, cy] = unkey(k);
    const vine = h.kind === 'vine';
    if (!inView(cx, cy, vine ? 6 : 1) || (vine ? removedVines.has(k) || vines.has(k) : removed.has(k) || blocks.has(k) || spikes.has(k))) return;
    addShape(cx, cy, base.defs[h.d], base.mats[h.m], vine);
  });
  if (base) {
    spikes.forEach((sp, k) => {
      const [cx, cy] = unkey(k);
      if (!inView(cx, cy, 1)) return;
      if (sp.c === 'true') { const d = trueSpikeDef(); addShape(cx, cy, { layer: 'Spikes', shape: d.shape }, rotMatrix(spikeTurn(sp, cx, cy)), false); return; }
      const t = spikeTile(sp.c, spikeTurn(sp, cx, cy));
      addShape(cx, cy, defByTile(t.layer + '|' + t.tile), t.matrix, false);
    });
    vines.forEach((v, k) => {
      const [cx, cy] = unkey(k);
      if (!inView(cx, cy, 6)) return;
      const t = vineTile(v.s, v.q);
      addShape(cx, cy, defByTile(t.layer + '|' + t.tile), t.matrix, true);
    });
    const merge = base.hazardMerge || {};
    hazards.forEach((a, k) => {
      const reach = 2 * (merge[a.layer] || 0);
      if (!reach) return;
      const [cx, cy] = unkey(k);
      const east = hazards.get(key(cx + 1, cy)), north = hazards.get(key(cx, cy + 1));
      const w = cellWorld(cx, cy), ox = w.x + CELL / 2, oy = w.y + CELL / 2;
      const bridge = (x0, y0, x1, y1, across) => {
        const p = toScreen(ox + x0, oy + y1), q = toScreen(ox + x1, oy + y0);
        const x = Math.round(p.x) - across, y = Math.round(p.y) - !across;
        g.fillRect(x, y, Math.round(q.x) + across - x, Math.round(q.y) + !across - y);
      };
      if (east && east.layer === a.layer) {
        const gap = CELL + east.box[0] - a.box[2];
        const y0 = Math.max(a.box[1], east.box[1]), y1 = Math.min(a.box[3], east.box[3]);
        if (gap > 0 && gap <= reach && y1 > y0) bridge(a.box[2], y0, CELL + east.box[0], y1, 1);
      }
      if (north && north.layer === a.layer) {
        const gap = CELL + north.box[1] - a.box[3];
        const x0 = Math.max(a.box[0], north.box[0]), x1 = Math.min(a.box[2], north.box[2]);
        if (gap > 0 && gap <= reach && x1 > x0) bridge(x0, a.box[3], x1, CELL + north.box[1], 0);
      }
    });
  }
  ctx = saved;
  const edge = killEdge();
  const e = edge.getContext('2d');
  e.globalCompositeOperation = 'copy';
  e.drawImage(mask, -1, 0);
  e.globalCompositeOperation = 'source-over';
  e.drawImage(mask, 1, 0); e.drawImage(mask, 0, -1); e.drawImage(mask, 0, 1);
  e.globalCompositeOperation = 'destination-out';
  e.drawImage(mask, 0, 0);
  e.globalCompositeOperation = 'source-in';
  e.fillStyle = HIT.kill;
  e.fillRect(0, 0, edge.width, edge.height);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = HIT.killFill;
  g.fillRect(0, 0, mask.width, mask.height);
  g.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(mask, 0, 0);
  ctx.drawImage(edge, 0, 0);
  ctx.restore();
}

const BLOCK_KIND = { block: 'ground', dark: 'dark', blue: 'blue', orange: 'orange', ...Object.fromEntries(Object.keys(BLOCK_SETS).map((k) => [k, k])) };
const SPIKE_KIND = { spike: 'spike', darkSpike: 'dark', blueSpike: 'blue', orangeSpike: 'orange', trueSpike: 'true' };

// ---- free spikes: the Hazards spikes, placed off the grid with a finer snap ----
function placeFreeSpike(c, at) {
  const snap = snapV(), p = snapPoint(at, snap);
  if (freeSpikes.some((f) => Math.abs(f.x - p.x) < snap && Math.abs(f.y - p.y) < snap)) return false;
  const cell = cellOf(p.x, p.y);
  freeSpikes.push({ x: p.x, y: p.y, c, q: spikePlaceTurn ?? autoSpikeTurn(cell.cx, cell.cy) });
  return true;
}
const freeSpikeAt = (wx, wy) => freeSpikes.findLastIndex((f) => Math.abs(wx - f.x) <= CELL / 2 && Math.abs(wy - f.y) <= CELL / 2);
// A free spike's own turn (past its quarter turn), size and flips, as a world matrix.
const freeSpikeExtra = (f) => mul2(rot2(((f.r || 0) * Math.PI) / 180), [(f.s || 1) * (f.fx ? -1 : 1), 0, 0, (f.s || 1) * (f.fy ? -1 : 1)]);
function drawFreeSpike(f) {
  if (!f.r && !f.s && !f.fx && !f.fy) return drawFreeSpikeCore(f);
  const c = toScreen(f.x, f.y);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(-((f.r || 0) * Math.PI) / 180);
  ctx.scale((f.s || 1) * (f.fx ? -1 : 1), (f.s || 1) * (f.fy ? -1 : 1));
  ctx.translate(-c.x, -c.y);
  drawFreeSpikeCore(f);
  ctx.restore();
}
function drawFreeSpikeCore(f) {
  if (f.c === 'true' && artReady()) return drawTrueSpikeAt(f.x, f.y, f.q);
  const c = toScreen(f.x, f.y);
  if (base && artReady()) {
    const t = spikeTile(f.c === 'true' ? 'spike' : f.c, f.q), sprite = base.art?.tiles?.[t.tile];
    if (sprite !== undefined) { ctx.save(); blitSprite(ctx, sprite, t.matrix, cam.scale, c.x, c.y); ctx.restore(); return; }
  }
  const r = rotMatrix(f.q), h = (CELL / 2) * cam.scale, pt = (x, y) => [c.x + r[0] * x * h + r[1] * y * h, c.y - (r[2] * x * h + r[3] * y * h)];
  ctx.fillStyle = COLORS[f.c] || COLORS.spike;
  ctx.beginPath(); ctx.moveTo(...pt(-1, -1)); ctx.lineTo(...pt(1, -1)); ctx.lineTo(...pt(0, 1)); ctx.closePath(); ctx.fill();
}
// ---- music and backgrounds: files kept in IndexedDB, chosen map-wide or by triggers ----
const GAME_TRACKS = [['Area1Track1', 'Area 1 - track 1'], ['Area1Track2', 'Area 1 - track 2'], ['Area2Track1', 'Area 2 - track 1'], ['Area2Track2', 'Area 2 - track 2'], ['TripBreaker', 'Trip breaker'], ['Overgrowth', 'Overgrowth']];
let assetDbPromise = null;
function assetDb() {
  assetDbPromise ||= new Promise((ok, fail) => {
    const req = indexedDB.open('rechargeMapAssets', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
  return assetDbPromise;
}
async function assetBlob(file) {
  const db = await assetDb();
  return new Promise((ok) => { const r = db.transaction('files').objectStore('files').get(file); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); });
}
async function putAsset(file, blob) {
  const db = await assetDb();
  return new Promise((ok, fail) => { const t = db.transaction('files', 'readwrite'); t.objectStore('files').put(blob, file); t.oncomplete = ok; t.onerror = () => fail(t.error); });
}
const assetList = (kind) => (draft.assets || []).filter((a) => a.kind === kind);
// Adds a picked file to the map: stored under a unique file name, listed in draft.assets.
async function addAsset(kind, fileObj) {
  const ext = (fileObj.name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
  const file = kind + '-' + Date.now().toString(36) + ext;
  await putAsset(file, fileObj);
  draft.assets = [...(draft.assets || []), { file, name: fileObj.name, kind }];
  saveDraft();
  return file;
}
function pickFile(accept) {
  return new Promise((ok) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => ok(inp.files[0] || null);
    inp.click();
  });
}
const assetName = (file) => (draft.assets || []).find((a) => a.file === file)?.name || file;
function musicOptions(current, withKeep) {
  const opt = (v, t) => `<option value="${v}"${current === v ? ' selected' : ''}>${t}</option>`;
  return (withKeep ? opt('', 'No change') : '') + opt('level', 'The level\'s own') + opt('none', 'Silence')
    + GAME_TRACKS.map(([id, t]) => opt('game:' + id, t)).join('')
    + assetList('music').map((a) => opt('asset:' + a.file, '♪ ' + a.name)).join('')
    + opt('add', 'Add a music file…');
}
function backgroundOptions(current, withKeep) {
  const opt = (v, t) => `<option value="${v}"${current === v ? ' selected' : ''}>${t}</option>`;
  return (withKeep ? opt('', 'No change') : '') + opt('level', 'The level\'s own')
    + assetList('image').map((a) => opt(a.file, '🖼 ' + a.name)).join('')
    + opt('add', 'Add an image…');
}
const musicLabel = (m) => !m ? '' : m === 'level' ? 'level music' : m === 'none' ? 'silence' : m.startsWith('game:') ? (GAME_TRACKS.find(([id]) => 'game:' + id === m)?.[1] || m) : assetName(m.slice(6));
// A picked option: 'add' asks for a file first. Resolves to the stored value.
async function resolveMediaChoice(kind, value) {
  if (value !== 'add') return value;
  const f = await pickFile(kind === 'music' ? 'audio/ogg,audio/mpeg,audio/wav,.ogg,.mp3,.wav' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp');
  if (!f) return null;
  const file = await addAsset(kind, f);
  return kind === 'music' ? 'asset:' + file : file;
}
// The background as the map file stores it.
function backgroundJson(bg) {
  if (!bg?.image) return 'level';
  return { image: bg.image, parallax: bg.parallax ?? 0.8, scale: bg.scale ?? 1 };
}
// The files the exported map uses, base64 - sent along to be saved in its assets folder.
async function mapAssets() {
  const used = new Set();
  const note = (m) => { if (typeof m === 'string' && m.startsWith('asset:')) used.add(m.slice(6)); };
  note(draft.music);
  if (draft.background?.image) used.add(draft.background.image);
  for (const cs of [...csprites, ...Object.values(draft.stageEdits || {}).flatMap((v) => v?.csprites || [])]) if (cs.image) used.add(cs.image);
  for (const t of [...triggers, ...Object.values(draft.stageEdits || {}).flatMap((v) => v?.triggers || [])]) { note(t.music); if (t.background?.image) used.add(t.background.image); }
  const out = [];
  for (const file of used) {
    const blob = await assetBlob(file);
    if (!blob) continue;
    const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); });
    out.push({ file, data });
  }
  return out;
}
// A map opened from the installed maps brings its files back into the editor.
async function fetchInstalledAssets(id) {
  for (const a of draft.assets || []) {
    if (await assetBlob(a.file)) continue;
    try {
      const b64 = await window.__TAURI__.core.invoke('read_map_asset', { id, file: a.file });
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await putAsset(a.file, new Blob([bytes]));
    } catch { /* this Recharge build can't read them - the choice stays, the preview won't */ }
  }
}
const assetImages = new Map();
function assetImage(file) {
  let img = assetImages.get(file);
  if (!img) {
    img = new Image();
    assetImages.set(file, img);
    assetBlob(file).then((b) => { if (b) { img.onload = () => { invalidateBase?.(); requestDraw(); }; img.src = URL.createObjectURL(b); } });
  }
  return img;
}
function triggerLabel(t) {
  const k = trigKind(t), d = TRIGGER_KINDS[k] || TRIGGER_KINDS.media;
  if (k === 'media') {
    const parts = [t.music ? '♪ ' + musicLabel(t.music) : '', t.background ? '🖼 ' + (t.background === 'level' ? 'level background' : assetName(t.background.image)) : ''].filter(Boolean);
    return parts.join('  ·  ') || 'TRIGGER (does nothing yet)';
  }
  const extra = GROUP_KINDS.has(k) ? ' "' + (t.group || '?') + '"' + (k === 'move' ? ` by ${t.dx || 0}, ${t.dy || 0}` : '')
    : k === 'zoom' ? ' x' + (t.size || 1) : k === 'message' ? ': ' + (t.text || '') : '';
  return d.label.toUpperCase() + extra + (t.once ? ' (once)' : '');
}
function drawTrigger(t) {
  const a = toScreen(t.x - t.w / 2, t.y + t.h / 2), w = t.w * cam.scale, h = t.h * cam.scale;
  const col = (TRIGGER_KINDS[trigKind(t)] || TRIGGER_KINDS.media).color;
  const picked = !CALM && selection?.kind === 'mtrig' && triggers[selection.index] === t;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col + (picked ? Math.round(18 + 14 * (0.5 + 0.5 * Math.sin(performance.now() / 260))).toString(16).padStart(2, '0') : '12');
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.fillRect(a.x, a.y, w, h);
  ctx.strokeRect(a.x, a.y, w, h);
  if (MARKER_KINDS.has(trigKind(t))) {
    const c = toScreen(t.x, t.y), m = toScreen(t.x + (t.tx || 0), t.y + (t.ty || 0));
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(m.x, m.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(m.x, m.y, Math.max(4, 24 * cam.scale), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  if (cam.scale >= 0.04) drawBadge((TRIGGER_KINDS[trigKind(t)] || TRIGGER_KINDS.media).icon, a.x + 13, a.y + 13, col, cam.scale >= 0.12 ? triggerLabel(t) : '');
}
const triggerAt = (wx, wy) => triggers.findLastIndex((t) => Math.abs(wx - t.x) <= t.w / 2 && Math.abs(wy - t.y) <= t.h / 2);
function triggerJson(t, ox = 0, oy = 0) {
  const k = trigKind(t), o = { type: 'trigger', kind: k, x: Math.round(t.x - ox), y: Math.round(t.y - oy), w: t.w, h: t.h, ...(t.once ? { once: true } : {}) };
  if (k === 'media') Object.assign(o, t.music ? { music: t.music } : {}, t.background ? { background: backgroundJson(t.background === 'level' ? null : t.background) } : {});
  if (GROUP_KINDS.has(k)) o.group = t.group || '';
  if (k === 'move') Object.assign(o, { dx: t.dx || 0, dy: t.dy || 0, time: t.time ?? 1, ...(t.back ? { back: true } : {}) });
  if (MARKER_KINDS.has(k)) Object.assign(o, { tx: Math.round(t.x + (t.tx || 0) - ox), ty: Math.round(t.y + (t.ty || 0) - oy) });
  if (k === 'zoom') o.size = t.size || 1;
  if (k === 'message') Object.assign(o, { text: t.text || '', seconds: t.seconds ?? 3 });
  return o;
}

// ---- groups: ids on placed things and block / spike cells, for triggers to act on ----
function targetCells(t) {
  if (t.kind === 'tile') return [t.key];
  if (t.kind === 'cell' && !t.vine) return [t.k];
  if (t.kind === 'blocks') return t.cells;
  if (t.kind === 'region') return regionContent(t);
  return [];
}
function groupOf(t) {
  if (t.kind === 'base' || t.kind === 'scene') return levelThing(t) ? levelGroups.get(levelKey(t)) || '' : null;
  if (WORLD_KINDS.has(t.kind)) return listOfKind(t.kind)[t.index]?.group || '';
  const cells = targetCells(t);
  return cells.length ? cellGroups.get(cells[0]) || '' : null;
}
function setGroup(targets, g) {
  for (const t of targets) {
    if (WORLD_KINDS.has(t.kind)) { const it = listOfKind(t.kind)[t.index]; if (it) { if (g) it.group = g; else delete it.group; } continue; }
    if (t.kind === 'base' || t.kind === 'scene') { if (g) levelGroups.set(levelKey(t), g); else levelGroups.delete(levelKey(t)); continue; }
    for (const k of targetCells(t)) { if (g) cellGroups.set(k, g); else cellGroups.delete(k); }
  }
}
function groupRow() {
  const ts = targetsOf(selection).filter((t) => groupOf(t) !== null);
  if (!ts.length) return '';
  const gs = [...new Set(ts.map(groupOf))], g = gs.length === 1 ? gs[0] : '';
  const hidden = g && (draft.hiddenGroups || []).includes(g);
  return `<div class="mm-config-row"><label>Group<input class="mm-input" type="text" data-grp="id" value="${g.replace(/"/g, '&quot;')}" placeholder="${gs.length > 1 ? 'several - type to set all' : 'none'}"></label></div>`
    + (g ? `<div class="mm-config-row"><label class="mm-check"><input type="checkbox" data-grp="hidden"${hidden ? ' checked' : ''}> Group "${g}" starts hidden</label></div>` : '');
}
// Everything in a group: placed things and cells, as selection targets.
function groupMembers(g) {
  const out = [];
  for (const kind of WORLD_KINDS) listOfKind(kind).forEach((it, index) => { if (it.group === g) out.push({ kind, index }); });
  for (const [k, v] of levelGroups) if (v === g) out.push(k.startsWith('o:') ? { kind: 'base', id: k.slice(2) } : { kind: 'scene', id: k });
  const cells = [...cellGroups].filter(([k, v]) => v === g && !k.includes('|')).map(([k]) => k);
  for (const [k, v] of cellGroups) if (v === g && k.includes('|')) out.push({ kind: 'tile', key: k });
  return { targets: out, cells };
}

// ---- transform: position, size, turn, flips and opacity, one model for every placed thing ----
const TF_KINDS = {
  object: ['x', 'y', 'rot', 'scale', 'sx', 'flip', 'alpha'],
  csprite: ['x', 'y', 'rot', 'scale', 'sx', 'flip', 'alpha'],
  fspike: ['x', 'y', 'rot', 'scale', 'flip'],
  sign: ['x', 'y', 'rot', 'w', 'alpha'],
  xspawn: ['x', 'y'],
  mtrig: ['x', 'y', 'w'],
};
const LEVEL_TF = ['x', 'y', 'rot', 'scale', 'sx', 'flip'];
function levelThing(t) {
  if (t.kind === 'base') { const o = baseObjects.find((x) => x.id === t.id); return o && !removedObjects.has(o.id) ? o : null; }
  const p = sceneList?.items.find((x) => x.id === t.id);
  return p && !removedScene.has(p.id) ? p : null;
}
function tfFields(t) {
  if (t && (t.kind === 'base' || t.kind === 'scene')) return levelThing(t) ? LEVEL_TF : null;
  const it = t && TF_KINDS[t.kind] && listOfKind(t.kind)?.[t.index];
  if (!it) return null;
  if (t.kind === 'object' && catalogItem(it)?.zip) return ['x', 'y', 'alpha'];
  return TF_KINDS[t.kind];
}
function tfGet(t) {
  if (t.kind === 'base' || t.kind === 'scene') {
    const it = levelThing(t), tf = levelTf.get(levelKey(t)) || {};
    return { x: it.x, y: it.y, rot: tf.rot || 0, scale: tf.scale || 1, sx: tf.sx || 1, sy: tf.sy || 1, fx: !!tf.fx, fy: !!tf.fy };
  }
  const it = listOfKind(t.kind)[t.index];
  if (t.kind === 'object') { const c = it.cfg || {}; return { x: it.x, y: it.y, rot: c.rot || 0, scale: c.scale || 1, sx: c.sx || 1, sy: c.sy || 1, fx: !!c.fx, fy: !!c.fy, alpha: c.alpha ?? 1 }; }
  if (t.kind === 'fspike') return { x: it.x, y: it.y, rot: ((it.q || 0) * 90 + (it.r || 0)) % 360, scale: it.s || 1, fx: !!it.fx, fy: !!it.fy };
  return { x: it.x, y: it.y, rot: it.r || 0, scale: it.scale || 1, sx: it.sx || 1, sy: it.sy || 1, fx: !!it.fx, fy: !!it.fy, alpha: it.alpha ?? 1, w: it.w, h: it.h };
}
const TF_DEFAULT = { rot: 0, scale: 1, sx: 1, sy: 1, alpha: 1, fx: false, fy: false };
function tfSet(t, f, v) {
  const it = listOfKind(t.kind)?.[t.index];
  if (f === 'rot') v = ((Math.round(v * 100) / 100) % 360 + 360) % 360;
  if (f === 'scale' || f === 'sx' || f === 'sy') v = Math.max(0.05, Math.min(20, v));
  if (f === 'alpha') v = Math.max(0.05, Math.min(1, v));
  if (f === 'w' || f === 'h') v = Math.max(8, v);
  const put = (o, k) => { if (v === TF_DEFAULT[f] || v === false) delete o[k]; else o[k] = v; };
  if (t.kind === 'base' || t.kind === 'scene') {
    const it = levelThing(t);
    if (!it) return;
    if (f === 'x' || f === 'y') { moveLevelThing(t, f === 'x' ? v - it.x : 0, f === 'y' ? v - it.y : 0); return; }
    const k = levelKey(t), tf = { ...(levelTf.get(k) || {}) };
    put(tf, f === 'rot' ? 'rot' : f);
    if (Object.keys(tf).length) levelTf.set(k, tf); else levelTf.delete(k);
    applyBaseMoves();
    return;
  }
  if (f === 'x' || f === 'y' || f === 'w' || f === 'h') { it[f] = v; return; }
  if (t.kind === 'object') { const c = { ...(it.cfg || {}) }; put(c, f); it.cfg = c; return; }
  if (t.kind === 'fspike') {
    if (f === 'rot') { it.q = Math.floor(v / 90) % 4; v -= it.q * 90; put(it, 'r'); }
    else put(it, f === 'scale' ? 's' : f);
    return;
  }
  put(it, f === 'rot' ? 'r' : f);
}
function tfTurn(ts, by) {
  pushUndo();
  for (const t of ts) if (tfFields(t)?.includes('rot')) tfSet(t, 'rot', tfGet(t).rot + by);
  saveDraft(); renderConfig(); requestDraw();
}
// What = / - and , . act on: the selection, else the thing under the mouse.
function tfTargets(field) {
  const sel = targetsOf(selection).filter((t) => tfFields(t)?.includes(field));
  if (sel.length) return sel;
  const h = hoverWorld && itemAt(hoverWorld.x, hoverWorld.y);
  return h && tfFields(h)?.includes(field) ? [h] : [];
}
function transformSection() {
  const ts = targetsOf(selection).filter((t) => tfFields(t));
  if (!ts.length) return '';
  const fields = ts.map(tfFields).reduce((a, b) => a.filter((f) => b.includes(f)));
  const v = tfGet(ts[0]), one = ts.length === 1;
  const n = (f, label, val, step, min = '') => `<label>${label}<input class="mm-input" type="number" data-tf="${f}" step="${step}"${min ? ` min="${min}"` : ''} value="${Math.round(val * 1000) / 1000}"></label>`;
  let h = '';
  if (one && fields.includes('x')) h += `<div class="mm-config-row">${n('x', 'X', v.x, 1)}${n('y', 'Y', v.y, 1)}</div>`;
  if (fields.includes('rot')) h += `<div class="mm-config-row mm-tf-row">${n('rot', 'Rotation °', v.rot, 15)}<button class="mm-tool mm-icon" data-tfa="rotL" title="Turn 90° left">⟲</button><button class="mm-tool mm-icon" data-tfa="rotR" title="Turn 90° right">⟳</button></div>`;
  if (fields.includes('scale')) h += `<div class="mm-config-row mm-tf-3">${n('scale', 'Size ×', v.scale, 0.1, 0.05)}${fields.includes('sx') ? n('sx', 'Width ×', v.sx, 0.1, 0.05) + n('sy', 'Height ×', v.sy, 0.1, 0.05) : ''}</div>`;
  if (fields.includes('w')) h += `<div class="mm-config-row">${n('w', 'Width', v.w, 8, 8)}${n('h', 'Height', v.h, 8, 8)}</div>`;
  if (fields.includes('flip') || fields.includes('scale') || fields.includes('rot')) h += `<div class="mm-config-row">${fields.includes('flip') ? `<button class="mm-tool${v.fx ? ' active' : ''}" data-tfa="fx" title="Mirror left-right (F)">↔ Flip</button><button class="mm-tool${v.fy ? ' active' : ''}" data-tfa="fy" title="Mirror top-bottom (Shift+F)">↕ Flip</button>` : ''}<button class="mm-tool" data-tfa="reset" title="Normal size, no turn, no flips">Reset</button></div>`;
  if (fields.includes('alpha')) h += `<div class="mm-config-row"><label>Opacity <output>${Math.round(v.alpha * 100)}%</output><input class="mm-range" type="range" min="0.05" max="1" step="0.05" data-tf="alpha" value="${v.alpha}"></label></div>`;
  return sec('transform', 'Transform', h);
}
function bindTransform(el) {
  el.querySelectorAll('[data-tf]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    const each = (v) => { for (const t of targetsOf(selection)) if (tfFields(t)?.includes(inp.dataset.tf === 'sy' ? 'sx' : inp.dataset.tf === 'h' ? 'w' : inp.dataset.tf)) tfSet(t, inp.dataset.tf, v); };
    if (inp.type === 'range') {
      inp.addEventListener('pointerdown', () => pushUndo());
      inp.addEventListener('input', () => { inp.previousElementSibling.textContent = Math.round(inp.value * 100) + '%'; each(Number(inp.value)); requestDraw(); });
      inp.addEventListener('change', () => { saveDraft(); });
      return;
    }
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      pushUndo(); each(v); saveDraft(); renderConfig(); requestDraw();
    });
  });
  el.querySelectorAll('[data-tfa]').forEach((b) => b.addEventListener('click', () => {
    const ts = targetsOf(selection).filter((t) => tfFields(t)), a = b.dataset.tfa;
    if (a === 'rotL' || a === 'rotR') return tfTurn(ts, a === 'rotL' ? 90 : -90);
    pushUndo();
    for (const t of ts) {
      const f = tfFields(t);
      if (a === 'reset') { for (const k of ['rot', 'scale', 'sx', 'sy', 'fx', 'fy']) if (f.includes(k === 'sy' ? 'sx' : k === 'fx' || k === 'fy' ? 'flip' : k)) tfSet(t, k, TF_DEFAULT[k]); }
      else if (f.includes('flip')) tfSet(t, a, !tfGet(t)[a]);
    }
    saveDraft(); renderConfig(); requestDraw();
  }));
}

// ---- the inspector's sections: collapsible, remembered ----
let secClosed = new Set();
try { secClosed = new Set(JSON.parse(localStorage.getItem('mapMakerClosedSections') || '[]')); } catch { /* private window */ }
function sec(id, title, body, extra = '') {
  if (!body) return '';
  return `<details class="mm-sec" data-sec="${id}"${secClosed.has(id) ? '' : ' open'}><summary>${title}${extra}</summary><div class="mm-sec-body">${body}</div></details>`;
}
function bindSections(el) {
  el.querySelectorAll('details.mm-sec').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) secClosed.delete(d.dataset.sec); else secClosed.add(d.dataset.sec);
    try { localStorage.setItem('mapMakerClosedSections', JSON.stringify([...secClosed])); } catch { /* private window */ }
  }));
}

// ---- your own images, placed like decorations ----
const plantImages = new Map();
function csImage(cs) {
  if (!cs.game) return assetImage(cs.image);
  let img = plantImages.get(cs.game);
  if (!img) { const pl = plantOf(cs); img = new Image(); img.onload = () => requestDraw(); if (pl) img.src = '/maps/plants/' + pl.file; plantImages.set(cs.game, img); }
  return img;
}
function customSpriteSize(cs) {
  const pl = cs.game && plantOf(cs), s = cs.scale || 1;
  if (pl) return { w: pl.w * s * (cs.sx || 1), h: pl.h * s * (cs.sy || 1) };
  const img = assetImage(cs.image);
  return { w: (img.naturalWidth || 64) * s * (cs.sx || 1), h: (img.naturalHeight || 64) * s * (cs.sy || 1) };
}
function customSpriteHit(cs, wx, wy) {
  const b = customSpriteSize(cs);
  return Math.abs(wx - cs.x) <= b.w / 2 && Math.abs(wy - cs.y) <= b.h / 2;
}
function drawCustomSprite(cs) {
  const img = csImage(cs), c = toScreen(cs.x, cs.y), b = customSpriteSize(cs);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(-((cs.r || 0) * Math.PI) / 180);
  ctx.scale(cs.fx ? -1 : 1, cs.fy ? -1 : 1);
  ctx.globalAlpha *= cs.alpha ?? 1;
  if (img.complete && img.naturalWidth) ctx.drawImage(img, (-b.w / 2) * cam.scale, (-b.h / 2) * cam.scale, b.w * cam.scale, b.h * cam.scale);
  else { ctx.strokeStyle = '#8aa0b8'; ctx.setLineDash([4, 3]); ctx.strokeRect((-b.w / 2) * cam.scale, (-b.h / 2) * cam.scale, b.w * cam.scale, b.h * cam.scale); }
  ctx.restore();
}
function customSpriteJson(cs, ox = 0, oy = 0) {
  if (cs.game) return { type: 'gameSprite', sprite: cs.game, x: Math.round(cs.x - ox), y: Math.round(cs.y - oy), scaleX: (cs.scale || 1) * (cs.sx || 1), scaleY: (cs.scale || 1) * (cs.sy || 1), rotation: cs.r || 0, ...(cs.alpha != null && cs.alpha !== 1 ? { alpha: cs.alpha } : {}), ...(cs.fx ? { flipX: true } : {}), ...(cs.fy ? { flipY: true } : {}) };
  return { type: 'customSprite', image: cs.image, x: Math.round(cs.x - ox), y: Math.round(cs.y - oy), scale: cs.scale || 1, scaleX: (cs.scale || 1) * (cs.sx || 1), scaleY: (cs.scale || 1) * (cs.sy || 1), rotation: cs.r || 0, ...(cs.alpha != null && cs.alpha !== 1 ? { alpha: cs.alpha } : {}), ...(cs.fx ? { flipX: true } : {}), ...(cs.fy ? { flipY: true } : {}) };
}

// ---- text: the level's green sign text (the zone 2 statue's), saying anything ----
const SIGN_PATH = 'zone 2/Area1/Lighting objects/CoolStatue/StatuePrestigeText';
const SIGN_COLOR = '#7bb652';
function signTemplate() {
  const texts = sceneList?.texts || [];
  return texts.find((t) => t.t.startsWith('Mossy ground')) || texts.find((t) => t.c === SIGN_COLOR) || null;
}
function signDefaults() {
  const tpl = signTemplate();
  return { w: Math.round(tpl ? tpl.w * tpl.k : 280), h: Math.round(tpl ? tpl.h * tpl.k : 56) };
}
const signBaked = new Map();
function drawSign(sg) {
  const tpl = signTemplate();
  const c = toScreen(sg.x, sg.y), w = sg.w * cam.scale, h = sg.h * cam.scale;
  if (!tpl || !fontsReady()) {
    ctx.save();
    ctx.fillStyle = sg.c || SIGN_COLOR;
    ctx.font = `${Math.max(8, 20 * cam.scale)}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(sg.t, c.x, c.y);
    ctx.restore();
    return;
  }
  const t = { ...tpl, t: sg.t || ' ', w: sg.w / tpl.k, h: sg.h / tpl.k, c: sg.c || tpl.c, r: 0 };
  const k = [t.t, t.w, t.h, t.c].join('|');
  let baked = signBaked.get(k);
  if (baked === undefined) {
    baked = bakeText(t);
    signBaked.set(k, baked);
    if (signBaked.size > 300) signBaked.delete(signBaked.keys().next().value);
  }
  if (!baked) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, c.x, c.y);
  ctx.rotate(-((sg.r || 0) * Math.PI) / 180);
  ctx.scale(cam.scale / baked.px, cam.scale / baked.px);
  ctx.globalAlpha *= sg.alpha ?? 1;
  ctx.drawImage(baked.canvas, baked.x0 * baked.px, -baked.top * baked.px);
  ctx.restore();
  if (selection?.kind === 'sign' && signs[selection.index] === sg) {
    ctx.save();
    ctx.strokeStyle = 'rgba(123, 182, 82, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
    ctx.restore();
  }
}
const signAt = (wx, wy) => signs.findLastIndex((sg) => Math.abs(wx - sg.x) <= sg.w / 2 && Math.abs(wy - sg.y) <= sg.h / 2);
function signJson(sg, ox = 0, oy = 0) {
  const col = (sg.c || SIGN_COLOR).match(/\w\w/g).map((h) => Math.round((parseInt(h, 16) / 255) * 1000) / 1000);
  return { type: 'sign', path: SIGN_PATH, x: Math.round(sg.x - ox), y: Math.round(sg.y - oy), text: sg.t, width: sg.w, height: sg.h, color: col, rotation: sg.r || 0, ...(sg.alpha != null && sg.alpha !== 1 ? { alpha: sg.alpha } : {}) };
}

// A free spike for the game: its tile, turned, and its hitbox in its own units.
function freeSpikeJson(f, ox = 0, oy = 0) {
  const at = { x: Math.round(f.x - ox), y: Math.round(f.y - oy) };
  const turn = (shape, m) => shape.map((poly) => poly.map(([x, y]) => [Math.round((m[0] * x + m[1] * y) * 100) / 100, Math.round((m[2] * x + m[3] * y) * 100) / 100]));
  const E = freeSpikeExtra(f);
  if (f.c === 'true') {
    const d = trueSpikeDef(), t = spikeTile('spike', f.q), col = COLORS.true.match(/\w\w/g).map((h) => Math.round((parseInt(h, 16) / 255) * 1000) / 1000);
    return { type: 'freeSpike', tilemap: t.layer, tileName: t.tile, ...at, matrix: mul2(E, t.matrix), color: col, shape: turn(turn(d.shape, rotMatrix(f.q)), E) };
  }
  const t = spikeTile(f.c, f.q), d = defByTile(t.layer + '|' + t.tile);
  return { type: 'freeSpike', tilemap: t.layer, tileName: t.tile, ...at, matrix: mul2(E, t.matrix), shape: turn(turn(d?.shape || [[[-12, -16], [12, -16], [0, 14]]], t.matrix), E) };
}

const spikeTurn = (sp, cx, cy) => sp.q ?? autoSpikeTurn(cx, cy);

function vineAt(wx, wy) {
  let best = null;
  const consider = (k, sprite, own) => {
    const img = vineImage(sprite);
    const [cx, cy] = unkey(k);
    const w = cellWorld(cx, cy);
    const dx = wx - (w.x + CELL / 2), dy = wy - (w.y + CELL / 2);
    const r = Math.max(img.naturalWidth || 160, img.naturalHeight || 160) / 2;
    const d = Math.hypot(dx, dy);
    if (Math.abs(dx) <= r && Math.abs(dy) <= r && (!best || d < best.d)) best = { k, own, d };
  };
  vines.forEach((v, k) => consider(k, v.s, true));
  if (baseOn()) baseHaz.forEach((h, k) => { if (h.kind === 'vine' && !removedVines.has(k) && !vines.has(k)) consider(k, base.defs[h.d].sprite, false); });
  return best;
}

const LAYER_DEFS = [['level', 'Level (base map)'], ['blocks', 'Blocks & moss'], ['hazards', 'Spikes & vines'], ['tiles', 'Tiles & arrows'], ['objects', 'Objects'], ['decor', 'Decorations'], ['course', 'Course & spawn']];
const layerHidden = (id) => !!draft.layers?.[id]?.hidden;
const layerLocked = (id) => !!draft.layers?.[id]?.locked;
const TOOL_LAYER = { gsprite: 'decor', ...Object.fromEntries(Object.keys(BLOCK_SETS).map((k) => [k, 'blocks'])), block: 'blocks', dark: 'blocks', blue: 'blocks', orange: 'blocks', moss: 'blocks', spike: 'hazards', darkSpike: 'hazards', blueSpike: 'hazards', orangeSpike: 'hazards', trueSpike: 'hazards', vine: 'hazards', tile: 'tiles', stamp: 'tiles', arrow: 'tiles', object: 'objects', decor: 'decor', sign: 'decor', csprite: 'decor', mtrigger: 'course', xspawn: 'course', start: 'course', end: 'course', spawn: 'course', paste: null };
function targetLayer(t) {
  switch (t?.kind) {
    case 'object': return placed[t.index]?.cat === 'decor' ? 'decor' : 'objects';
    case 'gate': return 'course';
    case 'blocks': case 'moss': return 'blocks';
    case 'cell': return t.vine || spikes.has(t.k) ? 'hazards' : 'blocks';
    case 'fspike': return 'hazards';
    case 'sign': return 'decor';
    case 'csprite': case 'gsprite': return 'decor';
    case 'mtrig': case 'xspawn': return 'course';
    case 'tile': return 'tiles';
    case 'base': case 'basecells': case 'scene': case 'decotiles': return 'level';
    default: return null;
  }
}
const layerOpen = (id) => !id || (!layerHidden(id) && !layerLocked(id));
function renderLayersPanel() {
  const el = root?.querySelector('#mm-layers');
  if (!el || el.hidden) return;
  el.innerHTML = `<div class="mm-config-title">Layers<span>show · lock</span></div>` + LAYER_DEFS.map(([id, label]) =>
    `<div class="mm-layer-row"><span>${label}</span><label class="mm-check" title="Show"><input type="checkbox" data-layer="${id}" data-f="shown"${layerHidden(id) ? '' : ' checked'}> 👁</label><label class="mm-check" title="Lock: can't be selected, painted or erased"><input type="checkbox" data-layer="${id}" data-f="locked"${layerLocked(id) ? ' checked' : ''}> 🔒</label></div>`).join('')
    + `<div class="mm-config-sub">Hidden layers aren't drawn; locked ones can't be selected, painted or erased. Export always includes everything.</div>`;
  el.querySelectorAll('[data-layer]').forEach((inp) => inp.addEventListener('change', () => {
    const id = inp.dataset.layer, cur = { ...(draft.layers?.[id] || {}) };
    if (inp.dataset.f === 'shown') cur.hidden = !inp.checked; else cur.locked = inp.checked;
    draft.layers = { ...(draft.layers || {}), [id]: cur };
    if (selection && !layerOpen(targetLayer(selection))) { selection = null; renderConfig(); }
    saveDraft();
    artCache.clear();
    invalidateBase();
    requestDraw();
  }));
}
const KEY_GUIDE = [
  ['Placing', [
    ['B / S / O / D / C', 'Blocks, hazards, objects, decor, course - again to step (Shift back)'],
    ['Group (in the dropdown)', 'Give the selection a group id - group triggers show, hide, toggle or move it'],
    ['1-9, [ ]', 'Pick / step through the current dropdown ([ ] when nothing layered is selected)'],
    ['A', 'Guide arrow (drag a path)'],
    ['R / Shift+R', 'Turn what you place (spikes: fixed direction)'],
    ['F', 'Mirror what you place'],
    ['Alt+click, I', 'Pick up the thing under the cursor'],
  ]],
  ['Selecting', [
    ['Q', 'Select tool'],
    ['Click', 'Select one thing (it opens in its dropdown)'],
    ['Shift+click', 'Add or remove a thing - any kind, mixed'],
    ['Drag empty space', 'Box-select everything inside, each outlined (Shift: add to the selection)'],
    ['Drag the selection', 'Move all of it, with any tool - what it passes over is kept'],
    ['E', 'Erase'],
    ['Delete', 'Delete the selection'],
    ['Esc', 'Deselect / close, then leave fullscreen'],
    ['Ctrl+C / Ctrl+V, V', 'Copy the selection / paste it at the mouse'],
    ['] / [', 'Move the selected things up / down one layer (past the level: behind it)'],
    ['Shift+] / Shift+[', 'Bring them to the front / send them behind everything, the level included'],
    ['Ctrl+S', 'Save to your installed maps'],
    ['Ctrl+D', 'Duplicate the selection'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo (Ctrl+Shift+Z too)'],
  ]],
  ['Transforming', [
    ['Arrows', 'Move the selection (Snap step; Shift: 1 unit) - nothing selected: pan'],
    ['R / Shift+R', 'Turn 90° (a region turns as a whole)'],
    [', / .', 'Turn 15° (Shift: 1°)'],
    ['F / Shift+F', 'Flip left-right / top-bottom'],
    ['= / -', 'Scale up / down'],
    ['Drag', 'Move the selection (Shift: free)'],
  ]],
  ['View', [
    ['Wheel', 'Zoom'],
    ['Right-drag, Space-drag', 'Pan'],
    ['0', 'Zoom to 100%'],
    ['Home', 'Jump to the spawn / course start'],
    ['G', 'Grid on / off'],
    ['T', 'Simulate zip movers'],
    ['B', 'Build a selected zip mover\'s platform from grate tiles'],
    ['H', 'Hitboxes'],
    ['L / P / M / K', 'Layers / Level settings / Map / this guide'],
  ]],
];
function renderKeysPanel() {
  const el = root?.querySelector('#mm-keys');
  if (!el || el.hidden) return;
  el.innerHTML = `<div class="mm-config-title">Keys<span>K or ? to close</span></div>` + KEY_GUIDE.map(([title, rows]) =>
    `<div class="mm-keys-group">${title}</div>` + rows.map(([k, what]) => `<div class="mm-keys-row"><kbd>${k}</kbd><span>${what}</span></div>`).join('')).join('');
}

function duplicateSelection() {
  const sel = selection;
  if (!sel) { flash('Select something to duplicate (Ctrl+D).'); return; }
  if (sel.kind === 'multi') {
    const clip = copyMany(sel.items);
    if (!clip) { flash('Nothing in the selection can be duplicated.', true); return; }
    pushUndo();
    pasteMany(clip.many, { cx: clip.anchor.cx + 1, cy: clip.anchor.cy - 1 });
    saveDraft(); renderConfig(); requestDraw();
    return;
  }
  pushUndo();
  if (sel.kind === 'object') {
    const o = placed[sel.index], copy = { ...JSON.parse(JSON.stringify(o)), x: o.x + CELL, y: o.y - CELL };
    if (copy.uid) copy.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    placed.push(copy);
    selection = { kind: 'object', index: placed.length - 1 };
  } else if (sel.kind === 'region') {
    copySelection();
    if (brush) { pasteBrush(sel.x1 + 1, sel.y0); selection = { kind: 'region', x0: sel.x1 + 1, y0: sel.y0, x1: sel.x1 + 1 + (sel.x1 - sel.x0), y1: sel.y1 }; setTool('select'); }
  } else if (sel.kind === 'blocks') {
    const w = Math.max(...sel.cells.map((k) => unkey(k)[0])) - Math.min(...sel.cells.map((k) => unkey(k)[0])) + 1;
    const cells = sel.cells.map((k) => { const [x, y] = unkey(k), nk = key(x + w, y); blocks.set(nk, blocks.get(k)); return nk; });
    selection = { ...sel, cells };
  } else { flash('That can\'t be duplicated.'); return; }
  saveDraft(); renderConfig(); requestDraw();
}

function paletteSpotFor(t) {
  if (!t) return null;
  const find = (cat, pred) => { const i = categoryItems(cat).findIndex(pred); return i >= 0 ? [cat, i] : null; };
  if (t.kind === 'object') {
    const o = placed[t.index];
    if (!o) return null;
    if (o.cat === 'decor') return find('decor', (it) => it.tool === 'decor' && it.i === o.i);
    return find('objects', (it) => it.tool === 'object' && it.i === o.i) || find('gates', (it) => it.tool === 'object' && it.i === o.i);
  }
  if (t.kind === 'blocks') { const kind = blocks.get(t.cells[0]); return find('blocks', (it) => it.tool === Object.keys(BLOCK_KIND).find((k) => BLOCK_KIND[k] === kind)); }
  if (t.kind === 'moss') return find('blocks', (it) => it.tool === 'moss');
  if (t.kind === 'cell' && t.vine) { const v = vines.get(t.k); return v && find('hazards', (it) => it.vine === v.s); }
  if (t.kind === 'cell') { const sp = spikes.get(t.k); return sp && find('hazards', (it) => SPIKE_KIND[it.tool] === sp.c); }
  if (t.kind === 'gate') return find('gates', (it) => it.tool === t.which);
  return null;
}
function showInDropdown(t) {
  const spot = paletteSpotFor(t);
  if (!spot) return;
  const [cat, i] = spot;
  draft.pick[cat] = i;
  const btn = root.querySelector(`[data-cat="${cat}"]`);
  setTimeout(() => { if (popCat !== cat) openPopover(cat, btn); else renderPopover(''); }, 0);
}
function replaceSelectionWith(it) {
  const t = selection;
  if (!t) return false;
  if (t.kind === 'object' && (it.tool === 'object' || it.tool === 'decor')) {
    pushUndo();
    const o = placed[t.index], item = base.catalog[it.tool === 'decor' ? 'decor' : 'objects'][it.i];
    o.cat = it.tool === 'decor' ? 'decor' : 'objects'; o.i = it.i; o.n = item?.name;
    if (item?.upgradeBox && !o.uid) o.uid = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } else if (t.kind === 'blocks' && BLOCK_KIND[it.tool]) {
    pushUndo();
    for (const k of t.cells) blocks.set(k, BLOCK_KIND[it.tool]);
    selection = { ...t, what: blockName(BLOCK_KIND[it.tool]) };
  } else if (t.kind === 'cell' && !t.vine && SPIKE_KIND[it.tool] && spikes.has(t.k)) {
    pushUndo();
    spikes.set(t.k, { ...spikes.get(t.k), c: SPIKE_KIND[it.tool] });
  } else if (t.kind === 'cell' && t.vine && it.vine) {
    pushUndo();
    vines.set(t.k, { ...vines.get(t.k), s: it.vine });
  } else return false;
  saveDraft(); renderConfig(); requestDraw();
  flash('Swapped for ' + it.label);
  return true;
}

function syncChrome() {
  if (!root) return;
  const snapSel = root.querySelector('#mm-snap');
  if (snapSel) snapSel.value = String(draft.snap || CELL);
  root.classList.toggle('mm-full', !draft.inline);
  const full = root.querySelector('#mm-full-btn');
  if (full) { full.innerHTML = icon(draft.inline ? 'expand' : 'shrink'); full.classList.add('mm-icon'); full.title = draft.inline ? 'Fullscreen editor' : 'Back to the page (Esc)'; }
  root.querySelector('#mm-sim-btn')?.classList.toggle('active', !!draft.simulate);
  requestAnimationFrame(() => resize());
}

function togglePanel(id) {
  for (const other of ['mm-player', 'mm-layers', 'mm-file', 'mm-keys']) {
    const el = root.querySelector('#' + other), btn = root.querySelector('#' + other + '-btn');
    const open = other === id ? el.hidden : false;
    el.hidden = !open;
    btn?.classList.toggle('active', open);
  }
  renderPlayerPanel();
  renderLayersPanel();
  renderKeysPanel();
}

const snapV = () => draft.snap || CELL;
const snapPoint = (p, s = snapV()) => ({ x: Math.round(p.x / s) * s, y: Math.round((p.y - OFFSET_Y) / s) * s + OFFSET_Y });
function fineRotate(dir, fine) {
  const ts = tfTargets('rot');
  if (!ts.length) { flash('Select something to turn it finely (, and . - Shift for 1°).'); return; }
  tfTurn(ts, dir * (fine ? 1 : 15));
}
function scaleSelection(dir) {
  const ts = tfTargets('scale');
  if (!ts.length) { flash('Select something to size it (= and -).'); return; }
  pushUndo();
  for (const t of ts) tfSet(t, 'scale', Math.round((tfGet(t).scale + dir * 0.1) * 10) / 10);
  saveDraft(); renderConfig(); requestDraw();
}
function flipYSelection() {
  const t = selection || (hoverWorld && itemAt(hoverWorld.x, hoverWorld.y));
  if (t?.kind === 'region') return transformRegion('y');
  pushUndo();
  if (t?.kind === 'object') { const o = placed[t.index]; o.cfg = { ...o.cfg, fy: !o.cfg?.fy }; }
  else if (t?.kind === 'tile') { const tl = tiles.get(t.key); tiles.set(t.key, { ...tl, m: undefined, fy: !tl.fy }); }
  else return;
  saveDraft(); renderConfig(); requestDraw();
}
function transformRegion(mode) {
  const sel = selection?.kind === 'multi' ? selection.items.find((t) => t.kind === 'region') : selection;
  if (!sel || sel.kind !== 'region') return;
  pushUndo();
  const { x0, y0, x1, y1 } = sel, inR = (cx, cy) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const mapCell = (x, y) => (mode === 'x' ? [x0 + x1 - x, y] : mode === 'y' ? [x, y0 + y1 - y] : [Math.round(mx - (y - my)), Math.round(my + (x - mx))]);
  const M = mode === 'x' ? [-1, 0, 0, 1] : mode === 'y' ? [1, 0, 0, -1] : [0, -1, 1, 0];
  const mapQ = (q) => (q == null ? q : mode === 'x' ? [0, 3, 2, 1][q] : mode === 'y' ? [2, 1, 0, 3][q] : (q + 1) % 4);
  for (const m of [blocks, spikes, vines]) {
    const moving = [...m].filter(([k]) => inR(...unkey(k)));
    for (const [k] of moving) m.delete(k);
    for (const [k, v] of moving) {
      const [x, y] = mapCell(...unkey(k));
      m.set(key(x, y), m === spikes ? { ...v, q: mapQ(v.q) } : m === vines ? { ...v, q: mode === 'r' ? (v.q + 1) % 4 : v.q } : v);
    }
  }
  const movingT = [];
  for (const [k, t] of tiles) {
    const c = tileCenter(t.layer, k), cc = cellOf(c.x, c.y);
    if (inR(cc.cx, cc.cy) && !t.arrow && layerGrid(t.layer).size === CELL) movingT.push([k, t, cc]);
  }
  for (const [k] of movingT) tiles.delete(k);
  for (const [, t, cc] of movingT) {
    const [x, y] = mapCell(cc.cx, cc.cy), w = cellWorld(x, y);
    tiles.set(tileKeyAt(t.layer, w.x + CELL / 2, w.y + CELL / 2), { ...t, m: mul2(M, tileMatrix(t)), q: undefined, fx: undefined, fy: undefined });
  }
  const a = cellWorld(x0, y0), b = cellWorld(x1 + 1, y1 + 1), cxW = (a.x + b.x) / 2, cyW = (a.y + b.y) / 2;
  for (const o of placed) {
    const c = cellOf(o.x, o.y);
    if (!inR(c.cx, c.cy)) continue;
    const dx = o.x - cxW, dy = o.y - cyW, cfg = { ...(o.cfg || {}) }, item = catalogItem(o);
    if (mode === 'x') o.x = Math.round(cxW - dx); else if (mode === 'y') o.y = Math.round(cyW - dy); else { o.x = Math.round(cxW - dy); o.y = Math.round(cyW + dx); }
    if (item?.zip) {
      const [ex, ey] = zipConfig(o, item).end;
      cfg.zip = { ...cfg.zip, end: mode === 'x' ? [-ex, ey] : mode === 'y' ? [ex, -ey] : [-ey, ex] };
    } else if (mode === 'r') cfg.rot = ((cfg.rot || 0) + 90) % 360;
    else { cfg[mode === 'x' ? 'fx' : 'fy'] = !cfg[mode === 'x' ? 'fx' : 'fy']; if (cfg.rot) cfg.rot = (360 - cfg.rot) % 360; }
    o.cfg = cfg;
  }
  if (mode === 'r') {
    const [ax, ay] = mapCell(x0, y0), [bx, by] = mapCell(x1, y1);
    Object.assign(sel, { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) });
  }
  saveDraft(); renderConfig(); requestDraw();
}

const COURSE_COLORS = ['#41f88d', '#4fc3ff', '#ffb347', '#ff6fd8', '#c792ea', '#f5e663', '#7ee0c3', '#ff8a80'];
const courses = () => (draft.courses ||= []);
const courseById = (id) => courses().find((c) => c.id === id);
const courseNumber = (id) => courses().findIndex((c) => c.id === id) + 1;
const courseColor = (id) => COURSE_COLORS[Math.max(0, courseNumber(id) - 1) % COURSE_COLORS.length];
const completeCourses = () => courses().filter((c) => c.start && c.end);
const levelCourseN = (id) => (typeof id === 'string' && id.startsWith('level:') ? Number(id.slice(6)) : 0);
const levelCourse = (id) => { const n = levelCourseN(id); return n && baseOn() ? base.courses[n - 1] : null; };
const isLinked = (id) => !!(courseById(id) || levelCourse(id));
const linkLabel = (id) => (courseById(id) ? 'Course ' + courseNumber(id) : levelCourseN(id) ? 'Level course ' + levelCourseN(id) : '');
const linkColor = (id) => (courseById(id) ? courseColor(id) : '#e8d85a');
const isTeleporter = (item) => item?.name === 'Teleporter';
function teleporterTargets(o) {
  const own = placed.filter((x) => x !== o && isTeleporter(catalogItem(x)) && x.uid).map((x) => ['p:' + x.uid, 'Teleporter ' + (placed.filter((y) => isTeleporter(catalogItem(y))).indexOf(x) + 1)]);
  const level = baseOn() ? baseObjects.filter((b) => b.kind === 'teleporter' && !removedObjects.has(b.id)).map((b, i) => ['l:' + b.id, 'Level teleporter ' + (i + 1) + ' (' + b.path.split('/').slice(-2).join(' ') + ')']) : [];
  return [...own, ...level];
}
function teleportTarget(ref) {
  if (!ref) return null;
  if (ref.startsWith('p:')) { const t = placed.find((x) => x.uid === ref.slice(2)); return t ? { x: t.x, y: t.y, uid: t.uid } : null; }
  const b = baseObjects.find((x) => x.id === ref.slice(2) && !removedObjects.has(x.id));
  return b ? { x: b.x, y: b.y, path: b.path } : null;
}
function applyTeleport(dir, ref) {
  const o = placed[selection.index];
  pushUndo();
  const other = dir === 'up' ? 'down' : 'up';
  const old = o.tp?.[dir];
  o.tp = { ...(o.tp || {}), [dir]: ref || null };
  if (old && old.startsWith('p:')) { const t = placed.find((x) => x.uid === old.slice(2)); if (t?.tp?.[other] === 'p:' + o.uid) t.tp = { ...t.tp, [other]: null }; }
  if (ref && ref.startsWith('p:')) { const t = placed.find((x) => x.uid === ref.slice(2)); if (t) t.tp = { ...(t.tp || {}), [other]: 'p:' + o.uid }; }
  saveDraft(); renderConfig(); requestDraw();
}
function drawTeleportLinks() {
  ctx.save();
  ctx.strokeStyle = '#b48cff';
  ctx.fillStyle = '#b48cff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  for (const o of placed) {
    if (!o.tp || !isTeleporter(catalogItem(o))) continue;
    for (const dir of ['up', 'down']) {
      const t = teleportTarget(o.tp[dir]);
      if (!t) continue;
      const a = toScreen(o.x, o.y), b = toScreen(t.x, t.y);
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(dir === 'up' ? '▲' : '▼', a.x + (b.x - a.x) * 0.15, a.y + (b.y - a.y) * 0.15);
    }
  }
  ctx.restore();
}
const isCourseCheckpoint = (item) => item?.name === 'Course checkpoint';
const isCheckpoint = (item) => item?.name === 'Checkpoint' || isCourseCheckpoint(item);
const isLongFall = (item) => /^Long fall/.test(item?.name || '');
// Things that are a trigger box: the box is what matters, so it can be sized.
const isSizable = (item) => isCheckpoint(item) || isLongFall(item);
// A checkpoint's trigger: its own size when the map sets one, else the copied checkpoint's.
function objectBox(o, item = catalogItem(o)) {
  const t = o.cfg?.trig;
  if (t && isSizable(item)) return [t.dx - t.w / 2, t.dy - t.h / 2, t.dx + t.w / 2, t.dy + t.h / 2];
  return item?.box || null;
}
function trigOf(o, item) {
  const b = objectBox(o, item) || [-50, -50, 50, 50];
  return { w: b[2] - b[0], h: b[3] - b[1], dx: (b[0] + b[2]) / 2, dy: (b[1] + b[3]) / 2 };
}
const LINKABLE = (item) => !!(item?.upgradeBox || isCourseCheckpoint(item));
function newCourse() {
  const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), start: null, end: null, reward: { currency: 'Cash', amount: 0 } };
  courses().push(c);
  draft.activeCourse = c.id;
  return c;
}
function migrateGates() {
  if (draft.start || draft.end) courses().unshift({ id: 'c1', start: draft.start || null, end: draft.end || null, reward: { currency: 'Cash', amount: 0 } });
  draft.start = draft.end = null;
}
function pruneCourses() {
  draft.courses = courses().filter((c) => c.start || c.end);
  for (const o of placed) if (o.course && !levelCourseN(o.course) && !courseById(o.course)) delete o.course;
  if (!courseById(draft.activeCourse)) draft.activeCourse = courses().at(-1)?.id || null;
}
function courseJson(c, ox = 0, oy = 0) {
  const r = Math.round;
  const screen = courseScreen(c);
  return { id: c.id, startX: r(c.start.x - ox), startY: r(c.start.y - oy), endX: r(c.end.x - ox), endY: r(c.end.y - oy), screenX: r(screen.x - ox), screenY: r(screen.y - oy), reward: c.reward || { currency: 'Cash', amount: 0 } };
}
function clearMarker(m) {
  if (m.which === 'spawn') { draft.spawn = null; return; }
  if (m.which === 'screen') { const c = courseById(m.course); if (c) delete c.screen; return; }
  const c = courseById(m.course);
  if (c) c[m.which] = null;
  pruneCourses();
}
function drawCourses() {
  const centre = (g, b) => toScreen(g.x + b.dx, g.y + b.dy);
  ctx.save();
  for (const c of courses()) {
    const n = courseNumber(c.id), col = courseColor(c.id);
    if (c.start && c.end) {
      const a = centre(c.start, START_BOX), b = centre(c.end, END_BOX);
      ctx.strokeStyle = col; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (c.start) drawGate(c.start, START_BOX, col, 'START ' + n);
    if (c.end) drawGate(c.end, END_BOX, col, 'END ' + n);
  }
  for (const o of placed) {
    const c = o.course && (courseById(o.course) || levelCourse(o.course)), g = c && (c.start || c.end);
    if (!g) continue;
    const a = toScreen(o.x, o.y), b = centre(g, c.start ? START_BOX : END_BOX);
    ctx.strokeStyle = linkColor(o.course); ctx.globalAlpha = 0.4; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
  if (draft.spawn) drawGate(draft.spawn, SPAWN_BOX, COLORS.spawn, 'SPAWN');
  xspawns.forEach((s, i) => drawGate(s, SPAWN_BOX, COLORS.spawn, 'SPAWN ' + (i + 2)));
}

function gateAt(cx, cy, kind) {
  if (kind === 'spawn') for (let n = 0; n < 200 && isSolid(cx, cy); n++) cy++;
  const w = cellWorld(cx, cy);
  return { x: w.x + CELL / 2, y: w.y + { start: START_LIFT, end: END_LIFT, spawn: SPAWN_LIFT }[kind] };
}

function viewSpawn() {
  const c = cellOf(cam.x, cam.y);
  return gateAt(c.cx, c.cy, 'spawn');
}

// Where a finished course's screen goes: where it was put, or just left of its start gate.
function courseScreen(c) {
  if (!c?.start || !c?.end) return null;
  if (c.screen) return c.screen;
  const b = screenBox();
  return { x: Math.round(c.start.x - START_BOX.w / 2 - 40 - b.w / 2 - b.dx), y: Math.round(c.start.y + 20) };
}
function markerPos(t) {
  if (t.which === 'spawn') return draft.spawn;
  const c = courseById(t.course);
  return t.which === 'screen' ? courseScreen(c) : c?.[t.which];
}
const MARKER_BOX = { spawn: SPAWN_BOX, start: START_BOX, end: END_BOX, get screen() { return screenBox(); } };
const screenBox = () => SCREEN_BOX;

// The game's own board image (the course Canvas's "Screen" Image, Screen_0),
// stretched the way the game's UI stretches it: 9-sliced, 30px borders at 120
// pixels per unit on a 100-unit canvas scaled 1.1 x 1.15.
const BOARD_SLICE = 30, BOARD_EDGE = [(30 / 1.2) * 1.1, (30 / 1.2) * 1.15];
let boardImg = null;
function drawBoardSprite(x, y, w, h) {
  if (!boardImg) { boardImg = new Image(); boardImg.onload = requestDraw; boardImg.src = '/maps/course-screen.png'; }
  if (!boardImg.complete || !boardImg.naturalWidth) return;
  const iw = boardImg.naturalWidth, ih = boardImg.naturalHeight, b = BOARD_SLICE;
  const ex = Math.min(BOARD_EDGE[0] * cam.scale, w / 2), ey = Math.min(BOARD_EDGE[1] * cam.scale, h / 2);
  const sx = [0, b, iw - b, iw], sy = [0, b, ih - b, ih];
  const dx = [x, x + ex, x + w - ex, x + w], dy = [y, y + ey, y + h - ey, y + h];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (dx[i + 1] - dx[i] <= 0 || dy[j + 1] - dy[j] <= 0) continue;
    ctx.drawImage(boardImg, sx[i], sy[j], sx[i + 1] - sx[i], sy[j + 1] - sy[j], dx[i], dy[j], dx[i + 1] - dx[i], dy[j + 1] - dy[j]);
  }
}

// The level's course 1 screen texts, around their centre, as the preview.
let screenArt;
function courseScreenArt() {
  if (!sceneList) return null;
  if (screenArt !== undefined && screenArt?.list === sceneList) return screenArt?.art ?? null;
  screenArt = { list: sceneList, art: null };
  const panel = (sceneList?.items || []).find((p) => (p.p || '').endsWith('course 1/DisableBits/background geometry/entry backround'));
  if (!panel) return null;
  const texts = (sceneList.texts || []).filter((t) => Math.abs(t.x - panel.x) < 300 && Math.abs(t.y - panel.y) < 350);
  const board = texts.filter((t) => !/^[A-Z]+$/.test(t.t));
  if (!board.length) return null;
  const ref = { x: board.reduce((a, t) => a + t.x, 0) / board.length, y: board.reduce((a, t) => a + t.y, 0) / board.length };
  screenArt.art = { panel, ref, texts: board };
  return screenArt.art;
}
function drawCourseScreen(c, col, n) {
  const at = courseScreen(c);
  if (!at) return;
  const art = courseScreenArt(), b = screenBox();
  const a = toScreen(at.x + b.dx - b.w / 2, at.y + b.dy + b.h / 2), w = b.w * cam.scale, h = b.h * cam.scale;
  ctx.save();
  drawBoardSprite(a.x, a.y, w, h);
  if (cam.scale >= 0.12) {
    ctx.fillStyle = col;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('COURSE ' + n + ' SCREEN', a.x + w / 2, a.y - 4);
  }
  ctx.restore();
  if (art) {
    ctx.save();
    for (const t of art.texts) {
      let baked = textCache.get(t);
      if (baked === undefined) { baked = bakeText(t); textCache.set(t, baked); }
      if (!baked) continue;
      const p = toScreen(at.x + t.x - art.ref.x, at.y + t.y - art.ref.y);
      ctx.setTransform(1, 0, 0, 1, p.x, p.y);
      ctx.rotate(-t.r);
      ctx.scale(cam.scale / baked.px, cam.scale / baked.px);
      ctx.drawImage(baked.canvas, baked.x0 * baked.px, -baked.top * baked.px);
    }
    ctx.restore();
  }
}

function markerAt(wx, wy) {
  const hit = (g, b) => g && Math.abs(wx - (g.x + b.dx)) <= Math.max(b.w / 2, CELL / 2) && Math.abs(wy - (g.y + b.dy)) <= Math.max(b.h / 2, CELL / 2);
  if (hit(draft.spawn, SPAWN_BOX)) return { which: 'spawn' };
  for (const c of courses()) {
    if (hit(c.start, START_BOX)) return { which: 'start', course: c.id };
    if (hit(c.end, END_BOX)) return { which: 'end', course: c.id };
  }
  for (const c of courses()) if (hit(courseScreen(c), screenBox())) return { which: 'screen', course: c.id };
  return null;
}

function applyTool(cx, cy) {
  const k = key(cx, cy);
  if (tool !== 'erase' && TOOL_LAYER[tool] && layerLocked(TOOL_LAYER[tool])) { flash('That layer is locked (Layers).', true); return false; }
  if (tool === 'erase') {
    const w0 = cellWorld(cx, cy), t = itemAtAny(w0.x + CELL / 2, w0.y + CELL / 2);
    if (t && !layerOpen(targetLayer(t))) return false;
  }
  if (BLOCK_KIND[tool]) {
    if (blocks.get(k) === BLOCK_KIND[tool]) return false;
    spikes.delete(k);
    blocks.set(k, BLOCK_KIND[tool]);
  } else if (tool === 'mtrigger') {
    if (drag?.trigPlaced) return false;
    const p = snapPoint(hoverWorld || { x: cellWorld(cx, cy).x + CELL / 2, y: cellWorld(cx, cy).y + CELL / 2 });
    triggers.push(newTrigger(draft.pick.trigKind || 'media', p.x, p.y));
    selection = { kind: 'mtrig', index: triggers.length - 1 };
    if (drag) drag.trigPlaced = true;
    setTimeout(() => { setTool('select'); renderConfig(); });
  } else if (tool === 'xspawn') {
    if (drag?.xspawnPlaced) return false;
    const w0 = cellWorld(cx, cy);
    xspawns.push({ x: w0.x + CELL / 2, y: w0.y + CELL / 2 });
    selection = { kind: 'xspawn', index: xspawns.length - 1 };
    if (drag) drag.xspawnPlaced = true;
    setTimeout(() => { setTool('select'); renderConfig(); });
  } else if (tool === 'gsprite') {
    if (drag?.cspritePlaced || !draft.pick.gsprite) return false;
    const p = snapPoint(hoverWorld || { x: cellWorld(cx, cy).x + CELL / 2, y: cellWorld(cx, cy).y + CELL / 2 });
    csprites.push({ x: p.x, y: p.y, game: draft.pick.gsprite, scale: 1 });
    selection = { kind: 'csprite', index: csprites.length - 1 };
    if (drag) drag.cspritePlaced = true;
    setTimeout(() => renderConfig());
  } else if (tool === 'csprite') {
    if (drag?.cspritePlaced || !draft.pick.csprite) return false;
    const p = snapPoint(hoverWorld || { x: cellWorld(cx, cy).x + CELL / 2, y: cellWorld(cx, cy).y + CELL / 2 });
    csprites.push({ x: p.x, y: p.y, image: draft.pick.csprite, scale: 1 });
    selection = { kind: 'csprite', index: csprites.length - 1 };
    if (drag) drag.cspritePlaced = true;
    setTimeout(() => renderConfig());
  } else if (tool === 'sign') {
    if (drag?.signPlaced) return false;
    const p = snapPoint(hoverWorld || { x: cellWorld(cx, cy).x + CELL / 2, y: cellWorld(cx, cy).y + CELL / 2 });
    signs.push({ x: p.x, y: p.y, t: 'Text', ...signDefaults() });
    selection = { kind: 'sign', index: signs.length - 1 };
    if (drag) drag.signPlaced = true;
    setTimeout(() => { setTool('select'); renderConfig(); root.querySelector('[data-sign="t"]')?.select(); });
  } else if (SPIKE_KIND[tool]) {
    if (snapV() < CELL && hoverWorld) return placeFreeSpike(SPIKE_KIND[tool], hoverWorld);
    if (spikes.get(k)?.c === SPIKE_KIND[tool]) return false;
    blocks.delete(k);
    spikes.set(k, spikePlaceTurn === null ? { c: SPIKE_KIND[tool] } : { c: SPIKE_KIND[tool], q: spikePlaceTurn });
  } else if (tool === 'vine') {
    if (!base || vines.get(k)?.s === draft.vineSprite) return false;
    vines.set(k, { s: draft.vineSprite, q: placeRot });
  } else if (tool === 'moss') {
    const w = cellWorld(cx, cy), mk = mossKeyAt(w.x + CELL / 2, w.y + CELL / 2);
    if (mossCells.has(mk)) return false;
    mossCells.set(mk, true);
  } else if (tool === 'tile') {
    const pk = draft.pick;
    if (!base || !pk.tile) return false;
    const w = cellWorld(cx, cy), tk = tileKeyAt(pk.tileLayer, w.x + CELL / 2, w.y + CELL / 2);
    if (tiles.get(tk)?.tile === pk.tile) return false;
    tiles.set(tk, { layer: pk.tileLayer, tile: pk.tile, q: 0 });
  } else if (tool === 'object' || tool === 'decor') {
    if (drag?.placedObject) return false;
    const cat = tool === 'object' ? 'objects' : 'decor', i = tool === 'object' ? draft.pick.obj ?? 0 : draft.pick.decorObj ?? 0;
    if (!catalogItem({ cat, i })) return false;
    const item = catalogItem({ cat, i });
    placed.push({ cat, i, n: item.name, ...placementFor(item, cx, cy), ...(item.upgradeBox || isTeleporter(item) ? { uid: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) } : {}), ...(item.name === 'Course checkpoint' && courseById(draft.activeCourse) ? { course: draft.activeCourse } : {}) });
    if (drag) { drag.placedObject = true; if (item.zip) drag.zipPlace = placed.length - 1; }
  } else if (tool === 'stamp') {
    if (drag?.placedObject || !allStamps()[draft.pick.stamp]) return false;
    const w = cellWorld(cx, cy);
    for (const [tk, t] of stampTiles(allStamps()[draft.pick.stamp], w.x + CELL / 2, w.y + CELL / 2, placeRot, placeFlip)) tiles.set(tk, t);
    if (drag) drag.placedObject = true;
  } else if (tool === 'paste') {
    if (drag?.placedObject || !brush) return false;
    pasteBrush(cx, cy);
    if (drag) drag.placedObject = true;
  } else if (tool === 'erase') {
    if (blocks.delete(k) || spikes.delete(k)) return true;
    {
      const w = cellWorld(cx, cy), px = w.x + CELL / 2, py = w.y + CELL / 2;
      const oi = placed.findLastIndex((o) => objectHit(o, px, py));
      if (oi >= 0) { placed.splice(oi, 1); return true; }
      const fi = freeSpikeAt(hoverWorld?.x ?? px, hoverWorld?.y ?? py);
      if (fi >= 0) { freeSpikes.splice(fi, 1); return true; }
      const si = signAt(hoverWorld?.x ?? px, hoverWorld?.y ?? py);
      if (si >= 0) { signs.splice(si, 1); return true; }
      const ci = csprites.findLastIndex((c) => customSpriteHit(c, hoverWorld?.x ?? px, hoverWorld?.y ?? py));
      if (ci >= 0) { csprites.splice(ci, 1); return true; }
      const ti = triggerAt(hoverWorld?.x ?? px, hoverWorld?.y ?? py);
      if (ti >= 0) { triggers.splice(ti, 1); return true; }
      const t = tileAt(px, py);
      if (t) { if (t[1].arrow) removeArrow(t[1].arrow); else tiles.delete(t[0]); return true; }
      if (mossCells.delete(mossKeyAt(px, py))) return true;
    }
    const isBase = baseOn() && (groundSet.has(k) || mossSet.has(k) || blueSet.has(k) || orangeSet.has(k) || (baseHaz.get(k) && baseHaz.get(k).kind !== 'vine'));
    if (isBase && !removed.has(k)) { removed.add(k); return true; }
    const w = cellWorld(cx, cy);
    const marker = markerAt(w.x + CELL / 2, w.y + CELL / 2);
    if (marker) { clearMarker(marker); return true; }
    const obj = baseOn() && baseObjects.find((o) => !removedObjects.has(o.id) && Math.abs(w.x + CELL / 2 - o.x) <= o.w / 2 && Math.abs(w.y + CELL / 2 - o.y) <= o.h / 2);
    if (obj) { removedObjects.add(obj.id); return true; }
    const hit = vineAt(w.x + CELL / 2, w.y + CELL / 2);
    if (!hit) {
      const dt = baseOn() && decoAt(w.x + CELL / 2, w.y + CELL / 2);
      if (dt) { dt.cells.forEach((k2) => removedDeco.add(dt.layer + '|' + k2)); return true; }
      const sp = baseOn() && sceneSpriteAt(w.x + CELL / 2, w.y + CELL / 2);
      if (!sp) return false;
      removeScene(sp.id);
      return true;
    }
    if (hit.own) vines.delete(hit.k);
    else removedVines.add(hit.k);
  } else if (tool === 'spawn') {
    draft.spawn = gateAt(cx, cy, 'spawn');
  } else if (tool === 'start' || tool === 'end') {
    if (drag?.placedObject) return false;
    let c = courseById(draft.activeCourse);
    if (!c || c[tool]) c = (tool === 'end' && courses().find((x) => x.start && !x.end)) || newCourse();
    c[tool] = gateAt(cx, cy, tool);
    draft.activeCourse = c.id;
    if (drag) drag.placedObject = true;
  }
  return true;
}

function strokeAt(cx, cy) {
  const before = drag.before;
  if (!applyTool(cx, cy)) return;
  { const w = cellWorld(cx, cy); addFx(tool === 'erase' ? 'burst' : 'ripple', w.x + CELL / 2, w.y + CELL / 2, tool === 'erase' ? COLORS.end : COLORS[BLOCK_KIND[tool]] || COLORS.start); }
  if (!drag.changed) {
    drag.changed = true;
    pushUndoEntry(before);
  }
  saveDraft();
}

function rotateSpikeAtHover() {
  if (!hover) return;
  const k = key(hover.cx, hover.cy);
  const sp = spikes.get(k);
  const w = cellWorld(hover.cx, hover.cy);
  const vine = sp ? null : vineAt(w.x + CELL / 2, w.y + CELL / 2);
  if (!sp && !vine?.own) {
    const t = tileAt(w.x + CELL / 2, w.y + CELL / 2);
    if (!t) return;
    pushUndo();
    tiles.set(t[0], { ...t[1], q: ((t[1].q || 0) + 1) % 4 });
    saveDraft();
    requestDraw();
    return;
  }
  pushUndo();
  if (sp) {
    const cur = spikeTurn(sp, hover.cx, hover.cy);
    const opts = seats(hover.cx, hover.cy);
    const ring = opts.length > 1 ? opts : [0, 1, 2, 3];
    spikes.set(k, { ...sp, q: ring[(ring.indexOf(cur) + 1) % ring.length] ?? (cur + 1) % 4 });
  }
  else { const v = vines.get(vine.k); vines.set(vine.k, { ...v, q: (v.q + 1) % 4 }); }
  saveDraft();
  requestDraw();
}

function setTool(t) {
  tool = t;
  updateCategoryButtons();
  requestDraw();
}

function updateStatus() {
  const el = root?.querySelector('#mm-status');
  if (!el) return;
  const parts = [`${blocks.size} blocks`, `${spikes.size} spikes`, `${vines.size} vines`];
  if (tiles.size) parts.push(`${tiles.size} tiles`);
  if (mossCells.size) parts.push(`${mossCells.size} moss`);
  if (PLACING.includes(tool) && (placeRot || placeFlip)) parts.push(`placing at ${placeRot * 90}°${placeFlip ? ' mirrored' : ''}`);
  if (placed.length) parts.push(`${placed.length} objects`);
  const gone = removed.size + removedVines.size + removedObjects.size + removedScene.size + removedDeco.size;
  if (baseOn() && gone) parts.push(`${gone} removed`);
  let lonely = false;
  if (baseOn()) {
    parts.push('edits the real world');
    lonely = courses().some((c) => !c.start !== !c.end);
    const nFull = completeCourses().length;
    parts.push(nFull ? `plus ${nFull} course${nFull > 1 ? 's' : ''} of yours` : 'real courses keep their gates');
    if (!draft.spawn) parts.push(nFull ? 'spawn at course 1 start' : 'spawn at view centre');
  } else {
    const area = exportArea();
    if (area) parts.push(`${area.x1 - area.x0 + 1}×${area.y1 - area.y0 + 1} cells`);
    const gates = effectiveGates(area);
    lonely = !!gates.start !== !!gates.end;
    parts.push(gates.start && gates.end ? 'timed course' : 'free play');
    if (!draft.spawn) parts.push(gates.start ? 'spawn at start gate' : 'spawn at view centre');
  }
  el.innerHTML = parts.map((p) => `<span>${p}</span>`).join('')
    + (lonely ? `<span class="mm-warn">a course is missing a gate - it's skipped</span>` : '')
    + (hover ? `<span class="mm-coord">${hover.cx}, ${hover.cy}</span>` : '');
}

function syncBaseUi() {
  const on = baseOn();
  const btn = root.querySelector('#mm-base');
  btn.classList.toggle('active', on);
  root.querySelector('#mm-jump').hidden = !on;
  root.querySelector('#mm-state').hidden = !on;
  root.querySelectorAll('[data-state]').forEach((b) => b.classList.toggle('active', b.dataset.state === draft.baseState));
}

async function toggleBase() {
  if (baseOn()) {
    draft.useBase = false;
  } else {
    const btn = root.querySelector('#mm-base');
    btn.disabled = true;
    btn.classList.add('mm-busy');
    try {
      await loadBase(true);
    } catch (e) {
      flash("Couldn't load the base game map: " + e, true);
      return;
    } finally {
      btn.disabled = false;
      btn.classList.remove('mm-busy');
    }
    draft.useBase = true;
    fillJumpList();
    if (!blocks.size && !spikes.size && !courses().length && base.courses[0]) jumpTo(base.courses[0].start.x, base.courses[0].start.y);
  }
  saveDraft();
  syncBaseUi();
  requestDraw();
}

// ---- the overgrown stages: edited separately for the Start and Overgrown states ----
// The cells the overgrowth changes (its sprites, and ground / moss only one state
// has), plus a cell around them. Edits there belong to the state being viewed;
// everything else is shared by both.
let stageMask = null;
function stageCells() {
  if (stageMask) return stageMask;
  stageMask = new Set();
  if (!base) return stageMask;
  const addRect = (x0, y0, x1, y1) => {
    const a = cellOf(x0, y0), b = cellOf(x1, y1);
    for (let cx = a.cx - 1; cx <= b.cx + 1; cx++) for (let cy = a.cy - 1; cy <= b.cy + 1; cy++) stageMask.add(key(cx, cy));
  };
  for (const p of base.scene?.placements?.overgrown || []) {
    if (!(p.p || '').startsWith('Zone 1/OvergrowthStuff/')) continue;
    const [, , w, h] = base.scene.sprites[p.s], m = p.m || [1, 0, 0, 1];
    const r = Math.max(w * Math.hypot(m[0], m[2]), h * Math.hypot(m[1], m[3])) / 2;
    addRect(p.x - r, p.y - r, p.x + r, p.y + r);
  }
  const addRuns = (runs) => { for (let i = 0; i < (runs?.length || 0); i += 3) for (let k = 0; k < runs[i + 2]; k++) { const w = cellWorld(runs[i + 1] + k, runs[i]); addRect(w.x, w.y, w.x, w.y); } };
  for (const st of ['start', 'overgrown']) for (const kind of ['ground', 'moss', 'blue', 'orange']) for (const runs of base.states?.[st]?.[kind] || []) addRuns(runs);
  return stageMask;
}
const inStage = (x, y) => { const c = cellOf(x, y); return stageCells().has(key(c.cx, c.cy)); };
// Lifts the edits inside the stages out of the working map (they go with the state being left).
function takeStageEdits() {
  const v = { blocks: [], spikes: [], vines: [], tiles: [], moss: [], placed: [], freeSpikes: [], signs: [], triggers: [], csprites: [], removed: [], removedVines: [], removedObjects: [], removedScene: [], removedDeco: [] };
  const cells = (m, out) => { for (const [k, val] of [...m]) if (stageCells().has(k)) { out.push([k, val]); m.delete(k); } };
  cells(blocks, v.blocks); cells(spikes, v.spikes); cells(vines, v.vines);
  for (const [k, t] of [...tiles]) { if (t.arrow) continue; const c = tileCenter(t.layer, k); if (inStage(c.x, c.y)) { v.tiles.push([k, t]); tiles.delete(k); } }
  for (const [k, val] of [...mossCells]) { const c = mossCenter(k); if (inStage(c.x, c.y)) { v.moss.push([k, val]); mossCells.delete(k); } }
  const split = (arr, out) => arr.filter((it) => (inStage(it.x, it.y) ? (out.push(it), false) : true));
  placed = split(placed, v.placed); freeSpikes = split(freeSpikes, v.freeSpikes); signs = split(signs, v.signs); triggers = split(triggers, v.triggers); csprites = split(csprites, v.csprites);
  const ids = (set, pos, out) => { for (const id of [...set]) { const p = pos(id); if (p && inStage(p.x, p.y)) { out.push(id); set.delete(id); } } };
  const cellPos = (k) => { const [cx, cy] = unkey(k), w = cellWorld(cx, cy); return { x: w.x + CELL / 2, y: w.y + CELL / 2 }; };
  ids(removed, cellPos, v.removed);
  ids(removedVines, cellPos, v.removedVines);
  ids(removedObjects, (id) => baseObjects.find((o) => o.id === id), v.removedObjects);
  ids(removedScene, (id) => sceneList?.items.find((p) => p.id === id), v.removedScene);
  ids(removedDeco, (rk) => { const bar = rk.lastIndexOf('|'), [gx, gy] = unkey(rk.slice(bar + 1)), g = layerGrid(rk.slice(0, bar)); return { x: g.ox + (gx + 0.5) * g.size, y: g.oy + (gy + 0.5) * g.size }; }, v.removedDeco);
  return v;
}
function putStageEdits(v) {
  if (!v) return;
  for (const [k, val] of v.blocks) blocks.set(k, val);
  for (const [k, val] of v.spikes) spikes.set(k, val);
  for (const [k, val] of v.vines) vines.set(k, val);
  for (const [k, val] of v.tiles) tiles.set(k, val);
  for (const [k, val] of v.moss) mossCells.set(k, val);
  placed.push(...v.placed); freeSpikes.push(...v.freeSpikes); signs.push(...v.signs); triggers.push(...v.triggers); csprites.push(...(v.csprites || []));
  v.removed.forEach((k) => removed.add(k)); v.removedVines.forEach((k) => removedVines.add(k));
  v.removedObjects.forEach((k) => removedObjects.add(k)); v.removedScene.forEach((k) => removedScene.add(k)); v.removedDeco.forEach((k) => removedDeco.add(k));
}
const otherState = (st) => (st === 'overgrown' ? 'start' : 'overgrown');
function toggleSimulate() {
  draft.simulate = !draft.simulate;
  simStart = performance.now();
  applyBaseMoves();
  saveDraft(); syncChrome(); invalidateBase();
}
let stagePath = null, stagePathOf = null;
function drawStageMask() {
  if (cam.scale < 0.05) return;
  const set = stageCells();
  if (!set.size) return;
  if (stagePathOf !== set) {
    stagePathOf = set;
    stagePath = new Path2D();
    for (const k of set) {
      const [x, y] = unkey(k), w = cellWorld(x, y), x1 = w.x + CELL, y1 = w.y + CELL;
      if (!set.has(key(x, y + 1))) { stagePath.moveTo(w.x, y1); stagePath.lineTo(x1, y1); }
      if (!set.has(key(x, y - 1))) { stagePath.moveTo(w.x, w.y); stagePath.lineTo(x1, w.y); }
      if (!set.has(key(x - 1, y))) { stagePath.moveTo(w.x, w.y); stagePath.lineTo(w.x, y1); }
      if (!set.has(key(x + 1, y))) { stagePath.moveTo(x1, w.y); stagePath.lineTo(x1, y1); }
    }
  }
  const o = toScreen(0, 0), k = cam.scale;
  ctx.save();
  ctx.setTransform(k, 0, 0, -k, o.x, o.y);
  ctx.strokeStyle = draft.baseState === 'overgrown' ? 'rgba(120, 200, 90, 0.55)' : 'rgba(230, 170, 70, 0.45)';
  ctx.setLineDash([6 / k, 5 / k]);
  ctx.lineWidth = 1.5 / k;
  ctx.stroke(stagePath);
  ctx.restore();
}

function setBaseState(state) {
  if (draft.baseState === state) return;
  if (base) {
    // The stages' edits swap with the state; the rest of the map stays.
    const v = takeStageEdits();
    draft.stageEdits = { ...(draft.stageEdits || {}), [draft.baseState]: v };
    putStageEdits(draft.stageEdits[state]);
    delete draft.stageEdits[state];
    selection = null;
    undoStack = [];
    redoStack = [];
    tiles.journal = [];
    renderConfig();
    flash(`Editing the ${state === 'overgrown' ? 'Overgrown' : 'Start'} version of the overgrown stages (dashed) - the rest of the map is shared`);
  }
  draft.baseState = state;
  applyBaseState();
  saveDraft();
  syncBaseUi();
  requestDraw();
}

const prettySprite = (name) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function fillJumpList() {
  updateCategoryButtons();
  const jump = root.querySelector('#mm-jump');
  if (jump.options.length > 1 || !base) return;
  for (const c of base.courses) {
    const o = document.createElement('option');
    o.value = c.start.x + ',' + c.start.y;
    o.textContent = c.label;
    jump.appendChild(o);
  }
}

function flash(msg, isError) {
  const el = root.querySelector('#mm-flash');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('mm-out');
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.classList.add('mm-out'); flash.t = setTimeout(() => { el.hidden = true; }, 200); }, 3500);
}

// Asks where to save (the app's save dialog); builds without it fall back to a download.
async function exportZip() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      const path = await invoke('export_map_zip', { mapJson: JSON.stringify(map, null, 2), fileName: slug(map.name) + '.zip', assets: await mapAssets() });
      if (path) flash(`Exported to ${path} · ${map.groups[0].objects.length} objects`);
      return;
    } catch (e) {
      if (!/export_map_zip|unknown command|not found/i.test(String(e))) { flash('Couldn\'t export: ' + e, true); return; }
    }
  }
  const blob = zipSingle('map.json', JSON.stringify(map, null, 2));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slug(map.name) + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  flash(`Saved ${a.download} · ${map.groups[0].objects.length} objects`);
}

// The editor's own test map is overwritten by every test run, so it's never a save target.
const TEST_MAP_ID = 'map-maker-test';

// Saves into the game's installed maps: the first save picks a folder from the
// map's name (never another map's), later ones replace that same map.
async function saveMap() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) { flash('Saving needs the Recharge app.', true); return; }
  try {
    let id = draft.savedId;
    if (!id) {
      const taken = new Set((await invoke('list_maps')).map((m) => m.id));
      taken.add(TEST_MAP_ID);
      const stem = slug(map.name);
      id = stem;
      for (let n = 2; taken.has(id); n++) id = stem + '-' + n;
    }
    await invoke('save_map', { id, mapJson: JSON.stringify(map, null, 2), assets: await mapAssets() });
    draft.savedId = id;
    draft.savedAt = Date.now();
    saveDraft();
    syncSaveState();
    flash(`Saved "${map.name}" to your maps (${id})`);
  } catch (e) {
    flash(/save_map|unknown command|not found/i.test(String(e)) ? 'Update Recharge to save maps - this build can\'t yet. Export .zip still works.' : 'Couldn\'t save: ' + e, true);
  }
}

function syncSaveState() {
  const el = root?.querySelector('#mm-save-state');
  if (!el) return;
  el.textContent = draft.savedId ? `Saves to your maps as ${draft.savedId}` + (draft.savedAt ? ' · last saved ' + new Date(draft.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : 'Not saved yet - Save adds it to your maps';
}

async function testInGame() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const btn = root.querySelector('#mm-test');
  btn.disabled = true;
  btn.textContent = 'Launching…';
  try {
    await window.__TAURI__.core.invoke('test_launch_map', { mapJson: JSON.stringify(map, null, 2), assets: await mapAssets() });
    flash('Launching IGTAP - Navigator opens the map from the title screen.');
  } catch (e) {
    const msg = String(e);
    flash(/test_launch_map|not found|unknown command/i.test(msg) ? 'This Recharge build can\'t test-launch maps yet.' : msg, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test in game';
  }
}

async function copyJson() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  try {
    await navigator.clipboard.writeText(JSON.stringify(map, null, 2));
    flash('map.json copied to the clipboard.');
  } catch (e) {
    flash("Couldn't copy: " + e, true);
  }
}

function clearAll() {
  if (!confirm('Clear everything you placed or erased in this draft?')) return;
  pushUndo();
  blocks.clear();
  spikes.clear();
  vines.clear();
  tiles.clear();
  mossCells.clear();
  placed = [];
  freeSpikes = [];
  signs = [];
  triggers = [];
  csprites = [];
  xspawns = [];
  arrows = [];
  removed.clear();
  removedVines.clear();
  removedObjects.clear();
  removedScene.clear();
  removedDeco.clear();
  selection = null;
  renderConfig();
  draft.courses = [];
  draft.spawn = null;
  saveDraft();
  requestDraw();
}

function jumpTo(x, y) {
  glideCamera({ x, y, scale: Math.max(cam.scale, 0.5), anchor: null });
}

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  if (!r.width || !r.height) return;
  canvas.width = Math.round(r.width);
  canvas.height = Math.round(r.height);
  requestDraw();
}

function eventCell(e) {
  const r = canvas.getBoundingClientRect();
  const w = toWorld(e.clientX - r.left, e.clientY - r.top);
  return cellOf(w.x, w.y);
}

function bindCanvas() {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown);
    if (pan) {
      drag = { pan: true, x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const wp = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    hoverWorld = wp;
    if (e.altKey) { pickAt(wp.x, wp.y); return; }
    if (platformEdit != null) { drag = { pan: false, platform: true, before: snapshot(), changed: false }; platformPaint(wp); return; }
    if (tool === 'select' || grabsSelection(wp)) { selectDown(e); return; }
    const c = eventCell(e);
    drag = { pan: false, before: snapshot(), changed: false };
    if (tool === 'arrow') { arrowDown(c.cx, c.cy); requestDraw(); return; }
    strokeAt(c.cx, c.cy);
    requestDraw();
  });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  new ResizeObserver(resize).observe(canvas.parentElement);
}

let windowBound = false;
function bindWindow() {
  if (windowBound) return;
  windowBound = true;
  window.addEventListener('mousemove', (e) => {
    if (!mounted || !canvas.isConnected) return;
    if (drag?.pan) {
      cam.x = drag.camX - (e.clientX - drag.x) / cam.scale;
      cam.y = drag.camY + (e.clientY - drag.y) / cam.scale;
      requestDraw();
      return;
    }
    if (drag?.platform) { const r = canvas.getBoundingClientRect(); hoverWorld = toWorld(e.clientX - r.left, e.clientY - r.top); platformPaint(hoverWorld); return; }
    if (drag?.resize) { resizeMove(e); return; }
    if (drag && (drag.region || drag.move || drag.moveSel || drag.zip || drag.gate || drag.group || drag.fspike || drag.sign)) { selectMove(e); return; }
    if (!drag && tool === 'select' && e.target === canvas) canvas.style.cursor = edgeCursor(edgesAt(worldAt(e)));
    if (drag?.zipPlace != null) { zipPlaceMove(e); return; }
    if (e.target !== canvas && !drag) {
      if (hover) { hover = null; updateStatus(); requestDraw(); }
      return;
    }
    if (!drag) {
      const rect = canvas.getBoundingClientRect();
      const wp = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    }
    const c = eventCell(e);
    hoverWorld = worldAt(e);
    if (hover && hover.cx === c.cx && hover.cy === c.cy) { if ((tool === 'select' || platformEdit != null) && !drag) requestDraw(); return; }
    hover = c;
    if (drag?.arrow) arrowMove(c.cx, c.cy);
    else if (drag && (BLOCK_KIND[tool] || SPIKE_KIND[tool] || tool === 'erase' || tool === 'tile' || tool === 'moss')) {
      strokeAt(c.cx, c.cy);
    }
    updateStatus();
    requestDraw();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.region && !drag.regionMoved && !drag.keep?.length) { selection = null; renderConfig(); requestDraw(); }
    if ((drag.moveSel || drag.resize) && drag.changed) { saveDraft(); renderConfig(); }
    if (drag.arrow) arrowUp();
    drag = null;
    canvas.style.cursor = '';
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });
}

function onWheel(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const from = camGoal.active && camGoal.scale != null ? camGoal.scale : cam.scale;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from * Math.exp(-e.deltaY * 0.0015)));
  if (CALM) {
    const before = toWorld(sx, sy);
    cam.scale = scale;
    const after = toWorld(sx, sy);
    cam.x += before.x - after.x; cam.y += before.y - after.y;
    requestDraw();
    return;
  }
  glideCamera({ scale, anchor: { sx, sy }, x: null, y: null });
}

function onKeyDown(e) {
  if (!mounted || !canvas.isConnected || canvas.offsetParent === null) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveMap(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); if (clipObject) pasteObject(); else if (brush) setTool('paste'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (platformEdit != null) setPlatformEdit(null);
    else if (popCat) closePopover();
    else if (selection || tool === 'paste') { selection = null; renderConfig(); if (tool === 'paste') setTool('select'); requestDraw(); }
    else if (!draft.inline) { draft.inline = true; saveDraft(); syncChrome(); }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selection) { e.preventDefault(); deleteSelection(); } return; }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!nudgeSelection(d[0], d[1], e.shiftKey)) { cam.x += (d[0] * 96) / cam.scale; cam.y += (d[1] * 96) / cam.scale; requestDraw(); }
    return;
  }
  if (!e.shiftKey && k === 'h') { toggleHitboxes(); return; }
  if (k === '?' || k === '/' || k === 'k') { togglePanel('mm-keys'); return; }
  if (k === 'b' && selection?.kind === 'object' && zipShape(placed[selection.index])) { setPlatformEdit(platformEdit === selection.index ? null : selection.index); return; }
  if (k === 't') { toggleSimulate(); flash(draft.simulate ? 'Simulating: zip movers and the level\'s animations (T)' : 'Simulation off'); return; }
  if (k === 'g') { draft.noGrid = !draft.noGrid; saveDraft(); requestDraw(); flash(draft.noGrid ? 'Grid hidden (G)' : 'Grid shown (G)'); return; }
  if (k === 'l') { togglePanel('mm-layers'); return; }
  if (k === 'm') { togglePanel('mm-file'); return; }
  if (k === 'p') { togglePanel('mm-player'); return; }
  if (k === '0') { cam.scale = 1; requestDraw(); return; }
  if (e.key === 'Home') { const h = draft.spawn || courses()[0]?.start || (baseOn() && base.courses[0]?.start); if (h) jumpTo(h.x, h.y); return; }
  if (k === 'e') { setTool('erase'); return; }
  if (k === 'a') { const i = categoryItems('decor').findIndex((it) => it.tool === 'arrow'); if (i >= 0) { selectItem('decor', i); updatePopover(); } return; }
  if (k === 'q') { setTool('select'); return; }
  if ((e.key === ']' || e.key === '[' || e.key === '}' || e.key === '{') && targetsOf(selection).some((t) => STACKABLE.has(t.kind))) {
    const up = e.key === ']' || e.key === '}';
    restack(e.shiftKey ? (up ? 'front' : 'back') : up ? 'up' : 'down');
    return;
  }
  if (k === 'v') { if (brush) setTool('paste'); else flash('Copy a region first: Select (Q), drag, Ctrl+C.', true); return; }
  if (k === 'i') { if (hover) { const w = cellWorld(hover.cx, hover.cy); pickAt(w.x + CELL / 2, w.y + CELL / 2); } return; }
  if (k === 'r') { turnSomething(e.shiftKey ? -1 : 1); return; }
  if (k === 'f') { if (e.shiftKey) flipYSelection(); else turnSomething(0, true); return; }
  if (k === ',' || k === '.' || k === '<' || k === '>') { fineRotate(k === '.' || k === '>' ? -1 : 1, e.shiftKey); return; }
  if (k === '=' || k === '+' || k === '-' || k === '_') { scaleSelection(k === '=' || k === '+' ? 1 : -1); return; }
  if (e.key === '[' || e.key === ']') { stepItem(e.key === ']' ? 1 : -1); updatePopover(); return; }
  if (/^[1-9]$/.test(e.key)) { selectItem(draft.cat, Number(e.key) - 1); updatePopover(); return; }
  const cat = CATEGORIES.find((c) => c.key === k);
  if (cat) {
    if (draft.cat === cat.id && tool !== 'erase') stepItem(e.shiftKey ? -1 : 1);
    else selectItem(cat.id, currentIndex(cat.id));
    updatePopover();
  }
}

function updatePopover() {
  if (popCat) { popCat = draft.cat; renderPopover(''); }
}

export async function mountEditor(container) {
  if (mounted && root === container) { resize(); return; }
  mounted = false;
  root = container;
  root.innerHTML = `
    <div class="mm-bar">
      <div class="mm-group mm-cats" aria-label="Tools">
        <button class="mm-cat mm-cat-icon" data-tool="select" title="Select (Q): click a thing, Shift+click to add, drag a box to select everything inside">${icon('cursor')}<span class="mm-cat-label">Select</span></button>
        <button class="mm-cat mm-cat-icon mm-erase" data-tool="erase" title="Erase (E): your edits and the level's own tiles and objects">${icon('eraser')}<span class="mm-cat-label">Erase</span></button>
      </div>
      <div class="mm-group mm-cats" aria-label="Palette">
        ${CATEGORIES.map((c) => `<button class="mm-cat" data-cat="${c.id}" title="${c.label} (${c.key.toUpperCase()}) - again to step through (Shift back), 1-9 pick"><span class="mm-cat-thumb"></span><span class="mm-cat-text"><span class="mm-cat-label">${c.label}</span><span class="mm-cat-item"></span></span><span class="mm-caret">▾</span></button>`).join('')}
      </div>
      <div class="mm-pop" id="mm-pop" hidden></div>
      <div class="mm-bar-right">
        <div class="mm-group" aria-label="Edit">
          <button class="mm-tool mm-icon" id="mm-undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
          <button class="mm-tool mm-icon" id="mm-redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
          <select class="mm-input mm-snap" id="mm-snap" title="Snap for placed things - objects, decorations, text, free spikes (Shift: 1 unit). Blocks and grid spikes always fill whole cells"><option value="32">▦ Cell</option><option value="16">▦ ½</option><option value="8">▦ ¼</option><option value="4">▦ ⅛</option><option value="1">▦ Free</option></select>
        </div>
        <div class="mm-group" aria-label="View">
          <button class="mm-tool mm-icon" id="mm-base" title="Base map: show the real Overworld under your map; the area around your edits is exported with it">${icon('basemap')}</button>
          <div class="mm-tools" id="mm-state" hidden>
            <button class="mm-tool" data-state="start" title="Area 1 as it is at the start of the game">Start</button>
            <button class="mm-tool" data-state="overgrown" title="Area 1 after the breaker is tripped">Overgrown</button>
          </div>
          <select class="mm-input mm-jump" id="mm-jump" hidden><option value="">Jump to course…</option></select>
          <button class="mm-tool mm-icon" id="mm-hitbox" title="Hitboxes (H): solid blocks green, deadly shapes red">${icon('hitbox')}</button>
          <button class="mm-tool mm-icon" id="mm-sim-btn" title="Simulate (T): play zip movers along their tracks">${icon('play')}</button>
        </div>
        <div class="mm-group" aria-label="Panels">
          <button class="mm-tool mm-icon" id="mm-player-btn" title="Level settings (P): what the player starts with, music and background">${icon('sliders')}</button>
          <button class="mm-tool mm-icon" id="mm-layers-btn" title="Layers (L): show, hide and lock them">${icon('layers')}</button>
          <button class="mm-tool mm-icon" id="mm-keys-btn" title="Keys (K or ?): every shortcut">${icon('keys')}</button>
        </div>
        <div class="mm-group" aria-label="File">
          <button class="mm-tool mm-icon" id="mm-save" title="Save to your installed maps (Ctrl+S)">${icon('save')}</button>
          <button class="mm-tool mm-primary" id="mm-file-btn" title="Name, test in game, open and export (M)">Map ▾</button>
          <button class="mm-tool" id="mm-full-btn"></button>
        </div>
      </div>
    </div>
    <div class="mm-canvas-wrap">
      <canvas id="mm-canvas"></canvas>
      <div class="mm-config mm-inspector" id="mm-config" hidden></div>
      <div class="mm-config mm-dock" id="mm-player" hidden></div>
      <div class="mm-config mm-dock" id="mm-layers" hidden></div>
      <div class="mm-config mm-dock mm-keys" id="mm-keys" hidden></div>
      <div class="mm-config mm-dock mm-file" id="mm-file" hidden>
        <div class="mm-config-title">Map<span>details, play and files</span></div>
        <div class="mm-section">Details</div>
        <div class="mm-config-row"><label>Name<input class="mm-input" id="mm-name" type="text" placeholder="Map name" /></label></div>
        <div class="mm-config-row"><label>Description<input class="mm-input" id="mm-desc" type="text" placeholder="Optional" /></label></div>
        <div class="mm-section">Play &amp; save</div>
        <div class="mm-config-row"><button class="mm-tool" id="mm-save-panel" title="Save to your installed maps (Ctrl+S)">Save</button><button class="mm-tool mm-primary" id="mm-test" title="Install this map and launch the game straight into it">Test in game</button></div>
        <div class="mm-config-sub" id="mm-save-state"></div>
        <div class="mm-section">Open &amp; share</div>
        <div class="mm-config-row"><button class="mm-tool" id="mm-load" title="Open one of your installed maps to keep editing it">Load installed…</button><button class="mm-tool" id="mm-open" title="Open a map exported from this editor (.zip or map.json)">Open file…</button></div>
        <div class="mm-load-list" id="mm-load-list" hidden></div>
        <div class="mm-config-row"><button class="mm-tool" id="mm-export" title="Choose where to save this map as a .zip">Export .zip…</button><button class="mm-tool" id="mm-copy" title="Copy map.json to the clipboard">Copy JSON</button></div>
        <input type="file" id="mm-open-file" accept=".zip,.json,application/json,application/zip" hidden>
        <div class="mm-section">Draft</div>
        <div class="mm-config-row"><button class="mm-tool mm-danger" id="mm-clear" title="Clear everything you placed or erased">Clear draft…</button></div>
      </div>
      <div class="mm-hint">Right-drag pan · Wheel zoom · K keys</div>
      <div class="mm-flash" id="mm-flash" hidden></div>
    </div>
    <div class="mm-status" id="mm-status"></div>
`;

  canvas = root.querySelector('#mm-canvas');
  ctx = canvas.getContext('2d');
  root.querySelector('[data-tool="erase"]').addEventListener('click', () => { closePopover(); setTool('erase'); });
  root.querySelector('[data-tool="select"]').addEventListener('click', () => { closePopover(); setTool('select'); });
  root.querySelector('#mm-layers-btn').addEventListener('click', () => togglePanel('mm-layers'));
  root.querySelector('#mm-keys-btn').addEventListener('click', () => togglePanel('mm-keys'));
  root.querySelector('#mm-sim-btn').addEventListener('click', () => toggleSimulate());
  root.querySelector('#mm-full-btn').addEventListener('click', () => { draft.inline = !draft.inline; saveDraft(); syncChrome(); });
  new ResizeObserver(() => { const h = root.querySelector('.mm-bar')?.offsetHeight || 0; root.style.setProperty('--bar-h', h + 'px'); }).observe(root.querySelector('.mm-bar'));
  root.querySelector('#mm-file-btn').addEventListener('click', () => togglePanel('mm-file'));
  const snapSel = root.querySelector('#mm-snap');
  snapSel.value = String(draft.snap || CELL);
  snapSel.addEventListener('change', () => { draft.snap = Number(snapSel.value) || CELL; saveDraft(); flash(draft.snap === 1 ? 'Objects and decorations move freely' : `Objects and decorations snap to ${draft.snap} units`); });
  root.querySelector('#mm-player-btn').addEventListener('click', () => togglePanel('mm-player'));
  root.querySelector('#mm-load').addEventListener('click', toggleInstalledList);
  root.querySelector('#mm-open').addEventListener('click', () => root.querySelector('#mm-open-file').click());
  root.querySelector('#mm-open-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadMapFile(f); });
  root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    if (draft.cat !== b.dataset.cat || tool === 'erase') selectItem(b.dataset.cat, currentIndex(b.dataset.cat));
    openPopover(b.dataset.cat, b);
  }));
  root.addEventListener('mousedown', (e) => { if (popCat && !e.target.closest('#mm-pop, [data-cat]')) closePopover(); });
  root.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => setBaseState(b.dataset.state)));

  // The level data first: the palette, the art and every tile's grid come from it.
  try { await loadBase(true); } catch (e) { console.warn('[map editor] no level data', e); }
  const saved = await readSavedDraft();
  loadDraft(saved?.draft, saved?.meta ? { meta: saved.meta, chunks: saved.chunks } : null);
  applyBaseState();

  const jump = root.querySelector('#mm-jump');
  fillJumpList();
  jump.addEventListener('change', () => {
    if (!jump.value) return;
    const [x, y] = jump.value.split(',').map(Number);
    jumpTo(x, y);
    jump.value = '';
  });

  const bindField = (id, field) => {
    const el = root.querySelector(id);
    el.value = draft[field];
    el.addEventListener('input', () => { draft[field] = el.value; saveDraft(); requestDraw(); });
  };
  bindField('#mm-name', 'name');
  bindField('#mm-desc', 'description');
  root.querySelector('#mm-base').addEventListener('click', toggleBase);
  root.querySelector('#mm-hitbox').addEventListener('click', toggleHitboxes);
  root.querySelector('#mm-hitbox').classList.toggle('active', !!draft.hitboxes);
  root.querySelector('#mm-undo').addEventListener('click', undo);
  root.querySelector('#mm-redo').addEventListener('click', redo);
  root.querySelector('#mm-clear').addEventListener('click', clearAll);
  root.querySelector('#mm-test').addEventListener('click', testInGame);
  root.querySelector('#mm-save').addEventListener('click', saveMap);
  root.querySelector('#mm-save-panel').addEventListener('click', saveMap);
  syncSaveState();
  root.querySelector('#mm-copy').addEventListener('click', copyJson);
  root.querySelector('#mm-export').addEventListener('click', exportZip);

  syncChrome();
  const home = draft.spawn || courses()[0]?.start;
  if (home) { cam.x = home.x; cam.y = home.y; }
  mounted = true;
  bindCanvas();
  bindWindow();
  syncBaseUi();
  if (!CATEGORIES.some((c) => c.id === draft.cat) || !categoryItems(draft.cat).length) draft.cat = 'blocks';
  selectItem(draft.cat, currentIndex(draft.cat));
  resize();
  updateStatus();
}

