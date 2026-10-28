import { uidIsShared } from '../upload-update.js';
import { isV2, toV1State } from './fromv2.js';
import { TileIndex, TrackedMap, TrackedSet, TrackedTiles, CHUNK } from './tileindex.js';
import { pickPieces, connector, connectorRoles } from './tiling.js';
import { EDGE_PROFILE } from './edgeprofiles.js';
import { checkpointExport } from './checkpoint.js';
import { solidGroup, outlineLoops } from './hitboxes.js';
import { prettyStringify } from './prettyjson.js';
import { readDraft as readDraftIDB, writeDraft as writeDraftIDB } from './draftdb.js';
import { TEST_MAP_ID, isTestMap } from './test-map.js';

// Where this editor's own files live (art, level data, plants, fonts, tile worker): the folder of this module, so a downloaded Amplifier (served from its own address, see commands/amp.rs) uses its own files and the built-in one /maps/.
const MAPS = new URL('./', import.meta.url).href;
// A downloaded editor is on another origin: images must be requested with CORS or drawing them would taint the canvases.
const MAPS_CROSS = (() => { try { return new URL(MAPS).origin !== self.location.origin; } catch { return false; } })();
// A worker can't load its script from another origin directly, so a downloaded editor starts it through a same-origin blob that just imports the real one (the server allows our origin through CORS).
function newTileWorker() {
  const url = new URL('./tile-worker.js', import.meta.url).href;
  if (!MAPS_CROSS) return new Worker(url, { type: 'module' });
  const blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(url)};`], { type: 'text/javascript' }));
  let worker;
  try { worker = new Worker(blobUrl, { type: 'module' }); } catch (err) {
    URL.revokeObjectURL(blobUrl);
    pool.why = 'blob blocked: ' + String(err?.message || err);
    dbgLog('worker start failed: ' + pool.why);
    throw err;
  }
  worker._blobUrl = blobUrl;
  return worker;
}
// "amp-12" for a downloaded Amplifier (its folder name), else "built-in".
function editorVersion() { return /\/(amp-[0-9A-Za-z._-]+)\/$/.exec(MAPS)?.[1] || 'built-in'; }
function newMapImage() { const i = new Image(); if (MAPS_CROSS) i.crossOrigin = 'anonymous'; return i; }
const DRAFT_KEY = 'rechargeMapMakerDraft';
// A note that a session's autosave failed, so the next one knows the draft it gets back is not the newest one.
const DRAFT_OFF_KEY = 'rechargeMapMakerDraftOff';
const START_BOX = { dx: 0, dy: 0, w: 60, h: 250 };
const END_BOX = { dx: 0, dy: -26, w: 240, h: 13 };
const START_LIFT = 125;
const SPAWN_BOX = { dx: 0, dy: 0, w: 32, h: 64 };
const SPAWN_LIFT = 40;
// A course's screen (reward, best time, clones) sits at its texts' centre; the board image (350 x 150 scaled 1.1 x 1.15) is centred 3.5 above it, as MapCourses.PlaceScreen does.
const SCREEN_BOX = { dx: 0, dy: 3.5, w: 385, h: 172.5 };
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
let baseVineKeys = [];

let canvas, ctx, root;
// Frames go into backCanvas and are copied to visCanvas in one drawImage, so the visible canvas is never seen cleared or half-painted.
let visCanvas = null, visCtx = null, backCanvas = null, backCtx = null;
const flick = { throws: 0, resizes: 0, lost: 0, restored: 0, copies: 0, purged: 0, skipped: 0, mismatch: 0 };
let cam = { x: 0, y: 0, scale: 0.75 };
let tool = 'block';
let hover = null;
let drag = null;
let spaceDown = false;
let undoStack = [];
let redoStack = [];
const DEFAULT_PLAYER = { dashes: 1, airJumps: 1, wallJump: true, blockSwap: false, omniDash: false, zipMovers: true, refreshers: true, teleporters: true, light: false, cash: 0 };
let draft = emptyDraft();
let mounted = false;
let frameQueued = false;

function emptyDraft() {
  return { name: '', description: '', pad: 12, useBase: true, baseState: 'start', blocks: {}, spikes: {}, vines: {}, tiles: {}, arrows: [], placed: [], removed: [], removedVines: [], removedObjects: [], removedScene: [], removedDeco: [], vineSprite: 'smallArc', start: null, end: null, spawn: null, courses: [], activeCourse: null, baseEdits: {}, levelRespawns: {}, cat: 'blocks', pick: {}, player: { ...DEFAULT_PLAYER }, ownProgress: false };
}

let blocks = new TrackedMap();
let spikes = new TrackedMap();
let vines = new TrackedMap();
// TrackedTiles counts its own changes, so the index below knows when to rebuild.
let tiles = new TrackedTiles();
// Which tiles are near the view, so drawing doesn't walk the whole map.
const tileIndex = new TileIndex((layer) => layerGrid(layer));
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
let removed = new TrackedSet();
let removedVines = new TrackedSet();
let removedObjects = new TrackedSet();
let removedScene = new TrackedSet();
let removedDeco = new TrackedSet();
// The level's own sprites and objects moved in the editor: id -> [dx, dy].
let movedScene = new Map(), movedObjects = new Map();
// The level's own things' draw order, turn / size / flips and groups, by level id ('o:' + id for level objects).
let levelOrder = new Map(), levelTf = new Map(), levelGroups = new Map();
const levelKey = (t) => (t.kind === 'base' ? 'o:' + t.id : t.id);
let removedPaths = [];
const syncRemovedPaths = () => { removedPaths = baseObjects.filter((o) => removedObjects.has(o.id) && o.path).map((o) => o.path); };
let baseObjects = [];
const baseObjectVisible = (o) => !o.checkpoint || !o.state || o.state === 'always' || o.state === draft.baseState;

const key = (cx, cy) => cx + ',' + cy;
const unkey = (k) => {
  const c = k.indexOf(',');
  if (c < 0 || k.indexOf(',', c + 1) >= 0) return k.split(',').map(Number); // not a plain "x,y": as it always was
  return [+k.slice(0, c), +k.slice(c + 1)];
};
// The smallest / largest of a list of any length (Math.min(...list) throws a RangeError past ~100k items and is slow well before).
const minOf = (a) => { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; };
const pushAll = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };
const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

function cellOf(wx, wy) {
  return { cx: Math.floor(wx / CELL), cy: Math.floor((wy - OFFSET_Y) / CELL) };
}
function cellWorld(cx, cy) {
  return { x: cx * CELL, y: cy * CELL + OFFSET_Y };
}
const baseOn = () => draft.useBase && base !== null;

// The Maps and lists are built from `draft`, so opening a map doesn't save and re-read it.
function loadDraftFrom(stored) {
  try {
    if (stored) draft = Object.assign(emptyDraft(), stored);
  } catch {}
  draft.player = { ...DEFAULT_PLAYER, ...(draft.player || {}) };
  if (!draft.levelRespawns || typeof draft.levelRespawns !== 'object') draft.levelRespawns = {};
  migrateGates();
  blocks = new TrackedMap(Array.isArray(draft.blocks) ? draft.blocks.map((k) => [k, 'ground']) : Object.entries(draft.blocks));
  spikes = new TrackedMap(Object.entries(draft.spikes).map(([k, v]) => [k, typeof v === 'number' ? { q: v, c: 'spike' } : v]));
  vines = new TrackedMap(Object.entries(draft.vines));
  tiles = new TrackedTiles(Object.entries(draft.tiles || {}));
  tooBigAt = Infinity; // a newly opened map gets a fresh try at the autosave
  mossCells = new TrackedMap(Object.entries(draft.moss || {}));
  cellGroups = new Map(Object.entries(draft.cellGroups || {}));
  placed = [...(draft.placed || [])];
  freeSpikes = [...(draft.freeSpikes || [])];
  signs = [...(draft.signs || [])];
  triggers = [...(draft.triggers || [])];
  csprites = [...(draft.csprites || [])];
  xspawns = [...(draft.xspawns || [])];
  arrows = (draft.arrows || []).map((a) => ({ ...a, cells: a.cells.map((c) => [...c]) }));
  for (const [k, v] of spikes) if (v.c === 'vine') { spikes.delete(k); vines.set(k, { s: 'smallArc', q: v.q }); }
  removedVines = new TrackedSet(draft.removedVines);
  removedObjects = new TrackedSet(draft.removedObjects);
  removedScene = new TrackedSet(draft.removedScene || []);
  removedDeco = new TrackedSet(draft.removedDeco || []);
  movedScene = new Map(Object.entries(draft.movedScene || {}));
  movedObjects = new Map(Object.entries(draft.movedObjects || {}));
  levelOrder = new Map(Object.entries(draft.levelOrder || {}));
  levelTf = new Map(Object.entries(draft.levelTf || {}));
  levelGroups = new Map(Object.entries(draft.levelGroups || {}));
  removed = new TrackedSet(draft.removed);
}

// Builds the Maps from a blank draft; opening the editor starts a new map and leaving it saves.
async function loadDraft() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch {}
  let idbDraft = null;
  try { const idb = await readDraftIDB(); if (idb?.draft) idbDraft = idb.draft.cellChunks ? assemblePieces(idb.draft, idb.chunks) : idb.draft; } catch {}
  // The newer copy wins: every autosave stamps the draft with the time it was written.
  // (savedAt is when the map was saved to a file, not when the draft was stored, so it doesn't count here.)
  const useIDB = !!idbDraft && (!stored || (idbDraft.autosavedAt ?? 0) > (stored.autosavedAt ?? 0));
  const from = useIDB ? idbDraft : stored;
  loadDraftFrom(from);
  if (from?.autosavedAt) { autosaveAt = from.autosavedAt; autosaveStore = useIDB ? 'idb' : 'local'; }
  // A session whose autosave failed left a note: the draft that comes back is the last one that fit,
  // so say that rather than let the author think the newest edits are here.
  const off = draftOffMarker();
  draftOffNote = off?.at
    ? `The last session's autosave failed - this draft is from ${clockOf(autosaveAt || off.at)}, and the edits after it were not kept. Save or export the map to keep it.`
    : '';
}

// The draft's fields from the live collections (what gets stored and exported).
// A tracked collection as the plain object the draft keeps it in: made again only when the collection changed since (a big map's
// cells are most of its autosave and its export, and most saves find them as they were).
const plainOf = new Map();
function plainFrom(name, coll) {
  const c = plainOf.get(name);
  if (c && c.src === coll && c.rev === coll.rev && c.size === coll.size) return c.out;
  const out = Object.fromEntries(coll);
  plainOf.set(name, { src: coll, rev: coll.rev, size: coll.size, out });
  return out;
}
function syncDraft(cells = true) {
  // (The autosave of a big draft in IndexedDB writes the cells piece by piece from the collections, so it asks for the rest only.)
  if (cells) {
    draft.blocks = plainFrom('blocks', blocks);
    draft.spikes = plainFrom('spikes', spikes);
    draft.vines = plainFrom('vines', vines);
    draft.tiles = plainFrom('tiles', tiles);
    draft.moss = plainFrom('moss', mossCells);
  }
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
  draft.movedScene = Object.fromEntries(movedScene);
  draft.movedObjects = Object.fromEntries(movedObjects);
  draft.levelOrder = Object.fromEntries(levelOrder);
  draft.levelTf = Object.fromEntries(levelTf);
  draft.levelGroups = Object.fromEntries(levelGroups);
  draft.removed = [...removed];
}

// Cheap per edit; the draft itself is written out once edits pause (or on leaving).
let persistTimer = 0;
function saveDraft() {
  for (const [k, d] of [...movedScene]) if (!d[0] && !d[1]) movedScene.delete(k);
  for (const [k, d] of [...movedObjects]) if (!d[0] && !d[1]) movedObjects.delete(k);
  syncRemovedPaths();
  applyBaseMoves();
  redrawChangedLevel();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistDraft, 1500);
  updateStatus();
}
function flushDraft() {
  clearTimeout(persistTimer);
  return persistDraft();
}

// The autosave. A draft that doesn't fit localStorage goes to IndexedDB instead (a far bigger quota); only when
// neither store takes it is the autosave off - and then the badge says so, because that is the moment work is at risk.
let tooBigAt = Infinity;   // the map's size at which localStorage last gave up (the costly string isn't built again for nothing)
// Whether the last autosave found nowhere to put the draft.
let autosaveOff = false;
// When the draft was last stored (in either store), and which store it went to.
let autosaveAt = 0;
let autosaveStore = '';
// Whether the "autosave off" note has already been given this session (it is given once).
let autosaveWarned = false;
// What a session whose autosave failed leaves behind for the next one to say.
let draftOffNote = '';

// How big the map is, in cells and things: the stand-in for "will this fit in localStorage?".
const draftSize = () => blocks.size + spikes.size + vines.size + tiles.size + mossCells.size
  + placed.length + freeSpikes.length + signs.length + triggers.length + csprites.length + xspawns.length;

// The clock the autosave and save lines show ("14:32").
const clockOf = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The marker that a session's autosave failed. localStorage is full in exactly the case it is needed for, so
// sessionStorage is the fallback; it lasts as long as the tab, which is what a reload needs.
const sessionStore = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
const markDraftOff = (at) => {
  const v = JSON.stringify({ at });
  try { localStorage.setItem(DRAFT_OFF_KEY, v); return; } catch {}
  try { sessionStore()?.setItem(DRAFT_OFF_KEY, v); } catch {}
};
const draftOffMarker = () => {
  let v = null;
  try { v = localStorage.getItem(DRAFT_OFF_KEY); } catch {}
  if (!v) { try { v = sessionStore()?.getItem(DRAFT_OFF_KEY); } catch {} }
  try { return v ? JSON.parse(v) : null; } catch { return null; }
};
const clearDraftOff = () => {
  draftOffNote = '';
  try { localStorage.removeItem(DRAFT_OFF_KEY); } catch {}
  try { sessionStore()?.removeItem(DRAFT_OFF_KEY); } catch {}
};

// A draft this big (cells and things) goes to IndexedDB in pieces: a record per area of cells, so an autosave writes the areas that
// changed. Smaller ones stay one record (a structured clone of the lot is cheap there, and the draft stays readable as it always was).
const IDB_PIECES_AT = 20000;
const PIECE_SETS = [['blocks', () => blocks], ['spikes', () => spikes], ['vines', () => vines], ['tiles', () => tiles], ['moss', () => mossCells]];
// The collections the piecewise draft in IndexedDB is in step with; anything else (a new map, a cleared one, a failed write) is written whole.
let piecesFor = null;
let piecesQueue = Promise.resolve();
// [key, value, seq] of an area's cells: the seq is the place the cell has in the collection's order, so the draft reads back in it.
const pieceEntries = (c, bucket) => [...bucket].map((k) => [k, Map.prototype.get.call(c, k), c.seqs.get(k)]);
// The draft without its cells, and the cell records that changed since the last write (all of them when nothing is known to be there).
function piecesToWrite() {
  const sets = PIECE_SETS.map(([name, get]) => [name, get()]);
  const all = !piecesFor || sets.some(([name, c]) => piecesFor[name] !== c || !c.stored);
  const chunks = [];
  for (const [name, c] of sets) {
    if (all) {
      c.takeStored();
      for (const [ck, b] of c.allBuckets()) chunks.push([name + '|' + ck, pieceEntries(c, b)]);
    } else {
      for (const ck of c.takeStored()) {
        const b = c.bucketOf(ck);
        chunks.push([name + '|' + ck, b && b.size ? pieceEntries(c, b) : null]);
      }
    }
    c.trackStored();
  }
  piecesFor = Object.fromEntries(sets);
  const small = { ...draft, blocks: {}, spikes: {}, vines: {}, tiles: {}, moss: {}, cellChunks: true };
  return { small, chunks, all };
}
// One write at a time, each working out what changed when its turn comes, so a failed write can't leave a later one without what it missed.
function writeDraftPieces() {
  const run = piecesQueue.then(async () => {
    const { small, chunks, all } = piecesToWrite();
    try { await writeDraftIDB(small, null, chunks, all); } catch (e) { piecesFor = null; throw e; }
  });
  piecesQueue = run.catch(() => {});
  return run;
}
// The draft as stored in pieces, whole again (the cell records are put back into the draft's own cell objects).
function assemblePieces(stored, chunks) {
  const d = { ...stored };
  delete d.cellChunks;
  const all = {};
  for (const [name] of PIECE_SETS) { d[name] = {}; all[name] = []; }
  for (const [key, entries] of chunks || []) {
    const name = String(key).slice(0, String(key).indexOf('|'));
    if (all[name] && Array.isArray(entries)) for (const e of entries) all[name].push(e);
  }
  // Back in the order the collections had when they were written (the numbers only ever go up, so that is their order).
  for (const [name] of PIECE_SETS) for (const [k, v] of all[name].sort((a, b) => a[2] - b[2])) d[name][k] = v;
  return d;
}

async function persistDraft() {
  persistTimer = 0;
  const size = draftSize();
  // A draft known not to fit localStorage and big enough for pieces never needs its cells as plain objects.
  syncDraft(!(size >= tooBigAt && size >= IDB_PIECES_AT));
  const stamp = Date.now();
  // Each copy says when it was written, so the newer one wins when the editor opens again.
  draft.autosavedAt = stamp;
  // localStorage first, unless this size is known not to fit (then the string isn't built again for nothing).
  if (size < tooBigAt) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      tooBigAt = Infinity;
      autosaveStore = 'local';
      autosaveOff = false;
      autosaveAt = stamp;
      autosaveWarned = false;
      clearDraftOff();
      updateAutosaveIndicator();
      return;
    } catch (e) {
      tooBigAt = size; // this size doesn't fit localStorage; IndexedDB has room for it
    }
  }
  // IndexedDB: the draft goes in as it is (a structured clone), so the string quota doesn't apply.
  try {
    if (size >= IDB_PIECES_AT) await writeDraftPieces();
    else {
      piecesFor = null; // the pieces, if there are any, are replaced by this whole draft
      await writeDraftIDB(draft, null, [], true);
    }
    autosaveStore = 'idb';
    autosaveOff = false;
    autosaveAt = stamp;
    autosaveWarned = false;
    clearDraftOff();
    updateAutosaveIndicator();
    return;
  } catch (e) {
    // Neither store took it: the autosave is off. The last draft that did fit is still where it was put,
    // and the badge says when that one is from, so nobody thinks the draft is gone.
    autosaveOff = true;
    markDraftOff(stamp);
    if (!autosaveWarned) {
      autosaveWarned = true;
      flash('Autosave is off - this map is too big for this browser to keep. Use Save or Export.', true);
    }
    updateAutosaveIndicator();
  }
}

// Tracked collections are frozen copies shared between steps (tileindex.js); the rest is small, mutated in place, kept as a string.
function snapshot() {
  const o = { blocks: blocks.freeze(), spikes: spikes.freeze(), vines: vines.freeze(), tiles: tiles.freeze(), moss: mossCells.freeze(), removed: removed.freeze(), removedVines: removedVines.freeze(), removedObjects: removedObjects.freeze(), removedScene: removedScene.freeze(), removedDeco: removedDeco.freeze() };
  const copied = blocks.copied + spikes.copied + vines.copied + tiles.copied + mossCells.copied + removed.copied + removedVines.copied + removedObjects.copied + removedScene.copied + removedDeco.copied;
  o.cellGroups = new Map(cellGroups); o.movedScene = new Map(movedScene); o.movedObjects = new Map(movedObjects);
  o.levelOrder = new Map(levelOrder); o.levelTf = new Map(levelTf); o.levelGroups = new Map(levelGroups);
  o.rest = JSON.stringify({ placed, freeSpikes, signs, triggers, csprites, xspawns, hiddenGroups: draft.hiddenGroups || [], arrows, courses: courses(), baseEdits: draft.baseEdits || {}, levelRespawns: draft.levelRespawns || {}, spawn: draft.spawn });
  o.bytes = o.rest.length + UNDO_ENTRY_OVERHEAD * (copied + cellGroups.size + movedScene.size + movedObjects.size + levelOrder.size + levelTf.size + levelGroups.size);
  return o;
}
// Big maps' snapshots are tens of MB, so the stack is capped by total size as well as count; the budget follows the reported memory, else 512MB (WebKitGTK reports none).
const UNDO_MAX_BYTES = (() => {
  const mb = Math.max(256, Math.min(1024, Math.round(((typeof navigator !== 'undefined' && navigator.deviceMemory) || 4) * 128)));
  return mb * 1024 * 1024;
})();
// How many steps the history keeps, whatever their size.
const UNDO_MAX_STEPS = 200;
// What one Map/Set entry costs in a snapshot's estimate (its key and value pointers and the hash bucket's share).
// It is a proxy, not a measurement: measuring a JS object graph is far more expensive than guessing.
const UNDO_ENTRY_OVERHEAD = 60;
// Has the first trim of this session been reported?
let undoTrimReported = false;
// Keeps the history inside its caps: the oldest steps go first, so the step the author is about to need (the newest) is never dropped.
function trimUndo() {
  const beforeLen = undoStack.length;
  while (undoStack.length > UNDO_MAX_STEPS) undoStack.shift();
  // The whole history's size, then the oldest steps go until it fits the budget (the newest one always stays).
  let bytes = 0;
  for (const s of undoStack) bytes += s.bytes || 0;
  while (bytes > UNDO_MAX_BYTES && undoStack.length > 1) bytes -= undoStack.shift().bytes || 0;
  if (undoStack.length < beforeLen && !undoTrimReported) {
    // The history is shorter than the author expects: say so once, not on every step that follows.
    undoTrimReported = true;
    flash('Undo history trimmed - the oldest steps were dropped to stay in memory (' + undoStack.length + ' steps left).');
    updateStatus();
  }
}
function pushUndo() {
  redoStack = [];
  undoStack.push(snapshot());
  trimUndo();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push(snapshot());
  trimUndo();
  restoreSnapshot(s);
}
function redo() {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push(snapshot());
  trimUndo();
  restoreSnapshot(s);
}
function restoreSnapshot(s) {
  applyState(s);
  saveDraft();
  requestDraw();
}
// A snapshot's state put back, without saving (a drag rebuilds from its start on every move).
// Keeps `cur` when it can roll back to the frozen copy; otherwise builds one from it.
function adopt(cur, frozen, Ctor) {
  if (cur.rollback(frozen) || cur.restore(frozen)) return cur;
  const n = new Ctor(frozen);
  n.frozen = frozen; n.frozenRev = n.rev; n.journal = new Set();
  return n;
}
function applyState(o) {
  blocks = adopt(blocks, o.blocks, TrackedMap);
  spikes = adopt(spikes, o.spikes, TrackedMap);
  vines = adopt(vines, o.vines, TrackedMap);
  tiles = adopt(tiles, o.tiles, TrackedTiles);
  arrowSeen = null; // the arrow tiles may now be other ones: the cache of their keys is read again
  tooBigAt = Infinity;
  mossCells = adopt(mossCells, o.moss, TrackedMap);
  cellGroups = new Map(o.cellGroups);
  const r = JSON.parse(o.rest);
  placed = r.placed || [];
  freeSpikes = r.freeSpikes || [];
  signs = r.signs || [];
  triggers = r.triggers || [];
  csprites = r.csprites || [];
  xspawns = r.xspawns || [];
  draft.hiddenGroups = r.hiddenGroups || [];
  arrows = r.arrows || [];
  removedVines = adopt(removedVines, o.removedVines, TrackedSet);
  removedObjects = adopt(removedObjects, o.removedObjects, TrackedSet);
  removedScene = adopt(removedScene, o.removedScene, TrackedSet);
  removedDeco = adopt(removedDeco, o.removedDeco, TrackedSet);
  movedScene = new Map(o.movedScene);
  movedObjects = new Map(o.movedObjects);
  levelOrder = new Map(o.levelOrder);
  levelTf = new Map(o.levelTf);
  levelGroups = new Map(o.levelGroups);
  applyBaseMoves();
  removed = adopt(removed, o.removed, TrackedSet);
  draft.courses = r.courses || [];
  draft.baseEdits = r.baseEdits || {};
  draft.levelRespawns = r.levelRespawns || {};
  if (r.start || r.end) { draft.start = r.start; draft.end = r.end; migrateGates(); }
  draft.spawn = r.spawn;
}

let basePromise = null;
async function loadBase(show = false) {
  if (show && !loading) showLoading();
  if (!basePromise) basePromise = fetchBase().catch((e) => { basePromise = null; hideLoading(); throw e; });
  await basePromise;
  if (loading && !loading.render) { loading.render = true; setLoading(0.7, 'Drawing the view'); requestDraw(); }
}

async function fetchBase() {
  const res = await fetch(MAPS + 'basemap.json');
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
  baseFp = fnv(text);
  gridCache = null;
  try { plantList = await (await fetch(MAPS + 'plants/plants.json')).json(); } catch (e) { plantList = []; assetLog.set(MAPS + 'plants/plants.json', { ok: false, tries: 1, err: String(e) }); }
  await preloadImages();
  applyBaseState();
  baseSettled = true;
  // The workers only draw the level's tiles ahead of the view (~200 MB each in the page), so a map with the base game unloaded doesn't start them:
  // loading the base game later does, from tileWorkersReady() on its first tile.
  if (draft.useBase) startTileWorkers();
}
let baseSettled = false;
let baseFp = '';
function fnv(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }

// Every image the editor loads is logged here (kept even with the debug strip off) so a missing one shows in the debug report.
const assetLog = new Map();
// Loads an image, retrying with a cache-buster; resolves null once it has failed `tries` times (never a broken Image).
function loadImage(src, tries = 3) {
  return new Promise((ok) => {
    let n = 0;
    const go = () => {
      n++;
      const i = newMapImage();
      const fail = (err) => {
        assetLog.set(src, { ok: false, tries: n, err });
        if (n < tries) setTimeout(go, 300 * n); else ok(null);
      };
      i.onload = () => { if (i.naturalWidth) { assetLog.set(src, { ok: true, tries: n }); ok(i); } else fail('empty image'); };
      i.onerror = () => fail('load error');
      i.src = n > 1 ? src + (src.includes('?') ? '&' : '?') + 'r=' + n : src;
    };
    go();
  });
}
// An image the level lazily wants (atlas, scene): loaded once at a time, keep() runs on success; a failure tells the user.
const lazyLoading = new Set();
function loadLazy(src, keep, what) {
  if (lazyLoading.has(src)) return;
  lazyLoading.add(src);
  loadImage(src, 5).then((i) => {
    lazyLoading.delete(src);
    if (i) { keep(i); return; }
    if (!IN_WORKER) flash(what + ' could not load (see the debug log)', true);
  });
}

function preloadImages() {
  const sc = base.scene, jobs = [];
  const add = (src, keep) => jobs.push([src, keep]);
  add(MAPS + base.art.atlas, (i) => { atlasImg = i; });
  if (sc) {
    add(MAPS + sc.atlas, (i) => { sceneImg = i; });
    for (const b of sc.backgrounds || []) add(MAPS + b.img, (i) => { bgImages[b.img] = i; });
    (sc.fonts || []).forEach((f, n) => { if (f) add(MAPS + f.atlas, (i) => { fontImages[n] = i; }); });
  }
  for (const v of new Set(base.defs.filter((d) => d.kind === 'vine').map((d) => d.sprite))) add(MAPS + 'vines/' + encodeURIComponent(v) + '.png', (i) => { vineImages[v] = i; });
  let done = 0;
  const seen = new Map();
  return Promise.all(jobs.map(([src, keep]) => {
    if (!seen.has(src)) seen.set(src, loadImage(src));
    return seen.get(src).then((i) => { if (i) keep(i); setLoading(0.5 + (0.2 * ++done) / jobs.length, `Images ${done} / ${jobs.length}`); });
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
  levelJoinCache = null;
  warmLevelJoin();
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
  const checkpointPlacements = base.scene?.placements || {};
  for (const cp of base.scene?.checkpoints || []) {
    const at = cp.at || [], source = (checkpointPlacements[cp.state || 'always'] || []).find((p) => Math.abs(p.x - at[0]) < 0.1 && Math.abs(p.y - at[1]) < 0.1);
    if (at.length !== 2) continue;
    const id = (source?.p || 'checkpoint') + '@' + at[0] + ',' + at[1] + ':' + (cp.state || 'always');
    if (baseObjects.some((o) => o.path === source?.p && o.x === at[0] && o.y === at[1])) continue;
    const box = cp.box || {};
    baseObjects.push({
      kind: 'checkpoint', cls: 'checkpointScript', label: cp.course ? 'Course checkpoint' : 'Checkpoint',
      path: source?.p || null, x: at[0], y: at[1], srcX: at[0], srcY: at[1],
      hitX: at[0] + (box.dx || 0), hitY: at[1] + (box.dy || 0),
      w: box.w || CELL, h: box.h || CELL, checkpoint: true, state: cp.state, id,
    });
  }
  syncRemovedPaths();
  applyBaseMoves();
  baseHaz = new Map();
  baseVineKeys = [];
  for (const b of [base.always, st]) {
    const h = b.hazards;
    for (let i = 0; i < h.length; i += 5) {
      const def = base.defs[h[i + 2]];
      baseHaz.set(key(h[i], h[i + 1]), { d: h[i + 2], m: h[i + 3], q: h[i + 4], kind: def.kind, c: layerColor(def.layer) });
    }
  }
  for (const [k, h] of baseHaz) if (h.kind === 'vine') baseVineKeys.push(k);
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
  const px = pts.map((p) => p[0]), py = pts.map((p) => p[1]);
  const x0 = minOf(px), x1 = maxOf(px);
  const y0 = minOf(py), y1 = maxOf(py);
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

// A layer's grid. Some layers exist only in art.levelTiles with a non-default origin, so look there first; cached because it's called per tile per frame.
let gridCache = null;
function layerGrid(name) {
  if (!gridCache) {
    gridCache = new Map();
    for (const l of base?.art?.levelTiles || []) gridCache.set(l.name, l);
    for (const l of base?.art?.layers || []) if (!gridCache.has(l.name)) gridCache.set(l.name, l);
  }
  const l = gridCache.get(name);
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
// The sheets' own inside-corner tiles, named for the corner the empty diagonal is at: the level puts one on a cell with all
// four sides solid and one diagonal empty. A number, or { id, m } for a piece that is another one turned by matrix m.
// `rail` sheets (a rail / bevel / bar along the top) never get a generated connector: a mitred rail looks wrong.
const INNER_BEVEL = { NE: 14, SE: 6, SW: 7, NW: 15 };
const INNER_PLATE = { NE: 66, SE: 59, SW: 60, NW: 67 };
const INNER_GRATE = { NE: 12, SE: 4, SW: 5, NW: 13 };
const INNER_TURNED = (id) => ({ SE: id, NE: { id, m: [1, 0, 0, -1] }, SW: { id, m: [-1, 0, 0, 1] }, NW: { id, m: [-1, 0, 0, -1] } });
const PANEL_SET = { ...PANEL, single: 0, v: [8, 16, 26], h: [27, 28, 29], style: 'rail', rail: true, inner: INNER_BEVEL };
const GRATE_SET = { ...PANEL, single: 0, v: [8, 16, 24], h: [25, 26, 27], inner: INNER_GRATE };
function colouredTile(kind, cx, cy) {
  if (!base?.art) return null;
  return plateTile(kind === 'blue' ? 'blueBlocks' : 'orangeBlocks', kind + '_ground_tileset_', PANEL_SET, joinSolid(kind), cx, cy, joinStyle(kind));
}

let mossCells = new TrackedMap();
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
      ...vineSprites().filter((v) => base.catalog?.vineNames?.[v] !== null).map((v) => ({ tool: 'vine', vine: v, group: 'Thorn vines', label: base.catalog?.vineNames?.[v] || prettySprite(v), thumb: { img: MAPS + 'vines/' + encodeURIComponent(v) + '.png' } })),
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
  swapBlocks: { icon: 'toggle', label: 'Swap block colours', group: 'Player', color: '#e0c36a', about: 'swaps blue and orange blocks' },
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
  return plantList.map((pl, pi) => ({ tool: 'gsprite', pi, label: `${pl.kind} ${(count[pl.kind] = (count[pl.kind] || 0) + 1)}`, group: 'Plants', thumb: { img: MAPS + 'plants/' + pl.file } }));
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
    { tool: 'reset', label: 'Timer reset', group: 'Course', thumb: { icon: 'timer', color: COLORS.reset } },
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
    // Skip text parts (like StatuePrestigeText) which are huge but not representative
    if (p.n && /Text|Prestige|Text/i.test(p.n)) continue;
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
    return `<span class="mm-thumb-img" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px;background-image:url('${MAPS}${atlas}');background-size:${img.naturalWidth * k}px ${img.naturalHeight * k}px;background-position:${-x * k}px ${-y * k}px"></span>`;
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
  // `sprite` is an explicit atlas index for tiles with several sprites under one name (moss autotile); otherwise look the name up.
  const sprite = t.sprite ?? base?.art?.tiles[t.tile];
  if (sprite === undefined || !artReady()) return;
  const w = tileCenter(t.layer, k), c = toScreen(w.x, w.y);
  ctx.save();
  ctx.globalAlpha = alpha;
  blitSprite(ctx, sprite, tileMatrix(t), cam.scale, c.x, c.y);
  ctx.restore();
}
// Only what's on screen (a map can hold hundreds of thousands of tiles). toWorld has y growing downwards, so the corners are sorted; layers go back to front, `front` (order >= 5) over blocks and hazards.
function drawPlacedTiles(front, margin = CELL, region = null) {
  const a = toWorld(0, 0), b = toWorld(canvas.width, canvas.height);
  let x0 = Math.min(a.x, b.x) - margin, x1 = Math.max(a.x, b.x) + margin;
  let y0 = Math.min(a.y, b.y) - margin, y1 = Math.max(a.y, b.y) + margin;
  if (region) { x0 = Math.max(x0, region[0] - margin); y0 = Math.max(y0, region[1] - margin); x1 = Math.min(x1, region[2] + margin); y1 = Math.min(y1, region[3] + margin); }
  const sprites = base?.art?.tiles, sc = cam.scale, hw = canvas.width / 2, hh = canvas.height / 2;
  if (!sprites) return;
  tileIndex.forEachInRect(tiles, x0, y0, x1, y1, (t, k, gx, gy, g) => {
    const sprite = t.sprite ?? sprites[t.tile];
    if (sprite === undefined) return;
    blitSprite(ctx, sprite, tileMatrix(t), sc, (g.ox + (gx + 0.5) * g.size - cam.x) * sc + hw, hh - (g.oy + (gy + 0.5) * g.size - cam.y) * sc);
  }, (names) => [...names].filter((n) => (layerGrid(n).order >= 5) === front).sort((p, q) => layerGrid(p).order - layerGrid(q).order));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
// A zip mover's platform is a grid of cells around its moving part; the cells under the gear are the root, the rest hang off it.
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
  if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); redoStack = []; trimUndo(); }
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

// The game drops a worldScale decoration's own rotation and flip (it sets the clone's world rotation and scale outright), so draw it that way.
function gameParts(item) {
  if (item.gameParts) return item.gameParts;
  const ws = item.worldScale, root = item.path.split('/').pop();
  const rp = item.parts.find((p) => p.n === root) || (item.parts.length === 1 ? item.parts[0] : null);
  const R = rp ? rp.m : [ws, 0, 0, ws], det = R[0] * R[3] - R[1] * R[2];
  const Ri = Math.abs(det) < 1e-9 ? [1, 0, 0, 1] : [R[3] / det, -R[1] / det, -R[2] / det, R[0] / det];
  const M = mul2([ws, 0, 0, ws], Ri);
  return (item.gameParts = item.parts.map((p) => ({ ...p, x: M[0] * p.x + M[1] * p.y, y: M[2] * p.x + M[3] * p.y, m: mul2(M, p.m) })));
}

function objectParts(o, item = catalogItem(o)) {
  if (!item) return [];
  const cfg = o.cfg || {};
  const T = mul2(rot2(((cfg.rot || 0) * Math.PI) / 180), [(cfg.scale || 1) * (cfg.sx || 1) * (cfg.fx ? -1 : 1), 0, 0, (cfg.scale || 1) * (cfg.sy || 1) * (cfg.fy ? -1 : 1)]);
  const zip = zipConfig(o, item);
  let parts = item.worldScale ? gameParts(item) : item.parts;
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
// An animation only schedules the next frame while its sprite is big enough on screen to see it move: zoomed right out, a few-pixel sprite changing frame is no reason to keep redrawing the whole view ten times a second.
const ANIM_MIN_PX = 16;
function animVisible(sprite) { const sp = base?.scene?.sprites[sprite]; return !sp || Math.max(sp[2], sp[3]) * cam.scale >= ANIM_MIN_PX; }
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
    if (p.frames) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; if (animVisible(sprite)) animated = true; }
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
    if (isCheckpoint(item)) {
      // The flag and respawn point: where the game puts them, standing in the box.
      const f = checkpointExport(o.x, o.y, t), p = toScreen(f.x, f.y);
      ctx.fillStyle = col; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 22); ctx.lineTo(p.x + 14, p.y - 16); ctx.lineTo(p.x, p.y - 10); ctx.stroke(); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}
// Where along its track (0 start, 1 end) a zip mover is `now` seconds into its loop: move, pause, return, pause.
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

// The keys of the arrow tiles in `arrowSeen` (the tiles instance they were put in).
let arrowTileKeys = new Set(), arrowSeen = null;
function rebuildArrowTiles() {
  if (arrowSeen !== tiles) { arrowSeen = tiles; arrowTileKeys = new Set(); for (const [k, t] of tiles) if (t.arrow) arrowTileKeys.add(k); }
  for (const k of arrowTileKeys) if (tiles.get(k)?.arrow) tiles.delete(k);
  arrowTileKeys.clear();
  for (const a of arrows) for (const [k, t] of arrowTiles(a)) { tiles.set(k, t); arrowTileKeys.add(k); }
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
  if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); redoStack = []; trimUndo(); }
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
  if (!base?.art) return [];
  const own = base.art.stamps?.length || 0, all = allStamps(), items = [];
  const order = Object.keys(TILESET_NAMES), rank = (f) => (order.includes(f) ? order.indexOf(f) : order.length);

  // Tile names already covered as individual tiles by single-cell pieces (so they are not added twice).
  const coveredTiles = new Set();
  all.forEach((st, si) => { if (si >= own && st.n === 1 && !st.label) coveredTiles.add(st.cells[2]); });

  // Group every art tile by its family prefix (text before the last _).
  const tilesByFam = new Map();
  for (const tileName of Object.keys(base.art.tiles || {})) {
    const i = tileName.lastIndexOf('_');
    const fam = i < 0 ? tileName : tileName.slice(0, i);
    if (!tilesByFam.has(fam)) tilesByFam.set(fam, []);
    tilesByFam.get(fam).push(tileName);
  }

  // All families that have pieces or are named tilesets, sorted by the TILESET_NAMES order.
  const famSet = new Set(all.slice(own).map((st) => st.fam));
  Object.keys(TILESET_NAMES).forEach((f) => famSet.add(f));
  const fams = [...famSet].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const fam of fams) {
    const group = TILESET_NAMES[fam] || prettySprite(fam);
    all.forEach((st, si) => {
      if (si < own || st.fam !== fam) return;
      if (st.n > 1 || st.label) items.push({ tool: 'stamp', si, label: st.label ? `${st.label} ${st.w}×${st.h}` : `${st.w}×${st.h}`, group, thumb: { stamp: si } });
      else items.push({ tool: 'tile', tileLayer: st.layer, tile: st.cells[2], label: prettySprite(st.cells[2].replace(/_/g, ' ')), group, thumb: { art: st.cells[2] } });
    });
    // Every remaining individual tile from this tileset, not already covered by a single-cell piece.
    const layer = TILESET_LAYER[fam] || 'Background';
    const tiles = tilesByFam.get(fam) || [];
    for (const tileName of tiles) {
      if (coveredTiles.has(tileName)) continue;
      items.push({ tool: 'tile', tileLayer: layer, tile: tileName, label: prettySprite(tileName.replace(/_/g, ' ')), group, thumb: { art: tileName } });
    }
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

// pass 'art': only the object's real sprite parts; 'area': only its trigger-zone box; default: either.
function objectHit(o, wx, wy, pass = 'any') {
  const item = catalogItem(o);
  if (!item) return false;
  const box = objectBox(o, item), inBox = !!box && wx >= o.x + box[0] && wx <= o.x + box[2] && wy >= o.y + box[1] && wy <= o.y + box[3];
  const zone = isSizable(item) || !item.parts.length;
  if (pass !== 'art' && zone && inBox) return true;
  if (pass === 'area') return !objectHasArt(o, item) && inBox;
  let shown = false;
  for (const p of objectParts(o, item)) {
    if (HIDDEN_PART(p)) continue;
    shown = true;
    const [, , w, h, pvx, pvy] = base.scene.sprites[p.s], W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h;
    const det = p.m[0] * p.m[3] - p.m[1] * p.m[2];
    if (Math.abs(det) < 1e-9) continue;
    const dx = wx - o.x - p.x, dy = wy - o.y - p.y;
    const lx = (p.m[3] * dx - p.m[1] * dy) / det, ly = (-p.m[2] * dx + p.m[0] * dy) / det;
    if (lx >= -pvx * W && lx <= (1 - pvx) * W && ly >= -pvy * H && ly <= (1 - pvy) * H) return true;
  }
  if (!shown && inBox) return pass !== 'art';
  return !shown && !(pass === 'art' && zone) && Math.hypot(wx - o.x, wy - o.y) < CELL / 2;
}
const objectHasArt = (o, item) => objectParts(o, item).some((p) => !HIDDEN_PART(p));
function tileAt(wx, wy) {
  let best = null, bo = 0;
  for (const layer of tiles.layers.keys()) {
    const k = tileKeyAt(layer, wx, wy), t = tiles.get(k);
    if (!t) continue;
    const o = layerGrid(layer).order;
    if (!best || o >= bo) { best = [k, t]; bo = o; }
  }
  return best;
}
// The tiles whose centre's cell is inside the cell rect, as [key, tile, centre, cell].
function tilesInCells(x0, y0, x1, y1) {
  const a = cellWorld(x0, y0), b = cellWorld(x1 + 1, y1 + 1), out = [];
  tileIndex.forEachInRect(tiles, a.x - 1, a.y - 1, b.x + 1, b.y + 1, (t, k) => {
    const c = tileCenter(t.layer, k), cc = cellOf(c.x, c.y);
    if (cc.cx >= x0 && cc.cx <= x1 && cc.cy >= y0 && cc.cy <= y1) out.push([k, t, c, cc]);
  });
  return out;
}
// The [key, value, x, y] of a cell map's cells inside the cell rect.
function cellsIn(m, x0, y0, x1, y1) {
  const out = [];
  m.forEachIn(x0, y0, x1, y1, (k, v, x, y) => out.push([k, v, x, y]));
  return out;
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

// The topmost selectable thing under the point that sits on an open (not hidden / locked) layer; a closed layer's
// item is skipped, so the click falls through to what is below instead of selecting nothing.
function itemAt(wx, wy) {
  for (const t of itemsAtAny(wx, wy)) if (layerOpen(targetLayer(t))) return t;
  return null;
}
// Scenery drawn behind the playfield (wall decoration, background tiles / panels, pipes): art with a draw order under
// the level's (LEVEL_CUT), and the decoration tile layers. Not gameplay things, so a trigger area under it wins the click.
const GAMEPLAY_PATH = /teleporter|door|zipmover|upgrade|checkpoint|long ?fall|platform|gate/i;
const isBackgroundScene = (p) => (p.o ?? 0) < LEVEL_CUT && !GAMEPLAY_PATH.test(p.p || '');
function itemAtAny(wx, wy) { for (const t of itemsAtAny(wx, wy)) return t; return null; }
// What is under (wx, wy), best first. The foreground wins: your own placed things, then the level's real, interactive
// things (objects, blocks, spikes, vines, foreground sprites). Then trigger areas (checkpoints, course gates, long-fall
// zones, triggers; of several, the smallest), which beat background scenery (decoration, wall art). A trigger area's
// badge beats everything.
function* itemsAtAny(wx, wy) {
  const badges = areaHits(wx, wy, true);
  for (const h of badges) yield h.target;
  // A placed checkpoint's flag pin is its art: clicking it selects the checkpoint.
  for (const t of checkpointPinHits(wx, wy)) yield t;
  // The selected trigger zone's edge handles stay grabbable.
  const sel = selection?.kind === 'mtrig' ? triggers[selection.index] : null;
  if (sel && !layerHidden('course') && (Math.abs(Math.abs(wx - sel.x) - sel.w / 2) * cam.scale < 8 || Math.abs(Math.abs(wy - sel.y) - sel.h / 2) * cam.scale < 8)
    && Math.abs(wx - sel.x) <= sel.w / 2 + 8 / cam.scale && Math.abs(wy - sel.y) <= sel.h / 2 + 8 / cam.scale) yield { kind: 'mtrig', index: selection.index };
  const top = stack().findLast((e) => (e.kind === 'object' ? objectHit(e.it, wx, wy, 'art') : e.kind === 'csprite' ? customSpriteHit(e.it, wx, wy) : e.kind === 'sign' ? Math.abs(wx - e.it.x) <= e.it.w / 2 && Math.abs(wy - e.it.y) <= e.it.h / 2 : Math.abs(wx - e.it.x) <= CELL / 2 && Math.abs(wy - e.it.y) <= CELL / 2));
  if (top) yield { kind: top.kind, index: top.index };
  const c = cellOf(wx, wy), k = key(c.cx, c.cy);
  if (spikes.has(k)) yield { kind: 'cell', k };
  if (blocks.has(k)) yield ownBlocksAt(c.cx, c.cy);
  const mk = mossKeyAt(wx, wy);
  if (mossCells.has(mk)) yield ownMossAt(mk);
  const t = tileAt(wx, wy);
  if (t) yield { kind: 'tile', key: t[0] };
  const v = vineAt(wx, wy);
  if (v?.own) yield { kind: 'cell', k: v.k, vine: true };
  let sp = null;
  if (baseOn()) {
    const bo = baseObjects.findLast((o) => !isBaseArea(o) && baseObjectVisible(o) && !removedObjects.has(o.id) && Math.abs(wx - (o.hitX ?? o.x)) <= o.w / 2 && Math.abs(wy - (o.hitY ?? o.y)) <= o.h / 2);
    if (bo) yield { kind: 'base', id: bo.id };
    if (v && !v.own) yield { kind: 'basecells', cells: [v.k], what: 'Vine', vine: true };
    const bc = baseCellsAt(c.cx, c.cy);
    if (bc) yield bc;
    // Inside a checkpoint's box wins over scenery art (arrows, decoration) but not over blocks, spikes or objects above.
    for (const h of areaHits(wx, wy, false)) if (isCheckpointTarget(h.target)) yield h.target;
    sp = sceneSpriteAt(wx, wy);
    if (sp && !isBackgroundScene(sp)) {
      // A level checkpoint's own flag art selects the checkpoint, as a placed checkpoint's art does.
      const cpArt = baseObjects.find((o) => o.checkpoint && o.path && baseObjectVisible(o) && !removedObjects.has(o.id) && (sp.p === o.path || sp.p.startsWith(o.path + '/')));
      yield cpArt ? { kind: 'base', id: cpArt.id } : { kind: 'scene', id: sp.id };
    }
  }
  for (const h of areaHits(wx, wy, false)) yield h.target;
  if (baseOn()) {
    const dt = decoAt(wx, wy);
    if (dt) yield dt;
    if (sp && isBackgroundScene(sp)) yield { kind: 'scene', id: sp.id };
  }
}
// The level's yellow trigger zones carry a badge like a checkpoint's: shown from this zoom, with its name from 0.2.
const AREA_BADGE_MIN = 0.05, AREA_LABEL_MIN = 0.2;
const ZONE_NAMES = { TutorialTextTrigger: 'TEXT TRIGGER', EndCreditsTrigger: 'END CREDITS', FakeCreditsControlScript: 'FAKE CREDITS', tripBreakerScript: 'TRIP BREAKER', SceneTransitionObject: 'SCENE CHANGE' };
function areaBadge(o) {
  if (o.checkpoint) return { icon: 'checkpoint', text: o.label.toUpperCase() };
  if (o.cls === 'longFallColliderController') return { icon: 'fall', text: String(o.label).toUpperCase() };
  const credits = o.cls === 'EndCreditsTrigger' || o.cls === 'FakeCreditsControlScript';
  return { icon: credits ? CREDIT_ICON : 'cursor', text: (ZONE_NAMES[o.cls] || String(o.label || 'ZONE').toUpperCase()) + (credits ? (draft.simulate ? ' ▶ PLAYING' : ' · SIMULATE (T) TO PLAY') : '') };
}
// Imported level objects that are only a trigger area (checkpoints, long-fall zones, credits / tutorial / trip triggers).
const isBaseArea = (o) => !!o.checkpoint || o.kind === 'trigger';
// The trigger areas under the point, smallest first. badgeOnly: just those whose badge (the label above the box) is under it.
function areaHits(wx, wy, badgeOnly) {
  const out = [], ppu = Math.max(cam.scale, 0.001), hidden = layerHidden('course');
  const add = (target, x, y, w, h) => {
    const inBox = Math.abs(wx - x) <= w / 2 && Math.abs(wy - y) <= h / 2;
    const labelRight = cam.scale >= AREA_LABEL_MIN ? 110 : 13, by = y + h / 2 + 14 / ppu;
    const onBadge = cam.scale >= AREA_BADGE_MIN && wx >= x - 13 / ppu && wx <= x + labelRight / ppu && Math.abs(wy - by) <= 13 / ppu;
    if (badgeOnly ? onBadge : inBox) out.push({ target, size: w * h });
  };
  if (baseOn() && !layerHidden('level')) {
    for (const o of baseObjects) if (isBaseArea(o) && baseObjectVisible(o) && !removedObjects.has(o.id)) add({ kind: 'base', id: o.id }, o.hitX ?? o.x, o.hitY ?? o.y, o.w || CELL, o.h || CELL);
  }
  placed.forEach((o, index) => {
    const item = catalogItem(o);
    if (!item || !(isSizable(item) || !item.parts.length)) return;
    const t = trigOf(o, item);
    add({ kind: 'object', index }, o.x + t.dx, o.y + t.dy, t.w, t.h);
  });
  if (!hidden) {
    triggers.forEach((t, index) => add({ kind: 'mtrig', index }, t.x, t.y, t.w, t.h));
    xspawns.forEach((s, index) => add({ kind: 'xspawn', index }, s.x, s.y + SPAWN_BOX.dy, SPAWN_BOX.w + 8, SPAWN_BOX.h + 8));
  }
  for (const m of markerList()) add(m.target, m.g.x + m.b.dx, m.g.y + m.b.dy, Math.max(m.b.w, CELL), Math.max(m.b.h, CELL));
  return out.sort((a, b) => a.size - b.size);
}
const isCheckpointTarget = (t) => t.kind === 'base' ? !!baseObjects.find((o) => o.id === t.id)?.checkpoint : t.kind === 'object' && isCheckpoint(catalogItem(placed[t.index]));
// The flag pin drawn on each placed checkpoint (drawPlacedObject): a small screen-sized box around the pole and flag.
function checkpointPinHits(wx, wy) {
  const out = [], ppu = Math.max(cam.scale, 0.001);
  placed.forEach((o, index) => {
    const item = catalogItem(o);
    if (!item || !isCheckpoint(item)) return;
    const f = checkpointExport(o.x, o.y, trigOf(o, item));
    if (wx >= f.x - 6 / ppu && wx <= f.x + 16 / ppu && wy >= f.y - 6 / ppu && wy <= f.y + 24 / ppu) out.push({ kind: 'object', index });
  });
  return out;
}
function baseCheckpointAt(wx, wy, badgeOnly = false) {
  const hit = areaHits(wx, wy, badgeOnly).find((h) => h.target.kind === 'base' && baseObjects.find((o) => o.id === h.target.id)?.checkpoint);
  return hit ? baseObjects.find((o) => o.id === hit.target.id) : null;
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

// The level's decoration tiles by cell: layer -> Map(cell key -> [tile name, matrix]).
let decoTileCache = null;
function decoTiles(name) {
  if (!decoTileCache || decoTileCache.state !== draft.baseState || decoTileCache.base !== base) decoTileCache = { state: draft.baseState, base, maps: new Map(), names: null };
  if (!decoTileCache.names) {
    decoTileCache.names = new Map();
    for (const [n, sp] of Object.entries(base.art.tiles)) if (!decoTileCache.names.has(sp)) decoTileCache.names.set(sp, n);
  }
  let m = decoTileCache.maps.get(name);
  if (!m) {
    m = new Map();
    for (const l of base.art.layers) {
      if (l.name !== name || (l.state !== 'always' && l.state !== draft.baseState)) continue;
      for (let i = 0; i < l.runs.length; i += 5) for (let n = 0; n < l.runs[i + 2]; n++) m.set((l.runs[i + 1] + n) + ',' + l.runs[i], [decoTileCache.names.get(l.runs[i + 3]), base.mats[l.runs[i + 4]] || [1, 0, 0, 1]]);
    }
    decoTileCache.maps.set(name, m);
  }
  return m;
}
// The level's decoration cells of one layer by area (16x16 grid cells a bucket), each with its place in the layer's order: a region
// then asks the few buckets it covers instead of walking every decoration cell of the level, and gets them in the layer's own order.
const DECO_BUCKET = 16;
function decoBuckets(name) {
  const cells = decoCells(name);
  const idx = (decoCache.buckets ||= new Map());
  let b = idx.get(name);
  if (!b) {
    b = new Map();
    let i = 0;
    for (const k of cells) {
      const c = k.indexOf(','), gx = +k.slice(0, c), gy = +k.slice(c + 1), bk = Math.floor(gx / DECO_BUCKET) + ',' + Math.floor(gy / DECO_BUCKET);
      let lst = b.get(bk);
      if (!lst) b.set(bk, (lst = []));
      lst.push({ k, i: i++, gx, gy });
    }
    idx.set(name, b);
  }
  return b;
}
// Level decoration whose tile centre sits in the cell box: [{ layer, cells }].
function decoInRegion(r) {
  const a = cellWorld(r.x0, r.y0), b = cellWorld(r.x1 + 1, r.y1 + 1), out = [];
  if (!base?.art) return out;
  for (const name of DECO_LAYERS) {
    const g = layerGrid(name), found = [], buckets = decoBuckets(name);
    // The grid cells whose centre can fall in the box, with a cell to spare each side; the exact test is the same as ever.
    const gx0 = Math.floor((Math.min(a.x, b.x) - g.ox) / g.size) - 1, gx1 = Math.ceil((Math.max(a.x, b.x) - g.ox) / g.size) + 1;
    const gy0 = Math.floor((Math.min(a.y, b.y) - g.oy) / g.size) - 1, gy1 = Math.ceil((Math.max(a.y, b.y) - g.oy) / g.size) + 1;
    for (let by = Math.floor(gy0 / DECO_BUCKET); by <= Math.floor(gy1 / DECO_BUCKET); by++) {
      for (let bx = Math.floor(gx0 / DECO_BUCKET); bx <= Math.floor(gx1 / DECO_BUCKET); bx++) {
        const lst = buckets.get(bx + ',' + by);
        if (!lst) continue;
        for (const e of lst) {
          if (removedDeco.has(name + '|' + e.k)) continue;
          const x = g.ox + (e.gx + 0.5) * g.size, y = g.oy + (e.gy + 0.5) * g.size;
          if (x >= a.x && x < b.x && y >= a.y && y < b.y) found.push(e);
        }
      }
    }
    if (found.length) out.push({ layer: name, cells: found.sort((p, q) => p.i - q.i).map((e) => e.k) });
  }
  return out;
}
// Moving a bit of the level: it is erased from the level and an own copy of it appears (cells dx, dy over). Returns the keys of the copies by kind.
function liftBase(keys, dx = 0, dy = 0) {
  const out = { blocks: [], spikes: [], vines: [] };
  // (Lifted in place, dx and dy are 0 and the shifted key is the key.)
  const shift = dx || dy ? (k) => { const [x, y] = unkey(k); return key(x + dx, y + dy); } : (k) => k;
  for (const k of keys) {
    const h = baseHaz?.get(k);
    if (h && h.kind === 'vine') {
      if (removedVines.has(k)) continue;
      removedVines.add(k);
      const nk = shift(k);
      vines.set(nk, { s: base.defs[h.d].sprite, q: h.q });
      out.vines.push(nk);
      continue;
    }
    if (removed.has(k)) continue;
    const nk = shift(k);
    if (h) {
      removed.add(k);
      spikes.set(nk, { c: h.c === 'spike' && DARK_SPIKE_TILES.has(base.defs[h.d].tile) ? 'dark' : h.c, q: h.q });
      out.spikes.push(nk);
      continue;
    }
    const kind = blueSet.has(k) ? 'blue' : orangeSet.has(k) ? 'orange' : (mossSet.has(k) || groundSet.has(k)) ? 'ground' : null;
    if (!kind) continue;
    removed.add(k);
    blocks.set(nk, kind);
    spikes.delete(nk);
    out.blocks.push(nk);
  }
  return out;
}
// Decoration tiles moved: erased from the level, placed as your own tiles.
function liftDeco(layer, cells, dx, dy) {
  const map = decoTiles(layer), out = [];
  for (const k of cells) {
    const id = layer + '|' + k;
    if (removedDeco.has(id)) continue;
    const t = map.get(k);
    removedDeco.add(id);
    if (!t || !t[0]) continue;
    const c = tileCenter(layer, id), nk = tileKeyAt(layer, c.x + dx * CELL, c.y + dy * CELL);
    tiles.set(nk, { layer, tile: t[0], m: t[1] });
    out.push(nk);
  }
  return out;
}
// Every cell of the level's own in a box: ground, moss, coloured blocks, spikes and vines.
// (Read only: the same list is handed out again while the level's sets are the ones it was made from, which is every step of a drag.)
let baseKeysMemo = null;
function baseKeysIn(x0, y0, x1, y1) {
  if (!baseOn()) return [];
  const m = baseKeysMemo;
  if (m && m.x0 === x0 && m.y0 === y0 && m.x1 === x1 && m.y1 === y1 && m.haz === baseHaz && m.ground === groundSet && m.moss === mossSet && m.blue === blueSet && m.orange === orangeSet) return m.out;
  const out = [];
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const k = key(cx, cy);
    if (baseHaz.has(k) || groundSet.has(k) || mossSet.has(k) || blueSet.has(k) || orangeSet.has(k)) out.push(k);
  }
  baseKeysMemo = { x0, y0, x1, y1, haz: baseHaz, ground: groundSet, moss: mossSet, blue: blueSet, orange: orangeSet, out };
  return out;
}

// Moss first: it grows over the ground's edge cells, and a click there means the moss.
const BASE_SETS = () => [['Moss', mossSet], ['Ground', groundSet], ['Blue blocks', blueSet], ['Orange blocks', orangeSet]];
function baseCellsAt(cx, cy) {
  const k0 = key(cx, cy);
  const h = baseHaz.get(k0);
  if (h?.kind === 'vine' ? removedVines.has(k0) : removed.has(k0)) return null;
  if (h && h.kind !== 'vine') return { kind: 'basecells', cells: [k0], what: 'Spike' };
  if (h && !removedVines.has(k0)) return { kind: 'basecells', cells: [k0], what: 'Vine', vine: true };
  const hit = BASE_SETS().find(([, set]) => set?.has(k0));
  if (!hit) return null;
  // The patch around the click, spreading outward (moss counts corners), up to a bunch's worth: the level's moss and ground are mostly one connected mass.
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
    if (o) { const x = o.hitX ?? o.x, y = o.hitY ?? o.y; rectW(x - o.w / 2, y - o.h / 2, x + o.w / 2, y + o.h / 2); }
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
function clickSelects(wp) {
  const hit = itemAt(wp.x, wp.y);
  return tool === 'select' || hit?.kind === 'mtrig' || (tool !== 'paste' && grabsSelection(wp));
}
function selectTriggerAt(wp) {
  const hit = itemAt(wp.x, wp.y);
  if (hit?.kind !== 'mtrig') return false;
  selection = hit;
  showInDropdown(hit);
  renderConfig();
  requestDraw();
  return true;
}
function selectCheckpointAt(wp) {
  // Painting tools only grab a checkpoint by its badge; Select takes it wherever it is the thing under the cursor.
  const top = itemAt(wp.x, wp.y);
  const hit = top?.kind === 'base' ? baseObjects.find((o) => o.id === top.id && o.checkpoint) : null;
  if (!hit || (tool !== 'select' && baseCheckpointAt(wp.x, wp.y, true)?.id !== hit.id)) return false;
  selection = { kind: 'base', id: hit.id };
  showInDropdown(selection);
  renderConfig();
  requestDraw();
  return true;
}
function selectCanvasTarget(wp, e) {
  if (selectCheckpointAt(wp)) return true;
  if (selectTriggerAt(wp)) { selectDown(e); return true; }
  if (clickSelects(wp)) { selectDown(e); return true; }
  return false;
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
  if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); redoStack = []; trimUndo(); }
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
  const pend = { pan: false, pending: hit, shift: e.shiftKey, sx: e.clientX, sy: e.clientY, start: w };
  if (hit && e.shiftKey && hit.kind !== 'tile' && hit.kind !== 'cell') { drag = pend; return; }
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
  if (hit && hit.kind !== 'tile' && hit.kind !== 'cell') {
    drag = pend;
    return;
  } else {
    const c = cellOf(w.x, w.y);
    const keep = e.shiftKey ? targetsOf(selection) : [];
    if (!e.shiftKey) selection = null;
    drag = { pan: false, region: c, keep };
  }
  renderConfig();
  requestDraw();
}

// A press on something unselected is a click (select it) until it moves, then a box from where it started.
function pendingUp() {
  const { pending: hit, shift } = drag;
  if (shift) toggleInSelection(hit);
  else {
    selection = hit;
    showInDropdown(hit);
    if (hit.kind === 'gate' && hit.course && hit.which !== 'lrespawn') draft.activeCourse = hit.course;
  }
  renderConfig();
  requestDraw();
}

// The dragged selection at an offset from where the drag began: the state of the drag's start, with the selection moved by the whole offset.
function placeSelectionAt(d, dx, dy, cx, cy, fine) {
  applyState(d.before);
  selection = JSON.parse(d.selOrig);
  moveTargets(targetsOf(selection), dx, dy, cx, cy, fine);
}

function selectMove(e) {
  const w = worldAt(e);
  if (drag.pending) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    const keep = drag.shift ? targetsOf(selection) : [];
    if (!drag.shift) selection = null;
    drag = { pan: false, region: cellOf(drag.start.x, drag.start.y), keep };
  }
  if (drag.moveSel) {
    // Rebuilt from the drag's start every time, so what the moving things pass over is only covered, never lost.
    const dx = w.x - drag.start.x, dy = w.y - drag.start.y, fine = e.shiftKey, snap = fine ? 1 : snapV();
    const cx = Math.round(dx / CELL), cy = Math.round(dy / CELL);
    const sig = [Math.round(dx / snap), Math.round(dy / snap), cx, cy].join(',');
    if (sig === (drag.sig ?? '0,0,0,0')) return;
    drag.sig = sig;
    if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); redoStack = []; trimUndo(); }
    placeSelectionAt(drag, dx, dy, cx, cy, fine);
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
    const c = cellOf(w.x, w.y), t = drag.gate, g = gateAt(c.cx, c.cy, t.which);
    const course = courseById(t.course);
    const cur = t.which === 'spawn' ? draft.spawn : t.which === 'lrespawn' ? markerPos(t) : t.which === 'reset' ? course?.resets?.[t.index] : course?.[t.which];
    const put = () => {
      if (t.which === 'spawn') draft.spawn = g;
      else if (t.which === 'reset') { if (course) course.resets[t.index] = g; }
      else if (t.which === 'lrespawn') (draft.levelRespawns ||= {})[t.course] = [g.x, g.y];
      else if (course) course[t.which] = g;
    };
    if (cur && (cur.x !== g.x || cur.y !== g.y)) changed(put);
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
  if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); redoStack = []; trimUndo(); }
  fn();
  saveDraft();
  renderConfig();
}

function placementCfg(item) {
  if (!item) return {};
  const rot = placeRot;
  if (!rot && !placeFlip) return {};
  if (item.zip) {
    const [ex, ey] = item.zip.end, r = rotMatrix(rot);
    return { cfg: { zip: { end: [r[0] * ex + r[1] * ey, r[2] * ex + r[3] * ey] } } };
  }
  return { cfg: { rot: rot * 90, fx: placeFlip || undefined } };
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

// Moves one selected thing (dx, dy in cells for cell content and markers, snap steps for placed things); false for the level's own things.
let extraTiles = [];
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
    // The level's own cells can't be dragged in place: they're lifted out of the level into your map.
    const lifted = liftBase(sel.cells, dx, dy), n = lifted.blocks.length + lifted.spikes.length + lifted.vines.length;
    if (!n) return false;
    if (lifted.blocks.length) Object.assign(sel, { kind: 'blocks', what: sel.what, cells: lifted.blocks });
    else if (lifted.spikes.length) Object.assign(sel, { kind: 'cell', k: lifted.spikes[0] });
    else Object.assign(sel, { kind: 'cell', k: lifted.vines[0], vine: true });
    if (sel.kind !== 'blocks') { delete sel.cells; delete sel.what; }
  } else if (sel.kind === 'decotiles') {
    const ks = liftDeco(sel.layer, sel.cells, dx, dy);
    if (!ks.length) return false;
    Object.assign(sel, { kind: 'tile', key: ks[0] });
    delete sel.cells; delete sel.layer;
    extraTiles.push(...ks.slice(1));
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
    if (sel.which === 'spawn') draft.spawn = moved;
    else if (sel.which === 'lrespawn') (draft.levelRespawns ||= {})[sel.course] = [moved.x, moved.y];
    else courseById(sel.course)[sel.which] = moved;
  } else {
    const inR = (cx, cy) => cx >= sel.x0 && cx <= sel.x1 && cy >= sel.y0 && cy <= sel.y1;
    // The level's own cells and decoration in the box go with it: lifted out of the level, shifted as your own.
    if (baseOn()) liftBase(baseKeysIn(sel.x0, sel.y0, sel.x1, sel.y1), 0, 0);
    const decoMoving = baseOn() ? decoInRegion(sel) : [];
    for (const m of [blocks, spikes, vines]) {
      const moving = cellsIn(m, sel.x0, sel.y0, sel.x1, sel.y1);
      for (const [k] of moving) m.delete(k);
      for (const [, v, x, y] of moving) m.set(key(x + dx, y + dy), v);
    }
    if (!sel.cellsOnly) for (const o of placed) { const c = cellOf(o.x, o.y); if (inR(c.cx, c.cy)) { o.x += dx * CELL; o.y += dy * CELL; } }
    const ids = new Set(), movingTiles = [];
    for (const [k, t, c] of tilesInCells(sel.x0, sel.y0, sel.x1, sel.y1)) {
      if (t.arrow) ids.add(t.arrow);
      else if (layerGrid(t.layer).size === CELL) movingTiles.push([k, t, c]);
    }
    for (const [k] of movingTiles) tiles.delete(k);
    for (const [, t, c] of movingTiles) tiles.set(tileKeyAt(t.layer, c.x + dx * CELL, c.y + dy * CELL), t);
    ids.forEach(moveArrow);
    if (ids.size) rebuildArrowTiles();
    for (const d of decoMoving) liftDeco(d.layer, d.cells, dx, dy);
    const shiftG = (m) => { if (!m) return m; const c = cellOf(m.x, m.y); return inR(c.cx, c.cy) ? { ...m, x: m.x + dx * CELL, y: m.y + dy * CELL } : m; };
    if (!sel.cellsOnly) {
      draft.spawn = shiftG(draft.spawn);
      for (const c of courses()) {
        c.start = shiftG(c.start); c.end = shiftG(c.end);
        if (c.resets) c.resets = c.resets.map(shiftG);
      }
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
// Moves every selected thing: placed things by the snapped world offset, cell content and markers by whole cells; false if nothing moved.
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
      if (t.kind === 'base' && (() => { const o = baseObjects.find((x) => x.id === t.id); return o?.checkpoint && !o.path; })()) { fixed = true; continue; }
      if (sx || sy) { moveLevelThing(t, sx, sy); moved = true; }
    } else if (t.kind === 'moss') {
      const g = layerGrid('moss').size, mx = Math.round((cx * CELL) / g), my = Math.round((cy * CELL) / g);
      if (mx || my) { moveCells(t, mx, my); moved = true; }
    } else if (cx || cy) {
      if (shiftTarget(t, cx, cy, fine)) moved = true; else fixed = true;
    }
  }
  if (fixed) flash('That can\'t be moved.');
  if (extraTiles.length) {
    setSelection([...targets, ...extraTiles.map((k) => ({ kind: 'tile', key: k }))]);
    extraTiles = [];
  }
  return moved;
}
function nudgeSelection(dx, dy, fine) {
  const targets = targetsOf(selection);
  if (!targets.length) return false;
  pushUndo();
  const step = fine ? 1 : snapV();
  const moved = moveTargets(targets, dx * step, dy * step, dx, dy, fine);
  if (!moved) undoStack.pop();
  saveDraft();
  renderConfig();
  requestDraw();
  return moved;
}
// Everything a dragged-out box covers: placed things and markers whose centre is inside, and its cells.
function marqueeTargets(r) {
  const a = cellWorld(r.x0, r.y0), b = cellWorld(r.x1 + 1, r.y1 + 1);
  const inside = (p) => p && p.x >= a.x && p.x < b.x && p.y >= a.y && p.y < b.y;
  const out = [];
  for (const e of stack()) if (inside(e.it) && layerOpen(targetLayer({ kind: e.kind, index: e.index }))) out.push({ kind: e.kind, index: e.index });
  if (layerOpen('course')) triggers.forEach((t, i) => { if (inside(t)) out.push({ kind: 'mtrig', index: i }); });
  if (layerOpen('course')) xspawns.forEach((t, i) => { if (inside(t)) out.push({ kind: 'xspawn', index: i }); });
  if (layerOpen('tiles')) tileIndex.forEachInRect(tiles, a.x - 1, a.y - 1, b.x + 1, b.y + 1, (t, k) => { if (!t.arrow && inside(tileCenter(t.layer, k))) out.push({ kind: 'tile', key: k }); });
  if (baseOn() && layerOpen('level')) {
    for (const o of baseObjects) {
      if (!baseObjectVisible(o) || removedObjects.has(o.id)) continue;
      const x = o.hitX ?? o.x, y = o.hitY ?? o.y;
      // A trigger area goes with the marquee only when its whole box is inside; everything else by its centre.
      if (isBaseArea(o) ? inside({ x: x - o.w / 2, y: y - o.h / 2 }) && inside({ x: x + o.w / 2 - 0.01, y: y + o.h / 2 - 0.01 }) : inside({ x, y })) out.push({ kind: 'base', id: o.id });
    }
    for (const p of sceneList?.items || []) if (p.id && !p.group && p.a !== 0 && !removedScene.has(p.id) && p.reach < 400 && inside(p)) out.push({ kind: 'scene', id: p.id });
  }
  if (!layerLocked('course')) {
    if (inside(draft.spawn)) out.push({ kind: 'gate', which: 'spawn' });
    for (const r of levelRespawns()) if (r.g && inside(r.g)) out.push({ kind: 'gate', which: 'lrespawn', course: r.course });
    for (const c of courses()) for (const which of ['start', 'end', 'screen']) {
      const p = which === 'screen' ? courseScreen(c) : c[which];
      if (inside(p)) out.push({ kind: 'gate', which, course: c.id });
    }
    for (const c of courses()) (c.resets || []).forEach((p, index) => { if (inside(p)) out.push({ kind: 'gate', which: 'reset', course: c.id, index }); });
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
  else if (selection.kind === 'basecells') selection.cells.forEach((k) => (selection.vine ? removedVines : removed).add(k));
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
    for (const [k, t] of tilesInCells(selection.x0, selection.y0, selection.x1, selection.y1)) { tiles.delete(k); if (t.arrow) cut.add(t.arrow); }
    if (cut.size) { arrows = arrows.filter((ar) => !cut.has(ar.id)); rebuildArrowTiles(); }
    for (let cy = selection.y0; cy <= selection.y1; cy++) for (let cx = selection.x0; cx <= selection.x1; cx++) {
      const k = key(cx, cy);
      blocks.delete(k); spikes.delete(k); vines.delete(k);
      if (baseOn() && (groundSet.has(k) || mossSet.has(k) || blueSet.has(k) || orangeSet.has(k) || (baseHaz.get(k) && baseHaz.get(k).kind !== 'vine'))) removed.add(k);
      if (baseOn() && baseHaz.get(k)?.kind === 'vine') removedVines.add(k);
    }
    if (baseOn()) for (const d of decoInRegion(selection)) d.cells.forEach((k) => removedDeco.add(d.layer + '|' + k));
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

// The stack: placed objects, decorations and free spikes in draw order, back to front; new things (no z yet) go on top.
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
  const anchor = cellOf(minOf(xs), minOf(ys)), a = cellWorld(anchor.cx, anchor.cy);
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
    out.push({ kind: 'region', x0: anchorCell.cx + minOf(xs), y0: anchorCell.cy + minOf(ys), x1: anchorCell.cx + maxOf(xs), y1: anchorCell.cy + maxOf(ys), cellsOnly: true });
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
  for (const [, t, c] of tilesInCells(x0, y0, x1, y1)) b.tiles.push({ ...t, dx: c.x - origin.x, dy: c.y - origin.y });
  blocks.forEachIn(x0, y0, x1, y1, (k, kind, cx, cy) => b.blocks.push([cx - x0, cy - y0, kind]));
  spikes.forEachIn(x0, y0, x1, y1, (k, sp, cx, cy) => b.spikes.push([cx - x0, cy - y0, sp]));
  vines.forEachIn(x0, y0, x1, y1, (k, v, cx, cy) => b.vines.push([cx - x0, cy - y0, v]));
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
  { id: 'teleporters', label: 'Teleporters' },
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
  let c = u.cost ?? u.price;
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
  teleporters: { name: 'Activate teleporters' },
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
    if (!o || o.checkpoint || Math.abs(t.x - o.x) > o.w / 2 || Math.abs(t.y - o.y) > o.h / 2) continue;
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
  html += `<div class="mm-config-sub">Base cost is the game's base upgrade cost. Cost is the first price; each next price = ((last + add) ^ power) × scale.</div>`;
    html += `<div class="mm-config-row">${num('up:scale', '× Scale', u.scale, 0.1)}${num('up:add', '+ Add', u.add, 1)}${num('up:power', '^ Power', u.power, 0.05)}</div>`;
    html += `<div class="mm-config-row"><label>Set prices (comma list, overrides the curve)<input class="mm-input" type="text" data-cfg="up:prices" value="${u.prices.join(', ')}" placeholder="e.g. 10, 25, 60"></label></div>`;
    html += `<div class="mm-config-sub">Prices: ${upgradePrices(u, Math.min(u.max, 12)).map(shortNumber).join(', ')}${u.max > 12 ? ' …' : ''}</div>`;
  }
  return html;
}

const LEVEL_TOGGLES = [
  ['wallJump', 'Wall jump'], ['blockSwap', 'Block swap dash'], ['omniDash', 'Omni dash'],
  ['zipMovers', 'Zip movers work'], ['refreshers', 'Refreshers work'], ['teleporters', 'Teleporters work'],
  ['light', 'Personal light'],
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
  const edits = draft.baseEdits?.[o.id] || {};
  const baseCost = edits.baseCost ?? edits.basecost ?? b.baseCost ?? b.basecost ?? b.baseUpgradeCost ?? b.price ?? 10;
  const cost = edits.cost ?? edits.price ?? b.cost ?? b.upgradeCost ?? b.price ?? baseCost;
  return { currency: CURRENCY_ENUM[b.currency] || 'Cash', baseCost, cost, price: cost, scale: b.scale ?? 1.5, add: b.add ?? 0, power: b.power ?? 1, max: b.max ?? 1, prices: [], label: '', ...edits, baseCost: edits.baseCost ?? edits.basecost ?? baseCost, cost: edits.cost ?? edits.price ?? cost };
}
function baseUpgradeHtml(o, num) {
  const u = baseUpgradeConfig(o), edited = !!draft.baseEdits?.[o.id];
  const sel = (id, label, options, value) => `<label>${label}<select class="mm-input" data-cfg="${id}">${options.map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  let html = `<div class="mm-config-row"><label>Label<input class="mm-input" type="text" data-cfg="bu:label" value="${u.label.replace(/"/g, '&quot;')}" placeholder="the game's own"></label>${sel('bu:currency', 'Paid in', CURRENCIES, u.currency)}</div>`;
  html += `<div class="mm-config-row">${num('bu:baseCost', 'Base cost', u.baseCost, 1)}${num('bu:cost', 'Cost', u.cost, 1)}${num('bu:max', 'Max buys', u.max, 1)}</div>`;
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
    u[field] = field === 'max' ? Math.max(1, Math.round(v)) : field === 'baseCost' || field === 'cost' || field === 'add' ? Math.max(0, v) : Math.max(0.001, v);
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
    if (isCheckpoint(item)) {
      more += `<div class="mm-config-row"><label>Belongs to<select class="mm-input" data-cfg="link">${courseLinkOptions(o.course, 'Any course')}</select></label></div>`;
      more += `<div class="mm-config-sub">${isCourseCheckpoint(item) ? 'The game\'s own course checkpoint. ' : ''}Filed under a course, this checkpoint only counts during that course's run; "Any course" always counts.</div>`;
    } else if (LINKABLE(item)) more += `<div class="mm-config-row"><label>Course<select class="mm-input" data-cfg="link">${courseLinkOptions(o.course, 'None')}</select></label></div>`;
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
    html += `<div class="mm-config-title">${o.kind === 'upgrade' ? boxKindName(o) : o.kind === 'trigger' ? areaBadge(o).text.split(' · ')[0].replace(/ ▶.*/, '') : o.label}<span>level ${o.kind === 'upgrade' ? 'upgrade box' : o.kind === 'trigger' ? 'trigger zone' : 'object'}</span></div>`;
    html += actionBar();
    if (o.checkpoint) {
      html += `<div class="mm-config-sub">The game's own checkpoint (trigger ${Math.round(o.w)} x ${Math.round(o.h)}): touching this box sets where the player respawns. ${o.path ? 'Drag it to move it (the flag goes with it); ' : 'This one can\'t be moved; '}its size can't be changed in the game. Delete it to remove it from this map.</div>`;
      html += `<div class="mm-config-row"><label>Belongs to<select class="mm-input" data-cfg="blink">${courseLinkOptions(baseCheckpointCourse(o), 'Any course')}</select></label></div><div class="mm-config-sub">Filed under a course, this checkpoint only counts during that course's run (Navigator).</div>`;
    }
    else {
      if (o.box) html += sec('settings', 'Upgrade', baseUpgradeHtml(o, num) + (o.box.door ? `<div class="mm-config-sub" style="display:block">Opens ${o.box.door.path.includes('Atom') ? 'the atom room\'s gate' : 'the door to the facility\'s lower section'} (the yellow line) - shut until this box is bought, in custom maps too.</div>` : ''));
      html += transformSection() + sec('group', 'Group & layer', groupRow() + levelOrderRow() + stackButtons());
    }
  } else if (selection.kind === 'blocks' || selection.kind === 'moss') {
    html += `<div class="mm-config-title">${selection.what}<span>${selection.cells.length} cell${selection.cells.length === 1 ? '' : 's'} - drag or arrow keys to move</span></div>`;
    html += actionBar();
    if (selection.kind === 'blocks') html += sec('group', 'Group', groupRow());
  } else if (selection.kind === 'decotiles') {
    html += `<div class="mm-config-title">Level decoration<span>${selection.cells.length} tile${selection.cells.length === 1 ? '' : 's'} · ${layerLabel(selection.layer)}</span></div>`;
    html += `<div class="mm-actions"><button class="mm-act mm-act-danger" data-act="delete" title="Delete (Del)">✕</button></div><div class="mm-config-sub">Drag or arrow keys to move: it becomes your own tiles.</div>`;
  } else if (selection.kind === 'basecells') {
    html += `<div class="mm-config-title">${selection.what}<span>level · ${selection.cells.length} cell${selection.cells.length === 1 ? '' : 's'}</span></div>`;
    html += `<div class="mm-actions"><button class="mm-act mm-act-danger" data-act="delete" title="Delete (Del)">✕</button></div><div class="mm-config-sub">Drag or arrow keys to move: it leaves the level and becomes your own ${selection.what === 'Spike' ? 'spike' : selection.vine ? 'vine' : 'blocks'}.</div>`;
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
    } else if (selection.which === 'lrespawn') {
      const r = levelRespawns().find((x) => x.course === selection.course);
      if (!r || !r.g) { selection = null; el.hidden = true; return; }
      html += `<div class="mm-config-title">Level course ${r.course} respawn<span>where a failed run respawns</span></div>`;
      html += `<div class="mm-config-sub">The level course's own respawn point. Drag it to move it; Delete removes it, and a failed run then respawns at your last checkpoint.</div>`;
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
    if (!cs.game) html += `<div class="mm-config-row"><button class="mm-tool" data-repick>Pick picture again…</button></div>`;
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
  el.querySelector('[data-repick]')?.addEventListener('click', async () => {
    const cs = csprites[selection?.index];
    if (cs?.image) repickImage(cs.image);
  });
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
  if (id === 'blink') return applyBaseCheckpointLink(inp.value);
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

function applyBaseCheckpointLink(raw) {
  const o = baseObjects.find((x) => x.id === selection?.id);
  if (!o?.checkpoint) return;
  pushUndo();
  const edits = { ...(draft.baseEdits || {}) };
  if (raw) edits[o.id] = { course: raw }; else delete edits[o.id];
  draft.baseEdits = edits;
  saveDraft(); renderConfig(); requestDraw();
}
function applyCourseConfig(id, raw) {
  pushUndo();
  if (id === 'link') {
    const o = placed[selection.index];
    if (raw) o.course = raw; else delete o.course;
  } else if (id === 'gatecourse') {
    const from = courseById(selection.course), which = selection.which, g = from?.[which];
    if (which === 'lrespawn' || !g) return;
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
  syncDraft();
  const { name, description, useBase, baseState, blocks: b, spikes: sp, vines: v, tiles: t, moss: mo, arrows: ar, placed: pl, freeSpikes: fs, signs: sg, triggers: tg, csprites: cs2, removed: r, removedVines: rv, removedObjects: ro, removedScene: rs, removedDeco: rd, movedScene: ms, movedObjects: mob, levelOrder: lo, levelTf: ltf, levelGroups: lg, courses: cs, baseEdits: be, levelRespawns: lr, spawn, player, ownProgress, music, background, assets, stageEdits, cellGroups: cg, hiddenGroups, xspawns: xs } = draft;
  return { version: 1, name, description, useBase, baseState, blocks: b, spikes: sp, vines: v, tiles: t, moss: mo, arrows: ar, placed: pl, freeSpikes: fs, signs: sg, triggers: tg, csprites: cs2, removed: r, removedVines: rv, removedObjects: ro, removedScene: rs, removedDeco: rd, movedScene: ms, movedObjects: mob, levelOrder: lo, levelTf: ltf, levelGroups: lg, courses: cs, baseEdits: be, levelRespawns: lr, spawn, player, ownProgress, music, background, assets, stageEdits, cellGroups: cg, hiddenGroups, xspawns: xs };
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
  const show = (html) => { list.innerHTML = html; };
  show('<div class="mm-config-sub">Loading…</div>');
  let maps = [];
  try { maps = await window.__TAURI__.core.invoke('list_maps'); } catch (e) { show(`<div class="mm-config-sub mm-warn">Couldn't list installed maps: ${e}</div>`); return; }
  maps = maps.filter((m) => !isTestMap(m));
  if (!maps.length) { show('<div class="mm-config-sub">No maps installed.</div>'); return; }
  show(maps.map((m) => `<button class="mm-tool mm-load-item" data-id="${m.id}" title="${(m.description || '').replace(/"/g, '&quot;')}">${m.name || m.id}<span>${isTestMap(m) ? 'last test' : m.id}</span></button>`).join(''));
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
  // A v2-editor map opens here too: its tiles live in `tileLayers` (no v1 field) and its editor state is v2's own, so both are converted (see fromv2.js); the level data loads first since each layer has its own grid.
  if (isV2(map)) {
    try {
      if (!base) await loadBase(true);
    } catch (err) {
      flash('Couldn\'t load the level data to convert that map: ' + err, true);
      return;
    }
    try {
      // layerGrid, plus the matrices - the tiles' runs index those.
      const gridOf = (name) => ({ ...layerGrid(name), mats: base?.mats });
      // Thorn vines are pictures of their own, not atlas sprites.
      const vineSprites = base.defs.filter((d) => d.kind === 'vine').map((d) => d.sprite);
      map = { ...map, editor: toV1State(map, gridOf, vineSprites) };
    } catch (err) {
      flash('Couldn\'t convert that v2 map: ' + err, true);
      return;
    }
    flash('Converted a v2 map to v1\'s format. Anything v1 has no field for is left out, so save a copy if you want the original.');
  }
  const st = map.editor;
  if (!st) { flash('That map wasn\'t made in this editor (no editor data in it).', true); return; }
  pushUndo();
  Object.assign(draft, { blocks: {}, spikes: {}, vines: {}, tiles: {}, moss: {}, arrows: [], placed: [], freeSpikes: [], signs: [], triggers: [], csprites: [], xspawns: [], cellGroups: {}, hiddenGroups: [], music: undefined, background: undefined, stageEdits: undefined, courses: [], baseEdits: {}, levelRespawns: st.levelRespawns || {}, start: null, end: null, player: { ...DEFAULT_PLAYER }, ownProgress: false, removed: [], removedVines: [], removedObjects: [], removedScene: [], removedDeco: [], movedScene: {}, movedObjects: {}, levelOrder: {}, levelTf: {}, levelGroups: {} }, st);
  if (draft.useBase && !base) { try { await loadBase(true); } catch { draft.useBase = false; } }
  // Built from the draft in memory, not saved-then-read-back: a big converted map doesn't fit localStorage, and saving would throw and leave the old draft.
  loadDraftFrom(null);
  clearDraftOff(); // the map came from a file: the lost-draft note has nothing to warn about
  await flushDraft();
  applyBaseState();
  selection = null;
  saveDraft();
  syncBaseUi();
  draft.savedId = installedId && installedId !== TEST_MAP_ID ? installedId : null;
  draft.mapUid = typeof map.uid === 'string' && map.uid ? map.uid : undefined; // an older map gets its id on its next save
  // A folder copied from another map keeps that map's id; a map sharing its id with another installed folder gets one of its own on its next save.
  if (draft.mapUid && window.__TAURI__?.core?.invoke) {
    try { if (uidIsShared(await window.__TAURI__.core.invoke('list_maps'), draft.savedId, draft.mapUid)) draft.mapUid = undefined; } catch { /* listing unavailable: keep the id */ }
  }
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

// The plate set of the ground sheets (the riveted plate, tiles 56-72). The panel and the grate set have a piece of their
// own for a lone cell and for a 1-wide run (single, v, h), but the plate set has none in the sheet: the strips of these
// sheets (0, 8, 16, 26, 27, 28, 29) are the bevel set's, a different art. A 1-wide run of plate is therefore cut into
// quarters (see tiling.js) - the closest thing to the game's own art until the sheet gets a strip of its own.
const PLATE = { TL: 56, T: 57, TR: 58, L: 63, C: 64, R: 65, BL: 70, B: 71, BR: 72, style: 'plate', inner: INNER_PLATE };
const PLATE3 = { TL: 0, T: 1, TR: 2, L: 3, C: 4, R: 5, BL: 6, B: 7, BR: 8 };
const PLATE3_RAIL = { ...PLATE3, rail: true }; // FLOOR V2: a bar along the top
// The level's other block tilesets, each autotiled on its own game tilemap like ground is.
// footTiles: where a rail meets a wall going up, the level uses the ground sheet's rail-end / rounded-rim pieces (22 for a wall
// to the north-east, 23 to the north-west) on the cell at the wall's foot. The Asset floors use their own inside-corner tile there:
// the ground sheet's pieces are a different art and drew a flat square where a Light floor pillar meets a floor.
const FOOT = (family) => ({ NE: family + '22', NW: family + '23' });
const ASSET_PLATE = (tl, l, bl, bar, inner, foot) => ({ TL: tl, T: tl + 1, TR: tl + 2, L: l, C: l + 1, R: l + 2, BL: bl, B: bl + 1, BR: bl + 2, ...(bar ? { h: [bar, bar + 1, bar + 2], ...(tl < 200 ? { rail: true } : {}) } : {}), ...(inner ? { inner: INNER_TURNED(inner) } : {}), ...(foot ? { foot: FOOT(foot) } : {}) });
const BLOCK_SETS = {
  panel: { label: 'Panel', group: 'Solid', layer: 'ground', family: 'ground1_tileset_', plate: PANEL_SET, thumb: 'ground1_tileset_6', color: '#55584f' },
  darkpanel: { label: 'Dark panel', group: 'Solid', layer: 'ground', family: 'dark_ground_tileset_', plate: PANEL_SET, thumb: 'dark_ground_tileset_6', color: '#3a3c40' },
  grate: { label: 'Grate', group: 'Solid', layer: 'ground', family: 'gril_tileset_', plate: GRATE_SET, thumb: 'gril_tileset_0', color: '#5d6160' },
  plate: { label: 'Plate', group: 'Solid', layer: 'ground', family: 'TILE V2 Tileset_', plate: PLATE3, thumb: 'TILE V2 Tileset_4', color: '#50534c' },
  floorplate: { label: 'Floor plate', group: 'Solid', layer: 'ground', family: 'FLOOR V2 Tileset_', plate: PLATE3_RAIL, thumb: 'FLOOR V2 Tileset_1', color: '#50534c' },
  lightplate: { label: 'Light plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(241, 253, 265, 186, 210), thumb: 'Asset_Sheet_254', color: '#6a6c68' },
  lightfloor: { label: 'Light floor plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(192, 211, 226, 186, 210), thumb: 'Asset_Sheet_193', color: '#6a6c68' },
  darkplate: { label: 'Dark plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(238, 250, 262, 235, 206), thumb: 'Asset_Sheet_251', color: '#35373a' },
  darkfloor: { label: 'Dark floor plate', group: 'Solid', layer: 'ground', family: 'Asset_Sheet_', plate: ASSET_PLATE(189, 207, 223, 235, 206), thumb: 'Asset_Sheet_190', color: '#35373a' },
  blueplate: { label: 'Blue plate', group: 'Colour swap', layer: 'blueBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(229, 244, 256, 220, 195), thumb: 'Asset_Sheet_245', color: COLORS.blue },
  bluefloor: { label: 'Blue floor plate', group: 'Colour swap', layer: 'blueBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(180, 196, 214, 220, 195), thumb: 'Asset_Sheet_181', color: COLORS.blue },
  orangeplate: { label: 'Orange plate', group: 'Colour swap', layer: 'orangeBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(232, 247, 259, 203, 199), thumb: 'Asset_Sheet_248', color: COLORS.orange },
  orangefloor: { label: 'Orange floor plate', group: 'Colour swap', layer: 'orangeBlocks', family: 'Asset_Sheet_', plate: ASSET_PLATE(183, 200, 217, 203, 199), thumb: 'Asset_Sheet_184', color: COLORS.orange },
  breakable: { label: 'Breakable ground', group: 'Overgrowth', layer: 'OvergrowthDestroyedGround', family: 'ground1_tileset_', plate: PLATE, thumb: 'ground1_tileset_59', color: '#6b5d48' },
  illusory: { label: 'Illusory wall', group: 'Walk-through', layer: 'Ilusorywalls', family: 'ground1_tileset_', plate: PLATE, thumb: 'ground1_tileset_59', color: 'rgba(74, 77, 68, 0.55)' },
  bgwall: { label: 'Background wall', group: 'Walk-through', layer: 'Background', family: 'TILE V2 Tileset_', plate: PLATE3, thumb: 'TILE V2 Tileset_4', color: '#26282b' },
  bgfloor: { label: 'Background floor plate', group: 'Walk-through', layer: 'Background', family: 'FLOOR V2 Tileset_', plate: PLATE3_RAIL, thumb: 'FLOOR V2 Tileset_1', color: '#26282b' },
  bgplate: { label: 'Background dark plate', group: 'Walk-through', layer: 'Background', family: 'Asset_Sheet_', plate: ASSET_PLATE(238, 250, 262, 235, 206), thumb: 'Asset_Sheet_251', color: '#1d1e21' },
  bglight: { label: 'Background ground', group: 'Walk-through', layer: 'Background', family: 'ground1_tileset_', plate: PLATE, thumb: 'ground1_tileset_59', color: '#2c2e2a' },
  bgdark: { label: 'Dark background ground', group: 'Walk-through', layer: 'Background', family: 'dark_ground_tileset_', plate: PLATE, thumb: 'dark_ground_tileset_59', color: '#1d1e21' },
};
const blockName = (kind) => BLOCK_NAMES[kind] || BLOCK_SETS[kind]?.label || 'Blocks';
function blockArt(kind, cx, cy) {
  if (isGround(kind)) return groundTile(cx, cy, kind === 'dark');
  const set = BLOCK_SETS[kind];
  if (set) return base?.art ? plateTile(set.layer, set.family, set.plate, joinSolid(kind), cx, cy, joinStyle(kind)) : null;
  return colouredTile(kind, cx, cy);
}
const isGround = (kind) => kind === 'ground' || kind === 'dark';

function groundTile(cx, cy, dark = false) {
  if (!base?.art) return null;
  return plateTile('ground', dark ? 'dark_ground_tileset_' : 'ground1_tileset_', PLATE, joinSolid(dark ? 'dark' : 'ground'), cx, cy, joinStyle(dark ? 'dark' : 'ground'));
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

// What a kind of block joins with: the level's cells of the same tileset in the same tilemap, and your own blocks of
// any kind on that tileset (ground and panel are both ground1, so they run together; ground and dark do not, like in
// the level, where a grate or a dark block next to ground gets an edge). The Asset_Sheet plates are one set each.
// MERGE tiles: the ground sheets (ground1, dark) hold pieces where a riveted-plate edge (tiles 56-72, 'plate') turns into
// a rail / bevel edge (tiles 1-19, 'rail') along the same side. Read off the level: 73 sits between a plate top edge on
// its west and a rail top edge on its east, 74 the other way round; 77/78 the same on a bottom edge (78: rail west, plate
// east); 75/76 on a left / right edge with the plate above and the rail below, 79/80 with the rail above. So a rail edge
// cell with a plate edge cell beside it along the edge is drawn as the merge tile that starts with that plate.
const MERGE = {
  'ground1_tileset_': { T: { W: 73, E: 74 }, B: { W: 77, E: 78 }, L: { N: 75, S: 79 }, R: { N: 76, S: 80 } },
  'dark_ground_tileset_': { T: { W: 73, E: 74 }, B: { W: 77, E: 78 }, L: { N: 75, S: 79 }, R: { N: 76, S: 80 } },
};
const MERGE_STEP = { W: [-1, 0], E: [1, 0], N: [0, 1], S: [0, -1] };
const OPEN_SIDE = { T: [0, 1], B: [0, -1], L: [-1, 0], R: [1, 0] };
const tileStyle = (id) => (id >= 56 && id <= 72 ? 'plate' : id >= 1 && id <= 19 ? 'rail' : null);
const joinInfos = new Map();
function joinInfo(kind) {
  let j = joinInfos.get(kind);
  if (j) return j;
  const set = BLOCK_SETS[kind];
  if (kind === 'ground' || kind === 'dark') j = { layer: 'ground', family: kind === 'dark' ? 'dark_ground_tileset_' : 'ground1_tileset_' };
  else if (kind === 'blue' || kind === 'orange') j = { layer: kind + 'Blocks', family: kind + '_ground_tileset_' };
  else if (set) j = { layer: set.layer, family: set.family, ...(set.family === 'Asset_Sheet_' ? { only: kind, names: new Set(Object.values(set.plate).flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v).map((p) => (typeof p === 'object' ? p.id : p)) : [v])).map((id) => set.family + id)) } : {}) };
  else j = { layer: 'ground', family: kind };
  j.id = j.layer + '|' + (j.only || j.family);
  joinInfos.set(kind, j);
  return j;
}
// The level's cells (editor cell keys) of a tileset in a tilemap, from its drawn tiles; built once per base state.
let levelJoinCache = null;
function levelJoinCells(j) {
  if (!levelJoinCache) levelJoinCache = new Map();
  let cells = levelJoinCache.get(j.id);
  if (cells) return cells;
  cells = new Set();
  cells.ids = new Map(); // key -> the level tile's number in its sheet, for the merge pieces
  cells.layers = new Map(); // key -> the level tilemap (art layer) the cell is on
  cells.names = new Map(); // key -> the level tile's name
  const names = tileNames();
  const layerName = j.layer === 'ground' ? 'new awesome nikki ground' : j.layer;
  // The block's own tilemap, and the level's decoration tilemaps: a rail strip or plate there is part of the same shape.
  for (const l of base.art.layers || []) {
    if ((l.name !== layerName && !ENV_LAYERS.includes(l.name)) || (l.state !== 'always' && l.state !== draft.baseState)) continue;
    const shift = artShift(l);
    for (let i = 0; i < l.runs.length; i += 5) {
      const name = names[l.runs[i + 3]];
      // On the ground tilemap every ground tileset is one shape with your blocks (a wall of the level beside your block is
      // part of it, whatever sheet it is drawn from); elsewhere only the block's own sheet.
      const anyGround = j.layer === 'ground' && l.name === layerName && GROUND_FAMILIES.some((f) => name?.startsWith(f));
      if (!name || !(anyGround || (j.names ? j.names.has(name) : name.startsWith(j.family)))) continue;
      for (let n = 0; n < l.runs[i + 2]; n++) {
        const ck = key(l.runs[i + 1] + n + shift.x, l.runs[i] + shift.y);
        if (cells.has(ck) && cells.layers.get(ck) === layerName) continue;
        cells.add(ck); cells.ids.set(ck, +name.slice(name.lastIndexOf('_') + 1) || 0); cells.layers.set(ck, l.name); cells.names.set(ck, name);
      }
    }
  }
  levelJoinCache.set(j.id, cells);
  return cells;
}
// The first block placed next to the level asks for the level's cells of its tileset (a walk over the level's whole art, ~70 ms), which
// was felt as a stall on that first click. They are worked out in the quiet after the level loads instead, one tileset at a time.
let joinWarmTimer = 0;
function warmLevelJoin() {
  if (IN_WORKER || typeof setTimeout === 'undefined') return;
  clearTimeout(joinWarmTimer);
  const kinds = ['ground', 'dark', 'blue', 'orange'];
  const step = () => {
    joinWarmTimer = 0;
    if (!baseOn() || !base?.art) return;
    const kind = kinds.shift();
    if (!kind) { levelRails(); return; }
    levelJoinCells(joinInfo(kind));
    joinWarmTimer = setTimeout(step, 60);
    joinWarmTimer.unref?.();
  };
  joinWarmTimer = setTimeout(step, 1200);
  joinWarmTimer.unref?.();
}
// An art layer's rows and columns are on its own grid (ground: origin (0, -23)); the editor's cells are on the 32px grid
// shifted by OFFSET_Y, so a layer's cell (col, row) is the editor cell (col + shift.x, row + shift.y): one row lower on these.
const artShift = (l) => ({ x: Math.floor((l.ox + CELL / 2) / CELL), y: Math.floor((l.oy + CELL / 2 - OFFSET_Y) / CELL) });
// The plain pieces of the ground sheets: bevel / rail edges 1-3 9-11 17-19, centre 10, and the plate set 56-58 63-65 70-72.
const PLAIN_PIECE = new Set([1, 2, 3, 9, 10, 11, 17, 18, 19, 56, 57, 58, 63, 64, 65, 70, 71, 72]);
const GROUND_FAMILIES = ['ground1_tileset_', 'dark_ground_tileset_', 'gril_tileset_'];
const ENV_LAYERS = ['Environmental objects', 'Environmental objects_back', 'environmentalObjects_front'];
let tileNameList = null;
const tileNames = () => { if (!tileNameList || tileNameList.of !== base) { const l = []; for (const [n, s] of Object.entries(base.art.tiles)) l[s] = n; l.of = base; tileNameList = l; } return tileNameList; };
// The level's rail strips (the bar along a block's top, on the ground or a decoration tilemap), key -> layer: the level
// sets plate blocks straight on them, with no bottom edge between, so a block of yours above one is joined to it.
const RAIL_TOP = /^(?:(?:ground1|dark_ground|blue_ground|orange_ground)_tileset_[123]|Asset_Sheet_(?:18[0-9]|19[0-4]|203|204|205|22[0-2]|235|236|237)|FLOOR V2 Tileset_[012])$/;
let railCache = null;
function levelRails() {
  if (railCache && railCache.of === base && railCache.state === draft.baseState) return railCache.cells;
  const cells = new Map(), names = tileNames();
  for (const l of base.art.layers || []) {
    if ((l.name !== 'new awesome nikki ground' && !ENV_LAYERS.includes(l.name)) || (l.state !== 'always' && l.state !== draft.baseState)) continue;
    const shift = artShift(l);
    for (let i = 0; i < l.runs.length; i += 5) {
      if (!RAIL_TOP.test(names[l.runs[i + 3]] || '')) continue;
      for (let n = 0; n < l.runs[i + 2]; n++) cells.set(key(l.runs[i + 1] + n + shift.x, l.runs[i] + shift.y), l.name);
    }
  }
  railCache = { of: base, state: draft.baseState, cells };
  return cells;
}
// Is a level cell on `layerName` at key k erased by you?
const levelCellGone = (layerName, k) => (layerName === 'new awesome nikki ground' || layerName === 'blueBlocks' || layerName === 'orangeBlocks' ? removed.has(k) : removedDeco.has(layerName + '|' + k));
// (x, y) -> is that cell part of the same tileset as a `kind` block: yours or the level's. `below`: the cell is in the row under
// the one being tiled, where a level rail strip also counts.
function joinSolid(kind) {
  if (exportGrid) return exportGrid.solid(kind);
  const j = joinInfo(kind), level = baseOn() && base?.art ? levelJoinCells(j) : null;
  const rails = level ? levelRails() : null;
  return (x, y, below) => {
    const k = key(x, y), own = blocks.get(k);
    // Your blocks on the same tilemap are one shape whatever sheet each is drawn from (a rail-topped ledge with a plate block
    // hanging under it is one block, not two).
    if (own !== undefined) return joinInfo(own).layer === j.layer;
    if (!level) return false;
    if (level.has(k)) return !levelCellGone(level.layers.get(k), k);
    return !!below && rails.has(k) && !levelCellGone(rails.get(k), k);
  };
}

// The level's own cells within one cell of your blocks, re-tiled with the combined shape (level + yours) so the two read as
// one block instead of two outlines at the seam. They are not your blocks: nothing lists or counts them, and they come and
// go with the blocks beside them. Drawn over the level's baked art (which is hidden there) and exported as a tile painted
// at that same cell, which the game puts in place of the level's own.
let overrideCache = null, hiddenInWorker = null;
// While a level cell is being re-tiled, any block of yours on its tilemap is part of its shape, whatever its sheet.
let tilingLevelCell = false;
// The level cells a connector may be drawn on: the ones whose neighbours that supply its clean lines are re-tiled too.
let levelConnectorCells = null;
// Cells of the level's art not drawn (replaced by a re-tiled one); a worker is told the set instead of working it out.
const hiddenLevel = () => (!blocks.size && hiddenInWorker) || levelOverrides().hide;
const NO_OVERRIDES = { cells: new Map(), hide: new Set() };
// The eight neighbours of a cell.
const AROUND8 = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, -1], [-1, 1]];
// The sheet a level tile is drawn from: 'ground1_tileset_65' -> 'ground1_tileset'.
const sheetOf = (name) => { const n = name || '', i = n.lastIndexOf('_'); return i < 0 ? n : n.slice(0, i); };
// The cells that supply a connector's clean lines: the wall beside the gap and the floor under it.
const connectorSources = (o, hole) => {
  const ns = hole[0] === 'N' ? [[0, 1]] : [[0, -1]], ew = hole[1] === 'E' ? [[1, 0]] : [[-1, 0]];
  return [...ns, ...ew].map(([dx, dy]) => key(o.cx + dx, o.cy + dy));
};
function innerDiag(fam, id) {
  for (const set of Object.values(BLOCK_SETS)) {
    if (set.family !== fam) continue;
    const inner = set.plate?.inner;
    if (!inner) continue;
    for (const [d, v] of Object.entries(inner)) {
      const tid = typeof v === 'number' ? v : (v && typeof v === 'object' ? v.id : null);
      if (tid === id) return d;
    }
  }
  return null;
}

function levelOverrides() {
  if (!baseOn() || !base?.art || !blocks.size) return NO_OVERRIDES;
  const c = overrideCache;
  if (c && c.blocks === blocks && c.removed === removed && c.base === base && c.version === baseVersion && c.state === draft.baseState && c.rev === blocks.rev + '|' + removed.rev) return c.value;
  const cells = new Map(), hide = new Set();
  const rails = levelRails();
  // A level cell as a block of its own sheet: the piece it has, and whether it is a special one.
  const asBlock = (nk, level, kind, isRail) => {
    const nm = level.names.get(nk) || '', fam = GROUND_FAMILIES.find((f) => nm.startsWith(f));
    // Re-tiling must not make a level cell worse: its special pieces (a rail's end cap, a fillet, an inside corner, a merge
    // piece, a decorated tile) keep their own art; only the plain edge / corner / centre pieces are re-tiled.
    const special = isRail || (fam && !PLAIN_PIECE.has(level.ids.get(nk)));
    const own = fam && fam !== 'gril_tileset_' ? tileStyle(level.ids.get(nk)) : null;
    // keep the level cell's own style (plate or rail) where the sheet has both
    const as = fam === 'gril_tileset_' ? 'grate' : own ? (fam === 'dark_ground_tileset_' ? (own === 'plate' ? 'dark' : 'darkpanel') : (own === 'plate' ? 'ground' : 'panel')) : (fam ? (fam === 'dark_ground_tileset_' ? 'dark' : 'ground') : kind);
    const [cx, cy] = unkey(nk);
    return { kind: as, cx, cy, onLayer: level.layers.get(nk), special, fam, id: level.ids.get(nk), name: nm };
  };
  // The art a level cell takes in the combined shape: the sheet's own piece for it, an edge or a corner too, not only a centre.
  const artOf = (o) => {
    tilingLevelCell = true;
    try {
      const art = blockArt(o.kind, o.cx, o.cy);
      // A special piece (rail strip, end cap, fillet) stays unless it is buried: all eight neighbours solid, then it is interior.
      // A cell next to a rail with one corner open (where a rail runs out of the mass) gets the level's own foot piece, the
      // rounded fillet 22 / 23, as the level does where a rail meets a wall; no other special cell is re-tiled.
      const solid = joinSolid(o.kind);
      const buried = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]].every(([ax, ay]) => solid(o.cx + ax, o.cy + ay, ay < 0));
      const foot = (side, tileNo) => o.fam && solid(o.cx + side, o.cy, false) && rails.has(key(o.cx + side, o.cy)) && !solid(o.cx + side, o.cy + 1) && solid(o.cx, o.cy + 1) && solid(o.cx, o.cy - 1) && solid(o.cx - side, o.cy) && solid(o.cx - side, o.cy + 1) && solid(o.cx + side, o.cy - 1) && solid(o.cx - side, o.cy - 1) ? o.fam + tileNo : null;
      const footTile = foot(1, 22) || foot(-1, 23);
      // A rail's end cap (4 / 5, bevel 1 / 3) whose capped side now has something solid against it is no longer an end: the
      // rail runs on into it, as a plain rail edge.
      const id = o.id, capSide = id === 5 || id === 3 ? 1 : id === 4 || id === 1 ? -1 : 0;
      const runsOn = o.fam && o.fam !== 'gril_tileset_' && capSide && solid(o.cx + capSide, o.cy, false) && !solid(o.cx, o.cy + 1, false);
      const capReverse = o.fam && o.fam !== 'gril_tileset_' && capSide && !solid(o.cx + capSide, o.cy, false) && solid(o.cx - capSide, o.cy, false) && !solid(o.cx, o.cy + 1, false);
      const reversedCap = capSide > 0 ? (id === 5 ? 4 : id === 3 ? 1 : id) : capSide < 0 ? (id === 4 ? 5 : id === 1 ? 3 : id) : id;
      const isFillet = id === 22 || id === 23;
      const filletMirror = isFillet && !footTile && solid(o.cx + (id === 22 ? -1 : 1), o.cy, false) && !solid(o.cx, o.cy + 1, false);
      const mirroredFillet = id === 22 ? 23 : 22;
      const diag = innerDiag(o.fam, id);
      const diagFilled = !!diag && solid(o.cx + (diag[1] === 'E' ? 1 : -1), o.cy + (diag[0] === 'N' ? 1 : -1), diag[0] === 'S');
      if (runsOn) return { layer: art?.layer || 'ground', tile: o.fam + '2', matrix: [1, 0, 0, 1], centre: true };
      if (capReverse && reversedCap !== id) return { layer: art?.layer || 'ground', tile: o.fam + reversedCap, matrix: [1, 0, 0, 1], centre: true };
      if (footTile) return { layer: art?.layer || 'ground', tile: footTile, matrix: [1, 0, 0, 1], centre: true };
      if (filletMirror) return { layer: art?.layer || 'ground', tile: o.fam + mirroredFillet, matrix: [1, 0, 0, 1], centre: true };
      if (o.special && diagFilled) return blockArt(o.kind, o.cx, o.cy) || art;
      if (o.special && !buried) { dbgLog('levelOverrides: skipped special piece ' + o.id + ' at ' + key(o.cx, o.cy)); return null; }
      if (o.special) { o.kind = o.kind === 'panel' ? 'ground' : o.kind === 'darkpanel' ? 'dark' : o.kind; return blockArt(o.kind, o.cx, o.cy); } // buried: the plate interior, like the mass around it
      return art;
    } finally { tilingLevelCell = false; }
  };
  // The level cells beside your blocks: each is re-tiled with the combined shape.
  const wanted = new Map();
  blocks.forEach((kind, k) => {
    if (!isGround(kind) && !BLOCK_SETS[kind] && kind !== 'blue' && kind !== 'orange') return;
    const j = joinInfo(kind), level = levelJoinCells(j);
    const [cx, cy] = unkey(k);
    for (const [dx, dy] of AROUND8) {
      const nk = key(cx + dx, cy + dy);
      if (blocks.has(nk) || wanted.has(nk) || !level.has(nk) || levelCellGone(level.layers.get(nk), nk)) continue;
      // a block set on a rail strip: the strip keeps its own art, unless buried
      wanted.set(nk, asBlock(nk, level, kind, dy === -1 && rails.has(nk)));
    }
  });
  // Re-tiling a level cell changes its neighbours' shapes, so the walk goes on over the ring around it: a few passes only,
  // with the cells it has been through marked, or the level would oscillate between two shapes.
  const done = new Set();
  let ring = [...wanted.keys()];
  for (let pass = 0; pass < 3 && ring.length; pass++) {
    const next = [];
    for (const nk of ring) {
      done.add(nk);
      const o = wanted.get(nk), art = artOf(o);
      if (!art) continue;                                 // a special piece keeps the level's own art
      o.art = art;
      if (!art.parts && art.tile === o.name) continue;     // the level's own piece is right: its art stays
      cells.set(nk, o);
      // the ring around a re-tiled cell: a neighbour of the same sheet may have changed shape too
      const level = levelJoinCells(joinInfo(o.kind));
      for (const [dx, dy] of AROUND8) {
        const nk2 = key(o.cx + dx, o.cy + dy);
        if (done.has(nk2) || wanted.has(nk2) || blocks.has(nk2) || !level.has(nk2) || levelCellGone(level.layers.get(nk2), nk2)) continue;
        if (sheetOf(level.names.get(nk2)) !== sheetOf(o.name)) continue;   // another sheet is its own shape
        wanted.set(nk2, asBlock(nk2, level, o.kind, rails.has(nk2)));
        next.push(nk2);
      }
    }
    ring = next;
  }
  // A connector is safe only where the cells that supply its clean lines are re-tiled too: the wall beside the gap and the
  // floor under it. Where they are not, the plain piece is drawn and the notch is left as the level has it.
  levelConnectorCells = new Set(cells.keys());
  for (const [nk, o] of cells) {
    const holes = o.art.holes;
    if (!holes?.length || !holes.every((d) => connectorSources(o, d).every((k2) => cells.has(k2)))) continue;
    const art = artOf(o);
    if (art) o.art = art;
  }
  levelConnectorCells = null;
  for (const [nk, o] of cells) {
    // painted on the tilemap the level cell is on (a decoration tilemap, maybe), and its baked art hidden there
    if (o.onLayer && !(o.onLayer === 'new awesome nikki ground' && o.art.layer === 'ground')) o.art = { ...o.art, layer: o.onLayer === 'new awesome nikki ground' ? 'ground' : o.onLayer };
    hide.add(o.onLayer + '|' + nk);
  }
  const value = { cells, hide };
  overrideCache = { blocks, removed, base, version: baseVersion, state: draft.baseState, rev: blocks.rev + '|' + removed.rev, value };
  return value;
}

// (x, y) -> 'plate' | 'rail' | null: the style of the solid cell there, for a kind's tileset.
function joinStyle(kind) {
  if (exportGrid) return exportGrid.style(kind);
  const j = joinInfo(kind), level = baseOn() && base?.art && MERGE[j.family] ? levelJoinCells(j) : null;
  return (x, y) => {
    const k = key(x, y), own = blocks.get(k);
    if (own !== undefined) return joinInfo(own).id === j.id ? ownStyle(own) : null;
    return level?.has(k) && level.names.get(k)?.startsWith(j.family) ? tileStyle(level.ids.get(k)) : null;
  };
}
const ownStyle = (kind) => (kind === 'ground' || kind === 'dark' ? 'plate' : BLOCK_SETS[kind]?.plate?.style || null);

function plateTile(layer, family, plate, solid, cx, cy, styleAt) {
  const name = (piece) => family + plate[piece];
  const id = [1, 0, 0, 1];
  const resolve = (piece) => {
    if (piece[0] === 'v' && piece.length === 2 && plate.v) return { tile: family + plate.v[piece[1]], matrix: id };
    if (piece[0] === 'h' && piece.length === 2 && plate.h) return { tile: family + plate.h[piece[1]], matrix: id };
    if (piece === 'single') return { tile: family + plate.single, matrix: id };
    return usedPiece(layer, family, plate, piece);
  };
  const r = pickPieces(plate, (dx, dy) => solid(cx + dx, cy + dy, dy < 0));
  if (styleAt && !tilingLevelCell && plate.style === 'rail' && MERGE[family] && /^[TBLR]$/.test(r.whole || '') && !r.holes) {
    const [ox, oy] = OPEN_SIDE[r.whole];
    // First pass: symmetric merge for runs (plate | rail | rail  OR  rail | rail | plate)
    for (const [dir, tileNo] of Object.entries(MERGE[family][r.whole])) {
      const [dx, dy] = MERGE_STEP[dir], nx = cx + dx, ny = cy + dy, rx = cx - dx, ry = cy - dy;
      // the level only has these where the rail continues on the far side (plate | merge | rail): a lone rail cell between
      // plates, or at the end of a run, is an ordinary edge piece
      if (solid(nx, ny) && styleAt(nx, ny) === 'plate' && !solid(nx + ox, ny + oy) && solid(rx, ry) && styleAt(rx, ry) === 'rail' && !solid(rx + ox, ry + oy)) return { layer, tile: family + tileNo, matrix: [1, 0, 0, 1], merge: dir };
    }
    // Second pass: terminal pair for a single rail cell between plates (plate | rail | plate).
    // The rail cell has plate on both sides along the edge. Use a cap (rail end) tile.
    const [pdx, pdy] = OPEN_SIDE[r.whole]; // not used here; we check along the edge
    // For T/B edges, check west and east; for L/R edges, check north and south.
    const along = r.whole === 'T' || r.whole === 'B' ? [MERGE_STEP.W, MERGE_STEP.E] : [MERGE_STEP.N, MERGE_STEP.S];
    const [a1, a2] = along;
    const n1x = cx + a1[0], n1y = cy + a1[1];
    const n2x = cx + a2[0], n2y = cy + a2[1];
    if (solid(n1x, n1y) && styleAt(n1x, n1y) === 'plate' && !solid(n1x + ox, n1y + oy) &&
        solid(n2x, n2y) && styleAt(n2x, n2y) === 'plate' && !solid(n2x + ox, n2y + oy)) {
      // Rail cell with plate on both sides along the edge -> terminal (1-cell run). Pick a cap tile.
      // Prefer a single-cell strip piece if the sheet declares one, else fall back to the first cap (left/top end).
      const capPiece = (r.whole === 'T' || r.whole === 'B') ? (plate.h && plate.h[0] ? 'h0' : 'TL') : (plate.v && plate.v[0] ? 'v0' : 'TL');
      return { layer, ...resolve(capPiece), terminal: true };
    }
  }
  if (r.whole && r.holes) {
    // An inside corner. The sheet's own tile where the level uses one (a cell with all four sides solid): that is the real
    // art. Otherwise, where the sheet has nothing and a mitred band can't look wrong (not on rail sheets, not on corner
    // pieces, which keep their rivets), a connector built from the pixels of the two edge pieces beside the gap.
    const real = (d) => { if (plate.foot?.[d]) return { tile: plate.foot[d], matrix: id }; const p = plate.inner?.[d]; return p == null ? null : typeof p === 'number' ? { tile: family + p, matrix: id } : { tile: family + p.id, matrix: p.m }; };
    // (On the plate sheets the level's own inside tiles are a 2x2-plate art that leaves cut lines against the 3x3 edge
    // pieces, so there the connector is cleaner; on rail sheets the real tile is the one that fits.)
    if (plate.rail && r.whole === 'C' && r.holes.length === 1 && real(r.holes[0])) return { layer, ...real(r.holes[0]), centre: true };
    // A level cell is re-tiled into the sheet's own piece, as the level does it: its edge or its corner too, not only the
    // centre. A generated connector is used only where the cells that supply its clean lines are re-tiled as well.
    if (tilingLevelCell) {
      if (r.whole === 'C' && r.holes.length === 1 && real(r.holes[0])) return { layer, ...real(r.holes[0]), centre: true };
      if (!levelConnectorCells || !levelConnectorCells.has(key(cx, cy))) return { layer, ...resolve(r.whole), holes: r.holes };
    }
    // A rail sheet with no inside tile of its own (Floor plate) still gets the connector at a BOTTOM inside corner: its rail
    // runs along the top only, so the bottom and side edges joined there are plain plate, and the bare centre left a flat hole.
    const railBottomOnly = plate.rail && r.whole === 'C' && !r.holes.some((d) => real(d)) && r.holes.every((d) => d === 'SW' || d === 'SE');
    // Rail sheets now get a generated (rail-aware) connector too: only veto where there is no rail line to join (corner
    // pieces, or a sheet with no matching inside tile that is not a bottom corner).
    if (!plate.rail && !/^[CTBLR]$/.test(r.whole)) return { layer, ...(r.whole === 'C' && real(r.holes[0]) ? real(r.holes[0]) : resolve(r.whole)) };
    if (plate.rail && !railBottomOnly && !/^[CTBLR]$/.test(r.whole)) return { layer, ...(r.whole === 'C' && real(r.holes[0]) ? real(r.holes[0]) : resolve(r.whole)) };
    const baseTile = name(r.whole), parts = [], tokens = [];
    for (const d of r.holes) {
      const role = connectorRoles(d), vId = plate[role.v], hId = plate[role.h];
      const vProf = EDGE_PROFILE[family + '|' + vId + '|' + role.v], hProf = EDGE_PROFILE[family + '|' + hId + '|' + role.h];
      if (!vProf || !hProf) continue;
      for (const [x, y, pid, sx, sy] of connector(d, vId, hId, vProf, hProf)) parts.push([x, y, family + pid, sx, sy]);
      tokens.push(d + vId + '.' + hId);
    }
    if (!tokens.length) return { layer, ...resolve(r.whole) };
    return { layer, tile: baseTile + '+' + tokens.join('+'), matrix: id, base: baseTile, parts, spriteFrom: { ref: baseTile, base: baseTile, pixels: parts } };
  }
  if (r.whole) return { layer, ...resolve(r.whole), ...(r.whole === 'C' ? { centre: true } : {}) };
  if (r.quarters.every((q) => q === r.quarters[0])) return { layer, ...resolve(r.quarters[0]) };
  // Quarters are cut from the pieces as they are (no turning of the stand-in), so the plain tile, not its flipped stand-in;
  // an inside corner's quarter is turned by its flips instead.
  const parts = r.quarters.map((q) => q.split('~'));
  const quarters = parts.map(([p]) => name(p)), flips = parts.map(([, f]) => f || '');
  return {
    layer, tile: family + 'q' + quarters.map((q, i) => q.slice(family.length) + (flips[i] ? '~' + flips[i] : '')).join('_'), matrix: id, quarters, flips,
    spriteFrom: { ref: name('C'), quarters, ...(flips.some(Boolean) ? { flips } : {}) },
  };
}

// ---- one snapping rule for every draw path (E1-E7) ----
// A destination rect's edges are rounded to the pixel grid of the space it is drawn in, so two
// neighbours that share an edge get the same rounded edge and meet exactly. This replaces the
// hand-tuned overscans (+0.5, +0.25, +0.3, +1) that each path used to hide one gap by opening
// another (a double-blended seam wherever globalAlpha was under 1).
// `scale` is the transform's scale in that space (canvas pixels per unit) and the grid is a device
// pixel; `device` false snaps to the canvas pixel instead, for a path blitted 1:1 from an
// integer-sized bitmap (the backdrops), which would otherwise resample a window-sized image again.
const deviceRatio = () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
function snapRect(x, y, w, h, scale = 1, device = true) {
  const sx = typeof scale === 'number' ? scale : scale.x, sy = typeof scale === 'number' ? scale : scale.y;
  const dpr = device ? deviceRatio() : 1;
  const kx = Math.max(1e-6, sx) * dpr, ky = Math.max(1e-6, sy) * dpr;
  const x0 = Math.round(x * kx) / kx, y0 = Math.round(y * ky) / ky;
  const x1 = Math.round((x + w) * kx) / kx, y1 = Math.round((y + h) * ky) / ky;
  // A piece smaller than a pixel would vanish: it keeps the one pixel it falls in - but only at full
  // opacity, where the overlap it makes is free (under a fade the piece is dropped, not blended twice).
  const solid = !ctx || ctx.globalAlpha >= 1;
  return { x: x0, y: y0, w: x1 > x0 ? x1 - x0 : (w > 0 && solid ? 1 / kx : 0), h: y1 > y0 ? y1 - y0 : (h > 0 && solid ? 1 / ky : 0) };
}

function drawGroundArt(cx, cy, art) {
  if (art.parts) {
    if (!drawTileArt(cx, cy, art.base, art.matrix)) return false;
    const r = cellRect(cx, cy), px = r.w / 32, py = r.h / 32;
    for (const [x, y, tile, sx, sy] of art.parts) {
      const sp = base.art.sprites[base.art.tiles[tile]];
      if (!sp) continue;
      const p = snapRect(r.x + x * px, r.y + y * py, px, py);
      ctx.drawImage(atlasImg, sp[0] + sx, sp[1] + sy, 1, 1, p.x, p.y, p.w, p.h);
    }
    return true;
  }
  if (!art.quarters) return drawTileArt(cx, cy, art.tile, art.matrix);
  if (!artReady() || art.quarters.some((q) => base.art.tiles[q] === undefined)) return false;
  const r = cellRect(cx, cy);
  const hw = r.w / 2, hh = r.h / 2;
  // The four quarters tile the cell: its edges and the midline are snapped once and shared.
  const cell = snapRect(r.x, r.y, r.w, r.h), mid = snapRect(r.x, r.y, hw, hh);
  const xs = [cell.x, mid.x + mid.w, cell.x + cell.w], ys = [cell.y, mid.y + mid.h, cell.y + cell.h];
  art.quarters.forEach((q, i) => {
    const col = i % 2, row = i >> 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(xs[col], ys[row], xs[col + 1] - xs[col], ys[row + 1] - ys[row]);
    ctx.clip();
    const f = art.flips?.[i] || '';
    drawTileArt(cx, cy, q, f ? [f.includes('x') ? -1 : 1, 0, 0, f.includes('y') ? -1 : 1] : art.matrix);
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
// A clone's exported position: a checkpoint's flag and respawn point stand in its box (see checkpoint.js).
function cloneAt(o, item, origin = { x: 0, y: 0 }) {
  const a = isCheckpoint(item) && o.cfg?.trig ? checkpointExport(o.x, o.y, o.cfg.trig) : { x: o.x, y: o.y };
  return { x: Math.round(a.x - origin.x), y: Math.round(a.y - origin.y) };
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
  if (isSizable(item) && cfg.trig) out.trigger = isCheckpoint(item) ? checkpointExport(o.x, o.y, cfg.trig).trigger : { w: cfg.trig.w, h: cfg.trig.h, dx: cfg.trig.dx, dy: cfg.trig.dy };
  if (isTeleporter(item)) {
    const ref = (r) => { const t = teleportTarget(r); return t ? (t.uid ? { uid: t.uid } : { path: t.path, x: t.x, y: t.y }) : null; };
    const zone = baseOn() ? Number(String(zoneAt(o.x, o.y)).replace(/\D+/g, '')) || 1 : 1;
    out.teleport = { id: o.uid || 'tp' + Math.round(o.x) + '_' + Math.round(o.y), zone, up: ref(o.tp?.up), down: ref(o.tp?.down) };
  }
  return out;
}

let tileBox = null;
const cellBox = {}; // collection name -> { src, rev, box } for exportArea
function exportArea() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  const addKey = (k) => { const c = k.indexOf(','); add(+k.slice(0, c), +k.slice(c + 1)); };
  // The cell collections are most of a big map; each one's box is kept until it changes (and is read off its area index: the
  // outermost areas hold the extremes, so the other cells are never looked at).
  for (const [name, coll] of [['blocks', blocks], ['spikes', spikes], ['vines', vines]]) {
    let c = cellBox[name];
    if (!c || c.src !== coll || c.rev !== coll.rev) cellBox[name] = c = { src: coll, rev: coll.rev, box: coll.extent() };
    if (c.box) { add(c.box[0], c.box[1]); add(c.box[2], c.box[3]); }
  }
  {
    let c = cellBox.moss;
    if (!c || c.src !== mossCells || c.rev !== mossCells.rev) {
      const keep = [x0, y0, x1, y1];
      x0 = y0 = Infinity; x1 = y1 = -Infinity;
      mossCells.forEach((_, k) => { const m = mossCenter(k), cc = cellOf(m.x, m.y); add(cc.cx, cc.cy); });
      cellBox.moss = c = { src: mossCells, rev: mossCells.rev, box: x0 === Infinity ? null : [x0, y0, x1, y1] };
      [x0, y0, x1, y1] = keep;
    }
    if (c.box) { add(c.box[0], c.box[1]); add(c.box[2], c.box[3]); }
  }
  // The tiles are most of a big map and rarely change, so their box is kept until they do.
  if (tileBox?.of !== tiles || tileBox.rev !== tiles.rev) {
    const keep = [x0, y0, x1, y1];
    x0 = y0 = Infinity; x1 = y1 = -Infinity;
    tiles.forEach((t, k) => { const c = tileCenter(t.layer, k); const cc = cellOf(c.x, c.y); add(cc.cx, cc.cy); });
    tileBox = { of: tiles, rev: tiles.rev, box: [x0, y0, x1, y1] };
    [x0, y0, x1, y1] = keep;
  }
  if (tileBox.box[0] !== Infinity) { add(tileBox.box[0], tileBox.box[1]); add(tileBox.box[2], tileBox.box[3]); }
  for (const o of placed) { const cc = cellOf(o.x, o.y); add(cc.cx, cc.cy); }
  if (baseOn()) removedVines.forEach(addKey);
  if (baseOn()) removed.forEach(addKey);
  for (const g of [draft.spawn, ...courses().flatMap((c) => [c.start, c.end])]) {
    if (!g) continue;
    const c = cellOf(g.x, g.y);
    add(c.cx, c.cy);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
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
    const snap = snapshot();
    takeStageEdits();
    putStageEdits(kept);
    const theirs = buildOverlayCore().groups[0].objects;
    applyState(snap);
    saveDraft();
    for (const o of theirs) { const t = tag(o, other); if (t) objs.push(t); }
  }
  if (objs.some((o) => o.state)) map.stages = true;
  return withGroups(map);
}
// Group ids onto the exported objects: placed things carry theirs; tiles take their cell's.
function withGroups(map) {
  const objs = map.groups[0].objects, origin = baseOn() ? { x: 0, y: 0 } : cellWorld(0, 0);
  // (With no cell in a group there is nothing to put on the tiles; the walk over every object is for the maps that have some.)
  if (cellGroups.size) for (const o of objs) {
    if (o.group || !(o.type === 'tile' || o.type === 'ground' || o.type === 'coloredGround' || o.type === 'trueSpike')) continue;
    const k = o.cellX !== undefined ? key(o.cellX, o.cellY) : (() => { const c = cellOf(o.x + origin.x, o.y + origin.y); return key(c.cx, c.cy); })();
    const g = cellGroups.get(k);
    if (g && (blocks.has(k) || spikes.has(k))) o.group = g;
  }
  if ((draft.hiddenGroups || []).length) {
    const used = new Set(objs.map((o) => o.group).filter(Boolean));
    const hidden = draft.hiddenGroups.filter((g) => used.has(g));
    if (hidden.length) map.hiddenGroups = hidden;
  }
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
  for (const o of baseObjects) if (removedObjects.has(o.id)) {
    if (o.checkpoint) objects.push({ type: 'hideCheckpoint', x: o.srcX ?? o.x, y: o.srcY ?? o.y });
    else objects.push({ type: 'hide', path: o.path, srcX: o.srcX ?? o.x, srcY: o.srcY ?? o.y });
  }
  removedDeco.forEach((rk) => {
    const bar = rk.lastIndexOf('|'), layerName = rk.slice(0, bar), [gx, gy] = unkey(rk.slice(bar + 1)), g = layerGrid(layerName);
    objects.push({ type: 'erase', tilemap: layerName, x: g.ox + (gx + 0.5) * g.size, y: g.oy + (gy + 0.5) * g.size });
  });
  for (const p of sceneList?.items || []) if (p.id && removedScene.has(p.id)) objects.push({ type: 'hide', path: p.p, srcX: p.x0 ?? p.x, srcY: p.y0 ?? p.y, rendererOnly: true });
  // The level's own things, moved: the game moves the real object by the same amount.
  for (const o of baseObjects) { const d = movedObjects.get(o.id); if (d && (!o.checkpoint || o.path) && !removedObjects.has(o.id)) objects.push({ type: 'move', path: o.path, srcX: o.x0 ?? o.x, srcY: o.y0 ?? o.y, dx: d[0], dy: d[1] }); }
  for (const p of sceneList?.items || []) { const d = p.id && movedScene.get(p.id); if (d && !removedScene.has(p.id)) objects.push({ type: 'move', path: p.p, srcX: p.x0 ?? p.x, srcY: p.y0 ?? p.y, dx: d[0], dy: d[1] }); }
  const levelAt = (k) => { if (k.startsWith('o:')) { const o = baseObjects.find((x) => x.id === k.slice(2)); return o && !o.checkpoint && !removedObjects.has(o.id) ? { path: o.path, srcX: o.x0 ?? o.x, srcY: o.y0 ?? o.y } : null; } const p = sceneList?.items.find((x) => x.id === k); return p && !removedScene.has(p.id) ? { path: p.p, srcX: p.x0 ?? p.x, srcY: p.y0 ?? p.y } : null; };
  for (const [k, tf] of levelTf) { const at = levelAt(k); if (at) objects.push({ type: 'transform', ...at, rotation: tf.rot || 0, scale: [(tf.scale || 1) * (tf.sx || 1) * (tf.fx ? -1 : 1), (tf.scale || 1) * (tf.sy || 1) * (tf.fy ? -1 : 1)] }); }
  for (const [k, n] of levelOrder) { const at = levelAt(k); if (at) objects.push({ type: 'order', ...at, delta: n }); }
  for (const [k, g] of levelGroups) { const at = levelAt(k); if (at) objects.push({ type: 'group', ...at, group: g }); }
  for (const id of Object.keys(draft.baseEdits || {})) {
    const o = baseObjects.find((x) => x.id === id);
    if (!o || removedObjects.has(id)) continue;
    if (o.checkpoint) { const c = baseCheckpointCourse(o); if (isLinked(c)) objects.push({ type: 'modify', checkpoint: true, x: o.srcX ?? o.x, y: o.srcY ?? o.y, course: c }); continue; }
    const u = baseUpgradeConfig(o);
    objects.push({ type: 'modify', path: o.path, srcX: o.srcX ?? o.x, srcY: o.srcY ?? o.y, upgrade: { id: 'level:' + id, label: u.label, currency: u.currency, baseCost: u.baseCost, cost: u.cost, prices: upgradePrices(u), scale: u.scale, add: u.add, power: u.power, max: u.max } });
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
  // The level's cells beside your blocks, re-tiled: painted over the level's own at the same cell.
  for (const [k, o] of levelOverrides().cells) objects.push({ type: 'tile', tilemap: o.art.layer, tileName: o.art.tile, ...at(k), matrix: o.art.matrix, levelRetile: true, ...(o.art.spriteFrom ? { spriteFrom: o.art.spriteFrom } : {}) });
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
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, ...cloneAt(o, item), order: ranks.get(o), ...(o.behind ? { behind: true, ...(o.depth === 2 ? { depth: 2 } : {}) } : {}), ...(o.group ? { group: o.group } : {}), ...cloneConfig(o, item) });
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
      ...levelRespawnsJson(),
      objects,
    }],
  };
}

// The map's own id, written into map.json as "uid": the same across saves, exports and copies of the map, so the Hub can tell a new version of a map (an update of its upload, and of installed copies) from a different map.
function ensureMapUid() {
  if (!draft.mapUid) draft.mapUid = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return draft.mapUid;
}
function buildMap() {
  const map = baseOn() ? buildOverlay() : withGroups(buildCustomMap());
  return { uid: ensureMapUid(), ...map };
}
// Your blocks as a grid of kind numbers, so that the export's neighbour questions ("is there a block of this tileset at x,y?") are
// array reads instead of building a key string and looking it up eight times a cell. Used by the joinSolid / joinStyle of a map
// without the base game, where those questions are about your own blocks only; the answers are the ones the Map gives.
let exportGrid = null, exportGridOff = false; // (off: only for a test that compares the two)
class BlockGrid {
  constructor() {
    this.chunks = new Map(); // chunk number -> Uint16Array(CHUNK * CHUNK) of kind numbers (0: no block)
    this.kinds = [null]; // kind number -> kind
    this.kindNo = new Map();
    this.lastNo = NaN; this.lastArr = null;
    this.solids = new Map(); this.styles = new Map();
  }
  noOf(kind) {
    let n = this.kindNo.get(kind);
    if (n === undefined) { n = this.kinds.length; this.kinds.push(kind); this.kindNo.set(kind, n); }
    return n;
  }
  set(x, y, kind) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), no = (cx + 1048576) * 2097152 + (cy + 1048576);
    let a = this.chunks.get(no);
    if (!a) this.chunks.set(no, (a = new Uint16Array(CHUNK * CHUNK)));
    a[(y - cy * CHUNK) * CHUNK + (x - cx * CHUNK)] = this.noOf(kind);
  }
  at(x, y) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), no = (cx + 1048576) * 2097152 + (cy + 1048576);
    if (no !== this.lastNo) { this.lastNo = no; this.lastArr = this.chunks.get(no) || null; }
    return this.lastArr ? this.lastArr[(y - cy * CHUNK) * CHUNK + (x - cx * CHUNK)] : 0;
  }
  solid(kind) {
    let f = this.solids.get(kind);
    if (!f) {
      const layer = joinInfo(kind).layer, same = new Map();
      f = (x, y) => {
        const n = this.at(x, y);
        if (!n) return false;
        let r = same.get(n);
        if (r === undefined) same.set(n, (r = joinInfo(this.kinds[n]).layer === layer));
        return r;
      };
      this.solids.set(kind, f);
    }
    return f;
  }
  style(kind) {
    let f = this.styles.get(kind);
    if (!f) {
      const id = joinInfo(kind).id, of = new Map();
      f = (x, y) => {
        const n = this.at(x, y);
        if (!n) return null;
        let r = of.get(n);
        if (r === undefined) { const own = this.kinds[n]; of.set(n, (r = joinInfo(own).id === id ? ownStyle(own) : null)); }
        return r;
      };
      this.styles.set(kind, f);
    }
    return f;
  }
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
  // The cells to write, one per place (a spike's tile stands where a block of the same cell was), held as parallel lists rather than
  // a Map of wrapper objects per block, and written in rows, bottom to top and west to east.
  const cellKeys = [...cells.keys()], cellVals = [...cells.values()];
  const at = cells.size ? new Map(cellKeys.map((k, i) => [k, i])) : null; // only a map that starts from the level's cells has any to replace
  const put = (k, v) => {
    const i = at?.get(k);
    if (i !== undefined) cellVals[i] = v;
    else { at?.set(k, cellKeys.length); cellKeys.push(k); cellVals.push(v); }
  };
  const spikeTiles = new Map();
  spikes.forEach((sp, k) => { const [cx, cy] = unkey(k); if (sp.c !== 'true') spikeTiles.set(k, { t: 'tile', ...spikeTile(sp.c, spikeTurn(sp, cx, cy)) }); });
  const grid = baseOn() || exportGridOff ? null : new BlockGrid();
  blocks.forEach((kind, k) => {
    if (grid) { const c = k.indexOf(','); grid.set(+k.slice(0, c), +k.slice(c + 1), kind); }
    if (!spikeTiles.has(k)) put(k, kind);
  });
  for (const [k, v] of spikeTiles) put(k, v);
  const vineCells = [];
  if (baseOn()) baseHaz.forEach((h, k) => {
    const [cx, cy] = unkey(k);
    if (h.kind === 'vine' && inArea(cx, cy) && !removedVines.has(k) && !vines.has(k)) vineCells.push([k, { layer: base.defs[h.d].layer, tile: base.defs[h.d].tile, matrix: base.mats[h.m] }]);
  });
  vines.forEach((v, k) => vineCells.push([k, vineTile(v.s, v.q)]));

  const origin = cellWorld(0, 0);
  const objects = [];
  const nCells = cellKeys.length, xs = new Int32Array(nCells), ys = new Int32Array(nCells), order = new Uint32Array(nCells);
  for (let i = 0; i < nCells; i++) {
    const k = cellKeys[i], c = k.indexOf(',');
    xs[i] = +k.slice(0, c); ys[i] = +k.slice(c + 1); order[i] = i;
  }
  order.sort((a, b) => ys[a] - ys[b] || xs[a] - xs[b]);
  exportGrid = grid;
  try {
    for (let n = 0; n < nCells; n++) {
      const i = order[n], cx = xs[i], cy = ys[i], val = cellVals[i], cellX = cx, cellY = cy;
      const t = typeof val === 'string' ? val : val.t;
      const art = (isGround(t) || BLOCK_SETS[t]) && blockArt(t, cx, cy);
      if (art) objects.push({ type: 'tile', tilemap: art.layer, tileName: art.tile, cellX, cellY, matrix: art.matrix, ...(art.spriteFrom ? { spriteFrom: art.spriteFrom } : {}) });
      else if (isGround(t)) objects.push({ type: 'ground', cellX, cellY });
      else if (t === 'blue' || t === 'orange') {
        const tl = colouredTile(t, cx, cy);
        objects.push(tl ? { type: 'tile', tilemap: tl.layer, tileName: tl.tile, cellX, cellY, matrix: tl.matrix, ...(tl.spriteFrom ? { spriteFrom: tl.spriteFrom } : {}) } : { type: 'coloredGround', color: t, cellX, cellY });
      }
      else objects.push({ type: 'tile', tilemap: val.layer, tileName: val.tile, cellX, cellY, matrix: val.matrix });
    }
  } finally { exportGrid = null; }
  if (baseOn()) for (const o of baseObjects) {
    if (o.checkpoint) continue;
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
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, ...cloneAt(o, item, origin), order: ranks.get(o), ...(o.behind ? { behind: true, ...(o.depth === 2 ? { depth: 2 } : {}) } : {}), ...(o.group ? { group: o.group } : {}), ...cloneConfig(o, item) });
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
// A dropped canvas or ImageBitmap keeps its pixels until the garbage collector gets round to it, and the collector pays no heed
// to how big they are: zooming through a big map piled up gigabytes that way. Whatever a cache lets go of is released on the spot.
function freeCanvas(c) {
  if (!c) return;
  if (typeof c.close === 'function') c.close();
  else if (c.width) c.width = c.height = 0;
}
// Canvases whose backing store the browser dropped (Chromium GPU memory pressure) hold nothing, so every cache forgets them (purgeLost).
const lostCanvases = new Set();
let cacheScale = 1; // shrinks the cache caps after each loss
function makeCanvas() {
  if (IN_WORKER) return new OffscreenCanvas(1, 1);
  const cv = document.createElement('canvas');
  cv.addEventListener('contextlost', (e) => { e.preventDefault?.(); flick.lost++; cacheScale = Math.max(0.25, cacheScale * 0.7); lostCanvases.add(cv); dbgLog('contextlost on cache canvas ' + cv.width + 'x' + cv.height); requestDraw(); });
  cv.addEventListener('contextrestored', () => { flick.restored++; lostCanvases.delete(cv); requestDraw(); });
  return cv;
}
// Chromium throws InvalidStateError for drawImage from a zero-size canvas or closed ImageBitmap (WebKit doesn't); one throw would end the frame after the background fill.
function guardCtx(g) {
  if (!g || g.drawImageSafe) return g;
  const d = g.drawImage;
  g.drawImage = function (...a) { try { return d.apply(this, a); } catch (e) { flick.throws++; dbgLog('drawImage threw: ' + (e && e.message || e)); } };
  g.drawImageSafe = true;
  return g;
}
function purgeLost() {
  if (!lostCanvases.size) return;
  const gone = (cv) => lostCanvases.has(cv);
  for (const [k, c] of [...tileCache]) if (gone(c)) { tileCache.delete(k); dirtyGen.set(k, stateVersion); flick.purged++; }
  for (const [k, j] of [...tileJobs]) if (gone(j.cv)) { tileJobs.delete(k); flick.purged++; }
  for (const [k, c] of [...cellCache.chunks]) if (gone(c.cv)) { cellCache.chunks.delete(k); flick.purged++; }
  cellCache.pool = cellCache.pool.filter((c) => !gone(c));
  for (const k of Object.keys(scratchCanvas)) if (gone(scratchCanvas[k])) delete scratchCanvas[k];
  for (const [k, c] of [...tintCache]) if (gone(c)) tintCache.delete(k);
  for (const g of sceneList?.groups || []) if (g.canvas && gone(g.canvas.canvas)) g.canvas = null;
  for (const [k, c] of [...bdCache]) if (gone(c)) { bdCache.delete(k); bdPx -= c.width * c.height; }
  if (levelLayer.a && (gone(levelLayer.a.cv) || gone(levelLayer.b.cv))) { levelLayer.a = levelLayer.b = null; levelLayer.ok = false; }
  if (worldCache.cv && gone(worldCache.cv)) { worldCache.cv = null; worldCache.ok = false; worldDirty = true; }
  lostCanvases.clear();
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

// The world layer (background, level tiles, your blocks: the costly part of a frame) is kept as a picture and blitted back
// while only the overlays change (the mouse moving over the map). Anything that asks for a draw the ordinary way marks it
// stale; requestOverlayDraw is for the callers that know the world is untouched.
const worldCache = { cv: null, key: '', ok: false };
let worldDirty = true, drawPhase = 0, worldClean = true;
function requestDraw() {
  if (drawPhase !== 2) worldDirty = true;
  if (IN_WORKER || frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; stepCamera(); draw(); });
}

// A camera drag: the world moved but nothing in it changed, so the level layer can be scrolled instead of redrawn (see drawLevelLayer).
// While the zoom glides every frame is a new scale, so every image in it is resampled again: smoothing is off for those frames (the frame it lands on is drawn smooth).
const zooming = () => camGoal.active && camGoal.scale != null;
let panFrame = false;
function requestPanDraw() {
  panFrame = true;
  if (IN_WORKER || frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; stepCamera(); draw(); });
}
function requestOverlayDraw() {
  if (IN_WORKER || frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; stepCamera(); draw(); });
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
// Drawing order where the level splits for things put behind it: backgrounds and wall art below, ground, objects and spikes from it up.
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
  if (!atlasImg) loadLazy(MAPS + base.art.atlas, (i) => { atlasImg = i; artCache.clear(); invalidateBase(); if (!IN_WORKER) updateCategoryButtons(); }, 'Level art');
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
  const hid = hiddenLevel();
  if (hid.size && l.size === CELL) { const c = cellOf(l.ox + col * l.size + CELL / 2, l.oy + row * l.size + CELL / 2); if (hid.has(l.name + '|' + key(c.cx, c.cy))) return true; }
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
        tickProgress();
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
// Never-complete stand-in for an image the worker could not load. Frozen so nothing can
// accidentally "load" it later.
const DEAD_IMAGE = Object.freeze({ complete: false, naturalWidth: 0, naturalHeight: 0, width: 0, height: 0 });

function bgImage(src) {
  if (!bgImages[src]) {
    // The tile worker has no `Image` constructor, so anything not preloaded by workerInit
    // cannot be fetched lazily. Handing back a stub that never reports itself complete makes
    // the caller's `if (!img.complete ...) continue` skip just this one, instead of throwing
    // on it and losing every backdrop after it.
    if (IN_WORKER) return DEAD_IMAGE;
    const img = newMapImage();
    img.onload = () => { img.failed = false; assetLog.set(MAPS + src, { ok: true, tries: (img.tries || 0) + 1 }); invalidateBase(); };
    img.onerror = () => {
      img.failed = true;
      img.tries = (img.tries || 0) + 1;
      assetLog.set(MAPS + src, { ok: false, tries: img.tries, err: 'load error' });
      if (img.tries <= 5) setTimeout(() => { img.src = MAPS + src + '?r=' + img.tries; }, 400 * img.tries);
    };
    img.src = MAPS + src;
    bgImages[src] = img;
  }
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
function drawBackground(W, H, alpha = backdropFade()) {
  if (!alpha) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  try { drawBackdrop(W, H); if (!draft.background?.image) drawWorldBackdrops(W, H); } finally { ctx.restore(); }
  drawCredits(W, H, 'end');
}
// A backdrop image is the biggest single resample of a frame (a window's worth of it, every frame). Once the zoom has settled it is
// scaled one time into a canvas of its final size and blitted 1:1 at whole pixels from then on (parallax steps by a pixel).
const bdCache = new Map(), bdIds = new WeakMap();
let bdPx = 0, bdNext = 1;
const BD_MAX_PX = 24e6;
const backdropPrescaleOff = () => { try { return localStorage.mapMakerNoBackdropCache === '1'; } catch { return false; } };
function drawBackdropImage(img, x, y, dw, dh) {
  const w = Math.ceil(dw), h = Math.ceil(dh);
  if (IN_WORKER || w < 1 || h < 1 || w * h > 6e6 || backdropPrescaleOff()) { ctx.drawImage(img, x, y, dw, dh); return; }
  if (!bdIds.has(img)) bdIds.set(img, bdNext++);
  const k = bdIds.get(img) + '|' + w + 'x' + h;
  let pre = bdCache.get(k);
  if (pre) { bdCache.delete(k); bdCache.set(k, pre); }
  else if (!zooming()) {
    pre = makeCanvas();
    pre.width = w; pre.height = h;
    pre.getContext('2d').drawImage(img, 0, 0, w, h);
    bdCache.set(k, pre); bdPx += w * h;
    for (const [ok, oc] of bdCache) { if (bdPx <= BD_MAX_PX || ok === k) break; bdCache.delete(ok); bdPx -= oc.width * oc.height; oc.width = oc.height = 0; }
  }
  if (pre) ctx.drawImage(pre, Math.round(x), Math.round(y)); else ctx.drawImage(img, x, y, dw, dh);
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
        // The tile's edges are snapped, not its size: this tile ends exactly where the next begins.
        // The backdrop is blitted 1:1 from an integer-sized bitmap, so it keeps the canvas pixel.
        const r = snapRect(a.x, a.y, sw, sh, 1, false);
        if (b.sx < 0) { ctx.setTransform(-1, 0, 0, 1, r.x + r.w, r.y); drawBackdropImage(img, 0, 0, r.w, r.h); ctx.setTransform(1, 0, 0, 1, 0, 0); }
        else drawBackdropImage(img, r.x, r.y, r.w, r.h);
      }
    }
  }
  ctx.restore();
}

// A parallax layer (area 3's ParallaxController) sits between its parent and the camera.
const layerAt = (b) => (b.par ? { x: b.px + (cam.x - b.px) * b.par[0], y: b.py + (cam.y - b.py) * b.par[1] } : { x: b.x, y: b.y });
// Area 3's wallpaper: big tiled strips behind the level drifting by their parallax; they follow the camera, so they exist only while the view is in area 3.
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
      // The strip's units are scaled by the transform, so the edges are snapped in device pixels.
      const r = snapRect(u, v, cw, ch, { x: k * Math.hypot(a, bb), y: k * Math.hypot(c, d) });
      ctx.drawImage(img, 0, 0, img.naturalWidth * (r.w / tw), img.naturalHeight * (r.h / th), r.x, r.y, r.w, r.h);
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
      // The copy's edges are snapped, not its size: this copy ends exactly where the next begins.
      // The backdrop is blitted 1:1 from an integer-sized bitmap, so it keeps the canvas pixel.
      const r = snapRect(a.x, a.y, w * cam.scale, h * cam.scale, 1, false);
      drawBackdropImage(img, r.x, r.y, r.w, r.h);
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
  if (!sceneImg) loadLazy(MAPS + sc.atlas, (i) => { sceneImg = i; invalidateBase(); if (!IN_WORKER) updateCategoryButtons(); }, 'Level scenery');
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

// The 9-slice, one helper for both scene paths (E6 and E7): the nine pieces' destination edges are
// snapped, so the slice boundaries meet exactly instead of every piece overscanning by a constant
// (0.3 in the scrolled path, 0.5 in the rotated one - two numbers for one operation).
// `tiled` tiles each piece over its own box instead of stretching it (the dm 2 scene).
// `scale` is the transform's scale in the destination space (canvas pixels per unit).
function drawNineSlice(g, img, srcX, srcY, dstX, dstY, scale = 1, tiled = false) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const sW = srcX[i + 1] - srcX[i], sH = srcY[j + 1] - srcY[j];
    const d0x = dstX[i], d1x = dstX[i + 1], d0y = dstY[j], d1y = dstY[j + 1];
    if (sW <= 0 || sH <= 0 || d1x <= d0x || d1y <= d0y) continue;
    if (!tiled) {
      const r = snapRect(d0x, d0y, d1x - d0x, d1y - d0y, scale);
      g.drawImage(img, srcX[i], srcY[j], sW, sH, r.x, r.y, r.w, r.h);
      continue;
    }
    for (let ty = d0y; ty < d1y; ty += sH) for (let tx = d0x; tx < d1x; tx += sW) {
      const cw = Math.min(sW, d1x - tx), ch = Math.min(sH, d1y - ty);
      const r = snapRect(tx, ty, cw, ch, scale);
      g.drawImage(img, srcX[i], srcY[j], cw, ch, r.x, r.y, r.w, r.h);
    }
  }
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
  // The sprite's own units are scaled by the transform: the edges are snapped in device pixels.
  const scale = { x: s * Math.hypot(m[0], m[1]), y: s * Math.hypot(m[2], m[3]) };
  if (!dm && scroll) {
    const u = ((now * scroll[0]) % 1 + 1) % 1, v = ((now * scroll[1]) % 1 + 1) % 1;
    const cx = Math.round(u * w), cy = Math.round((1 - v) * h) % h;
    for (const [ox, ow, dx] of [[cx, w - cx, 0], [0, cx, w - cx]]) {
      for (const [oy, oh, dy] of [[cy, h - cy, 0], [0, cy, h - cy]]) {
        if (ow > 0 && oh > 0) {
          const r = snapRect(dx, dy, ow, oh, scale);
          ctx.drawImage(img, sx + ox, sy + oy, ow, oh, r.x, r.y, r.w, r.h);
        }
      }
    }
    return;
  }
  if (!dm) { ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h); return; }
  const srcX = [sx, sx + bl, sx + w - br, sx + w], srcY = [sy, sy + bt, sy + h - bb, sy + h];
  const dstX = [0, bl, W - br, W], dstY = [0, bt, H - bb, H];
  drawNineSlice(ctx, img, srcX, srcY, dstX, dstY, scale, dm === 2);
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
    if (p.frames && !staticRender) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; if (animVisible(sprite)) animated = true; }
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
  // Each order's live sprites, then the level's layers above them redrawn over that patch, so ground and moss cover them as in the game.
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
    // The same 9-slice helper as the scrolled scene (E6): the pieces' edges are snapped, not overscanned.
    drawNineSlice(ctx, sceneImg, srcX, srcY, dstX, dstY, 1);
  }
  ctx.restore();
}

const fontImages = [];
function fontImage(i) {
  if (!fontImages[i]) {
    if (IN_WORKER) return { complete: false };
    const img = newMapImage();
    img.onload = () => { textCache.clear(); invalidateBase(); };
    img.src = MAPS + base.scene.fonts[i].atlas;
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
    const img = newMapImage();
    img.onload = invalidateBase;
    img.src = MAPS + 'vines/' + encodeURIComponent(name) + '.png';
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
  if (c.x + w / 2 < -320 || c.x - w / 2 > canvas.width + 320 || c.y + h / 2 < -60 || c.y - h / 2 > canvas.height + 60) return; // off screen, badge included
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
// Far-out level tiles (below MIP_Z) are made by shrinking their four finer tiles by half (4 image draws instead of thousands of sprites) whenever those are cached, e.g. when zooming out. Measured: drawing a far tile straight from the cells (17 ms at z-5) is 10x cheaper than rebuilding it from 64 detail tiles (2.5 ms each), so with no finer tiles it is still drawn from cells.
const MIP_Z = -2;
const OV_Z_MAX = -4; // the whole-map overview saved between sessions: these zooms and below
let mipOn = true;
const flagOn = (name) => { try { return localStorage.getItem(name) === '1'; } catch { return false; } };
const mipsOff = () => flagOn('mapMakerNoMipmaps');
const overviewOff = () => flagOn('mapMakerNoOverviewStore');
const syncTiles = () => flagOn('mapMakerSyncTiles'); // old behaviour: every visible tile is drawn before the frame shows
let viewMissing = false;
// Cached canvases share a memory budget (Chromium drops canvas backings past its GPU limit): ~160 MB at full scale.
const CANVAS_BUDGET_PX = 40e6;
const maxTiles = () => Math.max(768, Math.min(MAX_TILES, Math.floor((CANVAS_BUDGET_PX * cacheScale - cellCache.chunks.size * CC_PX * CC_PX) / (TILE_PX * TILE_PX))));
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
  for (const [k, c] of [...tileCache]) if (hits(k)) { tileCache.delete(k); freeCanvas(c); dirtyGen.set(k, stateVersion); }
  for (const k of pool.inflight?.keys?.() || []) if (hits(k)) dirtyGen.set(k, stateVersion);
  for (const [k, j] of [...tileJobs]) if (hits(k)) { tileJobs.delete(k); freeCanvas(j.cv); }
  requestDraw();
}
const levelEditSets = () => ({ levelHide: new Set(hiddenLevel()), removed: new Set(removed), removedVines: new Set(removedVines), removedScene: new Set(removedScene), removedObjects: new Set(removedObjects), removedDeco: new Set(removedDeco), movedScene: new Map([...movedScene].map(([k, d]) => [k, d.join(',')])), movedObjects: new Map([...movedObjects].map(([k, d]) => [k, d.join(',')])), levelTf: new Map([...levelTf].map(([k, v]) => [k, JSON.stringify(v)])), levelOrder: new Map([...levelOrder].map(([k, v]) => [k, String(v)])), baseEdits: new Map(Object.entries(draft.baseEdits || {}).map(([k, v]) => [k, JSON.stringify(v)])) });
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
  changedKeys(was.levelHide, now.levelHide).forEach((k) => cellRect(k.slice(k.lastIndexOf('|') + 1), 2));
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
// What applyBaseMoves worked from last time. Every edit saves, and each save would otherwise walk all of the level's objects and
// sprites again to put them where the moves say, though no move changed.
let baseMovesFrom = null;
const movesText = (m) => { let t = ''; for (const [k, v] of m) t += k + '=' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : v) + ';'; return t; };
function applyBaseMoves() {
  if (!sceneList) return;
  const from = { scene: sceneList, items: sceneList.items, n: sceneList.items.length, texts: sceneList.texts, objs: baseObjects, nObjs: baseObjects.length, text: movesText(movedObjects) + '|' + movesText(movedScene) + '|' + movesText(levelTf) + '|' + movesText(levelOrder) + '|' + (draft.simulate ? 1 : 0) };
  const last = baseMovesFrom;
  if (last && last.scene === from.scene && last.items === from.items && last.n === from.n && last.texts === from.texts && last.objs === from.objs && last.nObjs === from.nObjs && last.text === from.text) return;
  baseMovesFrom = from;
  const objMoves = baseObjects.filter((o) => movedObjects.has(o.id)).map((o) => [o.path, movedObjects.get(o.id)]);
  const objTf = baseObjects.filter((o) => levelTf.has('o:' + o.id)).map((o) => [o, tfMatrix(levelTf.get('o:' + o.id))]);
  const objOrder = baseObjects.filter((o) => levelOrder.has('o:' + o.id)).map((o) => [o.path, levelOrder.get('o:' + o.id)]);
  for (const o of baseObjects) {
    o.x0 ??= o.x; o.y0 ??= o.y;
    const d = movedObjects.get(o.id) || [0, 0];
    o.x = o.x0 + d[0]; o.y = o.y0 + d[1];
    if (o.hitX != null) { o.hitX0 ??= o.hitX; o.hitY0 ??= o.hitY; o.hitX = o.hitX0 + d[0]; o.hitY = o.hitY0 + d[1]; }
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
  // Baked tiles are composited over the opaque canvas, so no alpha here either.
  ctx = cv.getContext('2d', { alpha: false });
  cam = { x, y, scale };
  staticRender = true;
  try {
    renderBaseLayer(cv.width, cv.height, artReady());
  } finally {
    staticRender = false;
    [canvas, ctx, cam, renderPart] = saved;
  }
}

function renderTile(z, tx, ty, part = null, into = null) {
  const s = Math.pow(2, z), T = TILE_PX / s;
  const cv = into || makeCanvas();
  if (cv.width !== TILE_PX) cv.width = cv.height = TILE_PX;
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

// What a missing tile can show meanwhile: its finer tiles (down to `depth` levels), whichever are cached.
function drawFromFiner(z, tx, ty, x0, y0, w, h, part = null, depth = 2) {
  let any = false;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const px = x0 + (dx * w) / 2, py = y0 + ((1 - dy) * h) / 2;
      const c = tileCache.get(tileKey(z + 1, tx * 2 + dx, ty * 2 + dy, part));
      if (c) { ctx.drawImage(c, px, py, w / 2, h / 2); any = true; }
      else if (depth > 0 && z + 1 < 1 && drawFromFiner(z + 1, tx * 2 + dx, ty * 2 + dy, px, py, w / 2, h / 2, part, depth - 1)) any = true;
    }
  }
  return any;
}

function storeTile(key, tile) {
  const old = tileCache.get(key);
  if (old && old !== tile) { tileCache.delete(key); freeCanvas(old); }
  tileCache.set(key, tile);
  if (overview.on && +key.split('|')[2] <= OV_Z_MAX) overview.dirty = true;
  for (let cap = maxTiles(); tileCache.size > cap;) {
    const oldest = tileCache.keys().next().value;
    freeCanvas(tileCache.get(oldest));
    tileCache.delete(oldest);
  }
}

const mipReady = (z, tx, ty, part) => mipOn && z < MIP_Z && [0, 1].every((dy) => [0, 1].every((dx) => tileCache.has(tileKey(z + 1, tx * 2 + dx, ty * 2 + dy, part))));
// One unit of work towards a tile on the main thread (a piece of a drawn tile, or the shrinking of four finer ones, after those exist); true once it is cached.
function stepMip(z, tx, ty, part = null) {
  const key = tileKey(z, tx, ty, part);
  if (tileCache.has(key)) return true;
  if (mipReady(z, tx, ty, part)) {
    const cv = makeCanvas();
    cv.width = cv.height = TILE_PX;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = true;
    const h = TILE_PX / 2;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) g.drawImage(cachedTile(tileKey(z + 1, tx * 2 + dx, ty * 2 + dy, part)), dx * h, (1 - dy) * h, h, h);
    storeTile(key, cv);
    if (pool.inflight?.has(key)) dirtyGen.set(key, stateVersion + 1);
    return true;
  }
  const job = tileJob(key, z);
  if (!stepTileJob(job, z, tx, ty, part)) return false;
  storeTile(key, job.cv); tileJobs.delete(key);
  if (pool.inflight?.has(key)) dirtyGen.set(key, stateVersion + 1);
  return true;
}

// Without workers: the tiles just outside the view, drawn in idle moments so panning finds them ready.
const aheadQueue = new Map();
let aheadTimer = 0;
function drawAhead() {
  aheadTimer = 0;
  const deadline = performance.now() + 6;
  for (const [key, [z, tx, ty, part]] of [...aheadQueue]) {
    if (tileCache.has(key) || !key.startsWith(baseVersion + '|')) { aheadQueue.delete(key); continue; }
    while (!stepMip(z, tx, ty, part)) if (performance.now() > deadline) break;
    if (tileCache.has(key)) aheadQueue.delete(key);
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
  ovEnsure(useArt);
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
  mipOn = !mipsOff();
  const sync = syncTiles();
  const deadline = performance.now() + (sync ? 1e9 : loading ? 40 : TILE_BUDGET_MS);
  const far = mipOn && z < MIP_Z;
  let missing = false, shown = 0, inView = 0, spare = true;
  for (const [tx, ty, visible] of tiles) {
    if (visible && stripClip) {
      const a = toScreen(tx * T, (ty + 1) * T), b = toScreen((tx + 1) * T, ty * T);
      if (!inStrips(Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y))) { inView++; shown++; continue; }
    }
    const key = tileKey(z, tx, ty, part);
    let c = cachedTile(key);
    if (!c) {
      if (!visible) {
        if (workers) requestTile(key, z, tx, ty, part);
        else aheadQueue.set(key, [z, tx, ty, part]);
      } else if (workers && far && !mipReady(z, tx, ty, part)) requestTile(key, z, tx, ty, part, true); // far tiles come from the workers; the view shows a coarser or finer picture meanwhile
      else {
        // Drawn here only within the frame's time budget (one step at least), the rest waits for the next frame and shows a coarser or finer tile meanwhile.
        if (spare || performance.now() < deadline) {
          spare = false;
          while (!stepMip(z, tx, ty, part)) if (performance.now() >= deadline) break;
          c = cachedTile(key);
        }
        if (!c && workers) requestTile(key, z, tx, ty, part, true);
      }
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
    const job = tileJobs.get(key);
    if (job?.next) ctx.drawImage(job.cv, x0, y0, w, h);
  }
  if (tileJobs.size > 256) {
    const current = baseVersion + '|' + draft.baseState + '|' + z + '|', coarse = baseVersion + '|' + draft.baseState + '|' + preloadZ() + '|';
    for (const [k, j] of [...tileJobs]) if (!k.startsWith(current) && !k.startsWith(coarse)) { tileJobs.delete(k); freeCanvas(j.cv); }
  }
  if (loading?.render && !prefetch && !overview.restoring) planPrefetch(W, H, true);
  const pending = pumpPrefetch(workers);
  if (missing) worldClean = false;
  if (loading?.render && !missing && !pending) hideLoading();
  if (!loading && !missing && !pending) {
    const at = z + '|' + Math.floor(cam.x / (T * 4)) + '|' + Math.floor(cam.y / (T * 4));
    if (at !== prefetchAt) { prefetchAt = at; planPrefetch(W, H, false); }
  }
  if (dbg.on) Object.assign(dbg.cur, { shown, inView, missing, z });
  viewMissing = viewMissing || missing;
  if (missing && (!workers || !pool.inflight.size)) requestDraw();
  else if (!missing && !pending) ovTick();
  scheduleAhead();
}

const preloadZ = () => (mipsOff() ? -4 : -5);
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
  const q = [], seen = new Set(), parts = levelParts();
  const add = (z, x0, y0, x1, y1) => {
    const T = TILE_PX / Math.pow(2, z);
    for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++) for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) {
      for (const part of parts) {
        const k = z + ',' + tx + ',' + ty + ',' + part;
        if (!seen.has(k)) { seen.add(k); q.push([z, tx, ty, part]); }
      }
    }
  };
  const z = lodFor(cam.scale), tl = toWorld(0, 0), br = toWorld(W, H), wv = br.x - tl.x, hv = tl.y - br.y;
  const d = (t) => Math.hypot((t[1] + 0.5) * TILE_PX / Math.pow(2, t[0]) - cam.x, (t[2] + 0.5) * TILE_PX / Math.pow(2, t[0]) - cam.y);
  add(z, tl.x - wv * (full ? 1 : 0.6), br.y - hv * (full ? 1 : 0.6), br.x + wv * (full ? 1 : 0.6), tl.y + hv * (full ? 1 : 0.6));
  q.sort((a, b) => d(a) - d(b));
  if (full && z > preloadZ()) { const b = levelBounds(); if (Number.isFinite(b.x0)) add(preloadZ(), b.x0, b.y0, b.x1, b.y1); }
  if (!full && pool.ready) {
    // Then the view at the zoom either side, so crossing into it finds its tiles drawn instead of drawing them all on the spot (a stall of up to half a second per zoom step on a big map).
    const mark = q.length;
    if (z < 1) add(z + 1, tl.x, br.y, br.x, tl.y);
    if (z > -8) add(z - 1, tl.x, br.y, br.x, tl.y);
    q.push(...q.splice(mark).sort((a, b) => d(a) - d(b)));
  }
  prefetch = { queue: q, total: q.length };
}
function pumpPrefetch(workers) {
  if (!prefetch) return false;
  // Walked in place, not rebuilt: this runs every frame and rebuilding the queue (a string key per entry) made panning stutter.
  const q = prefetch.queue, deadline = performance.now() + (loading ? 40 : 3);
  if (workers && viewMissing && !loading) return true; // the view comes first
  let kept = 0, sent = 0;
  for (let n = 0; n < q.length; n++) {
    const [z, tx, ty, part] = q[n];
    const key = tileKey(z, tx, ty, part);
    if (tileCache.has(key)) continue; // already drawn - drop it
    q[kept++] = q[n];
    if (sent >= 64) { for (let m = n + 1; m < q.length; m++) q[kept++] = q[m]; break; } // the rest wait for the next frame, unchecked
    if (workers) { requestTile(key, z, tx, ty, part); sent++; continue; }
    if (performance.now() > deadline) { for (let m = n + 1; m < q.length; m++) q[kept++] = q[m]; break; } // q[n] is already kept above: copying it again from n let the write index overtake the read index, and the queue grew for ever
    while (performance.now() < deadline) if (stepMip(z, tx, ty, part)) break;
    sent++;
  }
  q.length = kept;
  const left = q.length;
  if (loading?.render) setLoading(0.7 + 0.3 * (1 - left / Math.max(1, prefetch.total)), `Rendering the level ${prefetch.total - left} / ${prefetch.total}`);
  if (!left) { prefetch = null; return false; }
  // No workers: the main thread draws the prefetch in slices between frames. A redraw for each slice would throw the whole picture away
  // every time (tiles drawn ahead change nothing on screen), so only the loading screen, which shows the progress, asks for one.
  if (!workers) {
    if (loading?.render) requestDraw();
    else if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = 0; pumpPrefetch(false); }, 12);
  }
  return true;
}
let pumpTimer = 0;

// The level in the zoom-0 split by band: one string per part a tile is drawn in (null = the whole level).
function levelParts() {
  if (!(baseOn() && !layerHidden('level') && artReady())) return [null];
  const behind = stack().filter((e) => e.it.behind);
  if (!behind.length) return [null];
  const cuts = [...new Set(behind.map((e) => cutOf(e.it)))].sort((a, b) => a - b);
  const out = [];
  let lo = -Infinity;
  for (const cut of cuts) { out.push(lo + ':' + cut); lo = cut; }
  out.push(lo + ':Infinity');
  return out;
}

// ---- the far-out overview kept between sessions (IndexedDB): the whole map's tiles at OV_Z_MAX and below, keyed by the level's data, art state and edits. Every call is guarded; without storage nothing changes. ----
const OV_DB = 'amplifier-overview', OV_STORE = 'tiles', OV_ART = 'a1';
// How long a blocked database is waited for (another window holds it) and how often it is tried again.
const OV_BLOCK_WAIT = 2000, OV_BLOCK_TRIES = 5;
const overview = { on: !IN_WORKER, db: null, epoch: '', restoring: false, saving: false, dirty: false, timer: 0, persisted: new Set(), persistedSig: '', reason: '', reports: 0 };
function overviewSig() {
  const st = workerState();
  delete st.version;
  return ['ov', OV_ART, baseFp, TILE_PX, MIP_Z, fnv(JSON.stringify(st))].join('.');
}
// The cache's state: the database, or why there is none - unsupported (no IndexedDB here), blocked
// (another window holds it), quota (the origin's storage is full or denied), io (anything else).
function ovDb() {
  overview.db ||= new Promise((res) => {
    let done = false, tries = 0;
    const fail = (reason) => {
      if (done) return;
      done = true;
      // A blocked database is given up on for now, not for good: the other window may close later, so
      // the next call opens it again. The others (no IndexedDB here, a broken store) stay as they are.
      if (reason === 'blocked') overview.db = null;
      ovUnavailable(reason);
      res({ reason });
    };
    try {
      if (typeof indexedDB === 'undefined') return fail('unsupported');
      const open = () => {
        const r = indexedDB.open(OV_DB, 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore(OV_STORE); } catch { /* exists */ } };
        r.onsuccess = () => {
          if (done) { r.result.close(); return; }
          done = true;
          // The cache is there after all: the warning about it not being there is taken back.
          if (overview.reason === 'blocked') { overview.reason = ''; updateStatus(); }
          res({ db: r.result });
        };
        r.onerror = () => fail('io');
        // Another window holds the old version: the request waits for it to close, so try again.
        r.onblocked = () => {
          if (++tries > OV_BLOCK_TRIES) return fail('blocked');
          setTimeout(() => { if (!done) open(); }, OV_BLOCK_WAIT);
        };
      };
      open();
    } catch { fail('io'); }
  });
  return overview.db;
}
// Why a write failed: the origin's storage is full (quota) or something else (io).
const ovReason = (e) => (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || e)))) ? 'quota' : 'io';
// The cache is not there: said once, so the slow first open is explained (the far-out view is drawn again every open).
function ovUnavailable(reason) {
  if (overview.reason) return;
  overview.reason = reason || 'unknown';
  overview.reports++;
  dbgLog('overview cache unavailable: ' + overview.reason);
  updateStatus();
}
function ovEnsure(useArt) {
  if (IN_WORKER || !useArt || !baseFp || overviewOff() || loading?.render === false) return;
  const ep = baseVersion + '|' + draft.baseState;
  if (overview.epoch === ep) return;
  overview.epoch = ep;
  overview.restoring = true;
  ovRestore(ep).then((n) => { if (n) requestDraw(); }, () => {}).finally(() => { overview.restoring = false; requestDraw(); });
}
async function ovRestore(ep) {
  try {
    const { db, reason } = await ovDb();
    if (!db) { ovUnavailable(reason); return 0; }
    const sig = overviewSig(), parts = new Set(levelParts().map((p) => p ?? ''));
    // Keys sort by zoom, farthest first; only what takes a third of the tile cache is brought back (the rest is built when the view needs it).
    const room = Math.max(64, Math.floor(maxTiles() / 3));
    const rows = await new Promise((res) => {
      const out = [];
      try {
        const r = db.transaction(OV_STORE, 'readonly').objectStore(OV_STORE).openCursor(IDBKeyRange.bound(sig + '|', sig + '|\uffff'));
        r.onsuccess = () => {
          const c = r.result;
          if (!c || out.length >= room) return res(out);
          const f = String(c.key).slice(sig.length + 1).split('|');
          if (parts.has(f[3] || '')) out.push([c.key, c.value]);
          c.continue();
        };
        r.onerror = () => res(out);
      } catch { res(out); }
    });
    let n = 0;
    for (const [k, blob] of rows) {
      const f = String(k).slice(sig.length + 1).split('|');
      const z = +f[0], tx = +f[1], ty = +f[2], part = f[3] || null;
      if (!parts.has(part ?? '') || !(blob instanceof Blob)) continue;
      const key = tileKey(z, tx, ty, part);
      if (tileCache.has(key)) continue;
      const bmp = await createImageBitmap(blob);
      if (overview.epoch !== ep || tileCache.has(key)) { bmp.close?.(); continue; }
      storeTile(key, bmp);
      overview.persisted.add(key);
      n++;
    }
    if (n) overview.persistedSig = sig;
    return n;
  } catch { return 0; }
}
function ovTick() {
  if (IN_WORKER || !overview.dirty || overview.timer || overview.restoring || overview.saving || overviewOff() || !baseFp) return;
  overview.timer = setTimeout(() => { overview.timer = 0; ovSave(); }, 3000);
}
async function ovSave() {
  if (overview.saving || overviewOff()) return;
  overview.saving = true;
  overview.dirty = false;
  try {
    const { db, reason } = await ovDb();
    if (!db) { ovUnavailable(reason); return; }
    const sv = stateVersion, bv = baseVersion, sig = overviewSig();
    if (overview.persistedSig !== sig) { overview.persistedSig = sig; overview.persisted = new Set(); }
    const prefix = bv + '|' + draft.baseState + '|';
    const todo = [];
    for (const [k] of tileCache) {
      if (!k.startsWith(prefix) || overview.persisted.has(k)) continue;
      const f = k.slice(prefix.length).split('|');
      if (+f[0] <= OV_Z_MAX) todo.push([k, f]);
    }
    todo.sort((a, b) => a[1][0] - b[1][0]);
    todo.length = Math.min(todo.length, 1600);
    if (!todo.length) return;
    const sc = document.createElement('canvas');
    sc.width = sc.height = TILE_PX;
    const g = sc.getContext('2d');
    let n = 0;
    for (const [k, f] of todo) {
      if (stateVersion !== sv || baseVersion !== bv) { overview.dirty = true; break; }
      const tile = tileCache.get(k);
      if (!tile) continue;
      g.clearRect(0, 0, TILE_PX, TILE_PX);
      g.drawImage(tile, 0, 0);
      const blob = await new Promise((res) => { try { sc.toBlob(res, 'image/png'); } catch { res(null); } });
      if (!blob) continue;
      const put = await new Promise((res) => { try { const t = db.transaction(OV_STORE, 'readwrite'); const q = t.objectStore(OV_STORE).put(blob, sig + '|' + f[0] + '|' + f[1] + '|' + f[2] + '|' + (f[3] || '')); t.oncomplete = () => res(null); t.onerror = t.onabort = () => res(t.error || q.error || 'io'); } catch (e) { res(e); } });
      // The storage is full or denied: the cache is gone, and the editor says so.
      if (put) { ovUnavailable(ovReason(put)); break; }
      overview.persisted.add(k);
      if (++n % 6 === 0) await new Promise((r) => setTimeout(r, 40));
    }
    sc.width = sc.height = 0;
    // Only the two newest states are kept.
    const meta = await new Promise((res) => { try { const r = db.transaction(OV_STORE, 'readonly').objectStore(OV_STORE).get('#sigs'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
    const sigs = [sig, ...(Array.isArray(meta) ? meta.filter((x) => x !== sig) : [])];
    await new Promise((res) => {
      try {
        const t = db.transaction(OV_STORE, 'readwrite'), os = t.objectStore(OV_STORE);
        for (const d of sigs.slice(2)) os.delete(IDBKeyRange.bound(d + '|', d + '|\uffff'));
        os.put(sigs.slice(0, 2), '#sigs');
        t.oncomplete = t.onerror = t.onabort = () => res();
      } catch { res(); }
    });
  } catch { /* no storage: nothing is kept */ } finally { overview.saving = false; }
}

const pool = { workers: [], ready: 0, failed: false, inflight: new Map(), version: -1, err: '', why: '', failedTiles: new Set(), tileErrorCount: 0, tileErrorReported: false, fallbackReported: false };

function startTileWorkers() {
  let off = false;
  try { off = !!localStorage.getItem('mapMakerNoWorkers'); } catch {}
  if (off || pool.workers.length || pool.failed || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return;
  // Size the worker pool from available memory, not cores. Each worker parses its own basemap.json and builds
  // its own atlas/scenery/fonts (~⅓ GB). navigator.deviceMemory reports GiB (approx); on WebKitGTK it is
  // undefined, so default to 1 worker. Clamp the mapMakerWorkers override against a 1 GB worker budget.
  // NOTE: Workers do not share the parsed basemap (see E25). Until they do, more workers = linear RAM growth.
  const deviceMem = navigator.deviceMemory; // GiB, undefined on WebKitGTK / some contexts
  const memBudgetGB = 1; // target max worker memory
  const estWorkerGB = 0.33; // measured ~⅓ GB per worker
  let maxByMem = deviceMem ? Math.max(1, Math.floor(deviceMem * memBudgetGB / estWorkerGB)) : 1;
  let count = Math.max(1, Math.min(maxByMem, Math.ceil((navigator.hardwareConcurrency || 4) / 2) - 1));
  try {
    const n = parseInt(localStorage.getItem('mapMakerWorkers'), 10);
    if (n >= 1 && n <= 8) {
      if (n > maxByMem) {
        count = maxByMem;
        dbgLog('workers: mapMakerWorkers=' + n + ' clamped to ' + maxByMem + ' (deviceMemory ' + (deviceMem || 'unknown') + ' GiB, budget ' + memBudgetGB + ' GB)');
      } else {
        count = n;
      }
    }
  } catch { /* default */ }
  for (let n = 0; n < count; n++) {
    let worker;
    try { worker = newTileWorker(); } catch { pool.failed = true; return; }
    worker.jobs = 0;
    worker.ready = false;
    worker.onmessage = (e) => onWorkerMessage(worker, e.data);
    worker.onerror = (e) => { pool.err = String(e?.message || 'worker error'); dbgLog('worker error: ' + pool.err); failWorkers(); };
    worker.postMessage({ type: 'init', state: workerState() });
    pool.workers.push(worker);
  }
  setTimeout(() => { if (!pool.ready && pool.workers.length) { pool.why = 'timeout 5s'; dbgLog('workers: timeout 5s'); failWorkers(); } }, 5000);
}

function failWorkers() {
  pool.failed = true;
  for (const w of pool.workers) {
    if (w._blobUrl) { URL.revokeObjectURL(w._blobUrl); w._blobUrl = null; }
    w.terminate();
  }
  pool.workers = [];
  pool.ready = 0;
  pool.inflight.clear();
  if (pool.why && !pool.fallbackReported) {
    pool.fallbackReported = true;
    flash('Tile prefetch unavailable (' + pool.why + ') — drawing will be slower.', true);
  }
  requestDraw();
}

function workerState() {
  return { baseState: draft.baseState, levelHide: [...hiddenLevel()], removed: [...removed], removedVines: [...removedVines], removedScene: [...removedScene], removedDeco: [...removedDeco], removedObjects: [...removedObjects], movedScene: [...movedScene], movedObjects: [...movedObjects], levelOrder: [...levelOrder], levelTf: [...levelTf], simulate: !!draft.simulate, baseEdits: draft.baseEdits || {}, version: baseVersion };
}

function onWorkerMessage(worker, m) {
  if (m.type === 'ready') {
    worker.ready = true;
    pool.ready++;
    if (worker._blobUrl) { URL.revokeObjectURL(worker._blobUrl); worker._blobUrl = null; }
    requestDraw();
    return;
  }
  if (m.type === 'unsupported') { pool.err = String(m.error || 'unsupported'); dbgLog('workers unsupported: ' + pool.err); failWorkers(); return; }
  if (m.type !== 'tile') return;
  worker.jobs--;
  pool.inflight.delete(m.key);
  if (m.error) {
    if (!pool.failedTiles.has(m.key)) {
      pool.failedTiles.add(m.key);
      pool.tileErrorCount++;
      dbgLog('tile failed: ' + m.key + ' ' + m.error);
      if (!pool.tileErrorReported) { pool.tileErrorReported = true; updateStatus(); }
    }
    return;
  }
  if (m.bitmap && m.key.startsWith(baseVersion + '|') && (m.gen ?? 0) >= (dirtyGen.get(m.key) || 0) && !tileCache.has(m.key)) {
    storeTile(m.key, m.bitmap);
    if (viewMissing) requestDraw();
    // Tiles in view are drawn on the spot, so one arriving changes nothing on screen: it only frees a worker for the next prefetch
    // request. (A redraw per tile used to cost a whole frame each, for as long as the prefetch ran.)
    if (loading?.render) requestDraw(); else if (prefetch) pumpPrefetch(tileWorkersReady());
  }
  else m.bitmap?.close?.();
}

let workersAsked = false;
function tileWorkersReady() {
  if (!workersAsked && baseSettled && baseOn()) { workersAsked = true; startTileWorkers(); } // the base game was loaded after the editor opened
  if (!pool.ready) return false;
  if (pool.version !== baseVersion + '/' + stateVersion) {
    pool.version = baseVersion + '/' + stateVersion;
    pool.inflight.clear();
    pool.failedTiles.clear(); // retry failed tiles on state change
    const state = workerState();
    for (const w of pool.workers) w.postMessage({ type: 'state', state });
  }
  return true;
}

// urgent: a tile in view. The prefetch leaves a slot per worker free, so tiles in view never queue behind it.
function requestTile(key, z, tx, ty, part = null, urgent = false) {
  if (pool.inflight.has(key)) return;
  if (pool.failedTiles.has(key)) return;
  const free = pool.workers.filter((w) => w.ready).sort((a, b) => a.jobs - b.jobs)[0];
  if (!free || free.jobs >= (urgent ? 3 : 2)) return;
  free.jobs++;
  pool.inflight.set(key, free);
  free.postMessage({ type: 'tile', key, z, tx, ty, part, gen: stateVersion });
}

const workerWarn = (m) => { try { console.warn('[tile-worker] ' + m); } catch { /* none */ } };
export async function workerInit(state) {
  if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('2d')) throw new Error('no OffscreenCanvas 2D');
  const bitmap = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
    const img = await createImageBitmap(await res.blob());
    img.complete = true;
    img.naturalWidth = img.width;
    img.naturalHeight = img.height;
    return img;
  };
  base = await (await fetch(MAPS + 'basemap.json')).json();
  gridCache = null;
  pieceStamps = null;
  const vines = [...new Set(base.defs.filter((d) => d.kind === 'vine').map((d) => d.sprite))];
  [atlasImg, sceneImg] = await Promise.all([bitmap(MAPS + base.art.atlas), bitmap(MAPS + base.scene.atlas)]);
  const fonts = await Promise.all((base.scene.fonts || []).map((f) => (f ? bitmap(MAPS + f.atlas) : null)));
  fonts.forEach((f, n) => { fontImages[n] = f; });
  const vineBitmaps = await Promise.all(vines.map((v) => bitmap(MAPS + 'vines/' + encodeURIComponent(v) + '.png').catch((e) => { workerWarn(String(e?.message || e)); return null; })));
  vines.forEach((v, n) => { if (vineBitmaps[n]) vineImages[v] = vineBitmaps[n]; });
  // The scene's backdrop images too. They are only drawn by the map view picture, but without
  // them that picture has a flat colour where the game would show sky/forest/whatever, and a
  // map is much easier to recognise by its backdrop than by its tiles.
  const backdrops = [...new Set([...(base.scene?.backgrounds || []).map((b) => b.img), ...(base.scene?.worldBackdrops || []).map((b) => b.img)].filter(Boolean))];
  const backdropBitmaps = await Promise.all(backdrops.map((src) => bitmap(MAPS + src).catch((e) => { workerWarn(String(e?.message || e)); return null; })));
  backdrops.forEach((src, n) => { if (backdropBitmaps[n]) bgImages[src] = backdropBitmaps[n]; });
  draft.useBase = true;
  workerSetState(state);
  const probe = new OffscreenCanvas(4, 4);
  probe.getContext('2d').drawImage(atlasImg, 0, 0, 4, 4);
  probe.transferToImageBitmap().close();
}

export function workerSetState(state) {
  removed = new Set(state.removed);
  hiddenInWorker = new Set(state.levelHide || []);
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
  baseVersion = Number.isFinite(state.version) ? state.version : 0; // the worker init state carries no version; undefined here made every ++ NaN and the levelOverrides cache never hit
}

// One canvas for every tile this worker draws: transferToImageBitmap hands the picture over and leaves it blank, ready for the next
// (a canvas and context per tile left the worker's garbage to pile up in hundreds of MB between collections).
let workerTileCanvas = null;
export function workerRenderTile(z, tx, ty, part = null) {
  workerTileCanvas ||= new OffscreenCanvas(TILE_PX, TILE_PX);
  return renderTile(z, tx, ty, part, workerTileCanvas).transferToImageBitmap();
}

// The backdrop the game shows for the map's area (the zone under the view's centre, in the map's base state), drawn once to fill the picture. Only the map view picture uses it; the editor never calls it. A map's own background image (own, handed in by the host) is drawn the same way.
function drawPreviewBackdrop(W, H, own = null) {
  if (own) {
    const k = Math.max(W / own.width, H / own.height), dw = own.width * k, dh = own.height * k;
    ctx.drawImage(own, (W - dw) / 2, (H - dh) / 2, dw, dh);
    own.close();
    return;
  }
  const zone = zoneAt(cam.x, cam.y);
  const bgs = (base?.scene?.backgrounds || []).filter((b) => b.zone === zone && (b.state === 'always' || b.state === draft.baseState)).sort((a, b) => a.o - b.o);
  for (const b of bgs) {
    const img = bgImage(b.img);
    if (!img.complete || !img.naturalWidth) continue;
    const k = Math.max(W / img.naturalWidth, H / img.naturalHeight), dw = img.naturalWidth * k, dh = img.naturalHeight * k;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
}

// The map view picture: Amplifier zoomed out over the whole map (the level when the map uses it, then its tiles, blocks, spikes, vines, moss and spawns/gates), fitted into W x H. Runs in the tile worker, whose module state is its own, so a live editor is never touched. `map` is a map.json object (v2 maps are converted first). Returns a PNG Blob, or null when the map has no editor data.
// `onProgress` (optional) is called, throttled, as bands and sprites are drawn, so the host can tell a long render from a hang.
let viewProgress = null, viewProgressAt = 0;
function tickProgress() { if (viewProgress) { const n = Date.now(); if (n - viewProgressAt > 500) { viewProgressAt = n; viewProgress(); } } }
export async function workerRenderMapView(map, W = 960, H = 540, onProgress = null, ownBg = null) {
  viewProgress = onProgress; viewProgressAt = 0;
  if (isV2(map)) {
    const gridOf = (name) => ({ ...layerGrid(name), mats: base?.mats });
    const vineSprites = base.defs.filter((d) => d.kind === 'vine').map((d) => d.sprite);
    map = { ...map, editor: toV1State(map, gridOf, vineSprites) };
  }
  if (!map?.editor) return null;
  draft = emptyDraft();
  loadDraftFrom(map.editor);
  applyBaseState();
  applyBaseMoves();
  syncRemovedPaths();
  baseVersion++;
  let area = baseOn() ? null : exportArea();
  if (!area) {
    // A map on the base game with nothing else: the cells it changed, else the level itself.
    const b = baseOn() ? levelBounds() : null;
    const ch = exportArea();
    if (ch) area = ch;
    else if (b && Number.isFinite(b.x0)) area = { x0: Math.floor(b.x0 / CELL), x1: Math.ceil(b.x1 / CELL), y0: Math.floor((b.y0 - OFFSET_Y) / CELL), y1: Math.ceil((b.y1 - OFFSET_Y) / CELL) };
    else area = { x0: -20, x1: 20, y0: -10, y1: 10 };
  }
  const lo = cellWorld(area.x0, area.y0), hi = cellWorld(area.x1 + 1, area.y1 + 1);
  const aw = Math.max(hi.x - lo.x, CELL * 8), ah = Math.max(hi.y - lo.y, CELL * 8);
  const ss = 2; // drawn at twice the size, then scaled down: smoother than a 0.02 zoom drawn directly
  const w = W * ss, h = H * ss;
  const scale = Math.min(MAX_SCALE, (w * 0.92) / aw, (h * 0.92) / ah);
  const cv = makeCanvas();
  cv.width = w; cv.height = h;
  const saved = [canvas, ctx, cam, renderPart];
  canvas = cv; ctx = guardCtx(cv.getContext('2d', { alpha: false })); cam = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, scale }; renderPart = null;
  staticRender = true;
  try {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    // The backdrop, at full strength and before the tiles. The game fades backdrops out as you
    // zoom away, and a whole-map view is about as far out as it goes, so the normal fade would
    // leave nothing drawn at all - and the backdrop is most of what makes a map recognisable at
    // a glance. Passed 1 rather than backdropFade() for that reason.
    try {
      // Zoomed far out (a whole big map) the tiled backdrop is a few pixels per copy, so the picture gets one backdrop, cover-fitted behind everything.
      if (ownBg) drawPreviewBackdrop(w, h, await createImageBitmap(ownBg));
      else if (scale < 0.1) drawPreviewBackdrop(w, h); else drawBackground(w, h, 1);
    } catch (e) { workerWarn('background: ' + (e?.message || e)); }
    const useArt = artReady();
    if (baseOn()) renderBaseLayer(w, h, useArt);
    drawCellLayers(useArt, scale < 0.1 ? 0.6 : 0.5);
    try { drawCourses(); } catch (e) { console.warn('[map view] gates', e); }
  } finally {
    staticRender = false;
    viewProgress = null;
    [canvas, ctx, cam, renderPart] = saved;
  }
  const out = makeCanvas();
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(cv, 0, 0, W, H);
  cv.width = cv.height = 0; // the 2x scratch picture is not needed any more
  try { return await out.convertToBlob({ type: 'image/png' }); } finally { out.width = out.height = 0; }
}

// Your tiles, blocks, spikes, vines and moss over the current view, back to front; keyed by cell so only the view's range is visited. `tileMargin` is how far past the view a tile's centre may be and still draw. `region` is a world rect to draw instead of the whole view (an edit's changed cells).
function drawCellLayers(useArt, pad, tileMargin = CELL, region = null) {
  const W = canvas.width, H = canvas.height;
  const tl = cellOf(toWorld(0, 0).x, toWorld(0, 0).y), br = cellOf(toWorld(W, H).x, toWorld(W, H).y);
  let minCx = tl.cx - 1, maxCx = br.cx + 1, minCy = br.cy - 1, maxCy = tl.cy + 1;
  if (region) {
    const a = cellOf(region[0], region[1]), b = cellOf(region[2], region[3]);
    minCx = Math.max(minCx, a.cx - 1); maxCx = Math.min(maxCx, b.cx + 1);
    minCy = Math.max(minCy, a.cy - 1); maxCy = Math.min(maxCy, b.cy + 1);
  }
  if (useArt && !layerHidden('tiles')) drawPlacedTiles(false, tileMargin, region);
  if (useArt && !layerHidden('blocks') && baseOn()) for (const [, o] of levelOverrides().cells) if (o.cx >= minCx && o.cx <= maxCx && o.cy >= minCy && o.cy <= maxCy) drawGroundArt(o.cx, o.cy, o.art);
  if (!layerHidden('blocks')) blocks.forEachIn(minCx, minCy, maxCx, maxCy, (k, kind, cx, cy) => {
    if (useArt) {
      const art = blockArt(kind, cx, cy);
      if (art && drawGroundArt(cx, cy, art)) return;
    }
    const r = cellRect(cx, cy);
    ctx.fillStyle = COLORS[kind] || BLOCK_SETS[kind]?.color || COLORS.ground;
    ctx.fillRect(r.x, r.y, r.w + pad, r.h + pad);
  });
  if (!layerHidden('hazards')) {
    spikes.forEachIn(minCx, minCy, maxCx, maxCy, (k, sp, cx, cy) => {
      const q = spikeTurn(sp, cx, cy);
      if (sp.c === 'true') return drawTrueSpike(cx, cy, q);
      if (useArt && base) { const t = spikeTile(sp.c, q); if (drawTileArt(cx, cy, t.tile, t.matrix)) return; }
      drawSpike(cx, cy, q, COLORS[sp.c]);
    });
    vines.forEachIn(minCx - 6, minCy - 6, maxCx + 6, maxCy + 6, (k, v, cx, cy) => drawVine(cx, cy, v.s, rotMatrix(v.q)));
  }
  // Moss is keyed by the moss layer's own grid (64px cells), not 32px ones.
  if (!layerHidden('blocks') && mossCells.size) {
    const mg = layerGrid('moss');
    const gx0 = Math.floor((minCx * CELL - mg.ox) / mg.size) - 1, gx1 = Math.ceil(((maxCx + 1) * CELL - mg.ox) / mg.size) + 1;
    const gy0 = Math.floor((minCy * CELL + OFFSET_Y - mg.oy) / mg.size) - 1, gy1 = Math.ceil(((maxCy + 1) * CELL + OFFSET_Y - mg.oy) / mg.size) + 1;
    mossCells.forEachIn(gx0, gy0, gx1, gy1, (k) => {
      if (!useArt || !drawMoss(k)) { const c = mossCenter(k), a = toScreen(c.x - mg.size / 2, c.y + mg.size / 2); ctx.fillStyle = COLORS.moss; ctx.fillRect(a.x, a.y, mg.size * cam.scale, mg.size * cam.scale); }
    });
  }
  if (useArt && !layerHidden('tiles')) drawPlacedTiles(true, tileMargin, region);
}

// ---- the picture cache: the sequence above, drawn once into 512px chunks at power-of-two zooms (panning only blits them) ----
const CC_PX = 512, CC_MAX = 96, CC_LOW = -6, CC_HIGH = 2;
// A chunk with no more than this many changed rectangles is patched (just those pixels redrawn) rather than drawn again whole.
const CC_PATCH_MAX = 24;
// How long a chunk may keep showing the picture from before an edit before it is dropped: what is on
// screen is either current or plainly old, never old and claimed to be current.
const CC_STALE_MS = 1200;
// How many chunks on screen may still be waiting for their picture before the status bar says the view
// is being rebuilt (the old picture is on show until then).
const CC_BACKLOG = 4;
// Whether the view is behind, and when the status bar was last told about it.
let ccBacklog = false, ccBacklogAt = 0, ccBacklogPending = false;
function ccBacklogNote(backlog) {
  const busy = backlog > CC_BACKLOG;
  if (busy !== ccBacklog) { ccBacklog = busy; ccBacklogPending = true; }
  if (!ccBacklogPending) return;
  const now = performance.now();
  if (now - ccBacklogAt < 500) return; // said it a moment ago: not on every frame
  ccBacklogAt = now;
  ccBacklogPending = false;
  try { updateStatus(); } catch { /* the status bar is not up yet */ }
}
const cellCache = { chunks: new Map(), pool: [], refs: null, sig: '', cold: true, fulls: 0 };
// The cells an edit changed: drawn live on top of the stale chunk, so the edit shows in the same frame.
const ccEdit = { rects: [] };
const cellCachePatchOff = () => { try { return localStorage.mapMakerNoCCPatch === '1'; } catch { return false; } };
const cellCacheOff = () => { try { return localStorage.mapMakerNoCellCache === '1'; } catch { return false; } };
const ccSpan = (z) => CC_PX / Math.pow(2, z);
const ccKey = (z, tx, ty) => z + '|' + tx + '|' + ty;
// Stale chunks stay on screen until their replacement is built, so a change never opens a hole.
// hard: the collections themselves were replaced (another map, rebuilt state), so the old picture is wrong, not just old: drop it and give the rebuild the bigger budget.
function ccDropAll(hard) {
  cellCache.fulls++; // how many frames had to redraw everything: the cliff the notes count
  if (dbg.on) { dbg.cur.drops = (dbg.cur.drops || 0) + 1; dbgLog('ccDropAll ' + (hard ? 'hard' : 'soft')); }
  if (hard) {
    for (const c of cellCache.chunks.values()) { if (cellCache.pool.length < 8) cellCache.pool.push(c.cv); else freeCanvas(c.cv); }
    cellCache.chunks.clear();
    cellCache.cold = true;
    ccEdit.rects.length = 0;
    return;
  }
  // A pan or a zoom: the old picture is kept until its replacement is built, so nothing opens a hole.
  const now = performance.now();
  for (const c of cellCache.chunks.values()) { if (!c.stale) c.at = now; c.stale = true; c.full = true; c.dirty = null; }
}
function ccDropRects(rects) {
  const now = performance.now();
  for (const c of cellCache.chunks.values()) {
    const span = ccSpan(c.z), x0 = c.tx * span, y0 = c.ty * span;
    // An edit: its cells are drawn live until the chunk is built, so the change is never hidden.
    const hit = rects.filter((r) => r[0] < x0 + span && r[2] > x0 && r[1] < y0 + span && r[3] > y0);
    if (hit.length) {
      c.stale = true; c.edit = true; c.at = now;
      // Which parts of the picture are wrong, so the rebuild can redraw just those (ccPatch) instead of the whole chunk.
      if (!c.full) { c.dirty = (c.dirty || []).concat(hit); if (c.dirty.length > CC_PATCH_MAX) { c.full = true; c.dirty = null; } }
    }
  }
  ccEdit.rects.push(...rects);
  if (ccEdit.rects.length > 64) ccEdit.rects.splice(0, ccEdit.rects.length - 64);
}
// Everything changed (too many notes to list): the whole view is drawn live, so the change shows at once.
function ccEditAll() {
  const now = performance.now();
  for (const c of cellCache.chunks.values()) { c.stale = true; c.edit = true; c.at = now; c.full = true; c.dirty = null; }
  const a = toWorld(0, 0), b = toWorld(canvas.width, canvas.height);
  ccEdit.rects.length = 0;
  ccEdit.rects.push([Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]);
}
// Compare what the cached pictures were drawn from with what's there now; drop what's stale.
function ccSync() {
  const cc = cellCache;
  const refs = [tiles, blocks, spikes, vines, mossCells, removed, atlasImg, base, groundSet, mossSet, blueSet, orangeSet, baseHaz];
  const sig = [layerHidden('tiles'), layerHidden('blocks'), layerHidden('hazards'), artReady(), baseOn(), baseVersion, draft.baseState].join('|');
  const sameRefs = !!cc.refs && refs.every((r, i) => r === cc.refs[i]);
  const same = sameRefs && cc.sig === sig;
  cc.refs = refs;
  cc.sig = sig;
  const all = !same;
  // Taken even when everything goes, so the notes don't pile up.
  const rects = [];
  const take = (coll, toRect, chunkRect) => {
    const d = coll.takeDirty();
    if (d === null) return true;
    if (d.chunked) for (const k of d) rects.push(chunkRect(k));
    else for (const k of d) rects.push(toRect(k));
    return false;
  };
  const cellRectOf = (m) => (k) => { const c = k.indexOf(','), w = cellWorld(+k.slice(0, c), +k.slice(c + 1)); return [w.x - m, w.y - m, w.x + CELL + m, w.y + CELL + m]; };
  const cellChunkRect = (m) => (ck) => {
    const [cx, cy] = ck.split(',').map(Number);
    const w0 = cellWorld(cx * CHUNK, cy * CHUNK), w1 = cellWorld((cx + 1) * CHUNK - 1, (cy + 1) * CHUNK - 1);
    return [w0.x - m, w0.y - m, w1.x + CELL + m, w1.y + CELL + m];
  };
  const mossRect = (k) => { const c = mossCenter(k), h = layerGrid('moss').size / 2 + 128; return [c.x - h, c.y - h, c.x + h, c.y + h]; };
  const mossChunkRect = (ck) => {
    const [cx, cy] = ck.split(',').map(Number);
    const c0 = mossCenter(cx * CHUNK + ',' + cy * CHUNK), c1 = mossCenter((cx + 1) * CHUNK - 1 + ',' + (cy + 1) * CHUNK - 1);
    const h = layerGrid('moss').size / 2 + 128;
    return [c0.x - h, c0.y - h, c1.x + h, c1.y + h];
  };
  const tileRect = (k) => { const l = k.slice(0, k.lastIndexOf('|')), c = tileCenter(l, k), h = layerGrid(l).size / 2 + 128; return [c.x - h, c.y - h, c.x + h, c.y + h]; };
  const tileChunkRect = (ck) => {
    const bar = ck.lastIndexOf('|'), layer = ck.slice(0, bar);
    const [cx, cy] = ck.slice(bar + 1).split(',').map(Number);
    const g = layerGrid(layer);
    return [g.ox + cx * CHUNK * g.size - 128, g.oy + cy * CHUNK * g.size - 128, g.ox + (cx + CHUNK) * g.size + 128, g.oy + (cy + CHUNK) * g.size + 128];
  };
  // Past one cell of reach: a block changes the seating of spikes two cells away, and a vine is up to six cells wide.
  const lost = [take(tiles, tileRect, tileChunkRect), take(blocks, cellRectOf(3 * CELL), cellChunkRect(3 * CELL)), take(spikes, cellRectOf(3 * CELL), cellChunkRect(3 * CELL)), take(vines, cellRectOf(6 * CELL), cellChunkRect(6 * CELL)), take(mossCells, mossRect, mossChunkRect), take(removed, cellRectOf(6 * CELL), cellChunkRect(6 * CELL))];
  if (all) ccDropAll(!sameRefs);
  // Everything changed: the old picture is wrong all over, so it is drawn live instead of waited for.
  else if (lost.includes(true) || rects.length > 2000) { ccDropAll(false); ccEditAll(); }
  else if (rects.length) ccDropRects(rects);
}
// An edited chunk, brought up to date by redrawing only the pixels its changed cells cover: cleared, then the cells in that box drawn again, clipped to it. Every pixel in the box gets the same layers in the same order as a whole-chunk draw would give it, and the pixels outside it were not touched by the edit.
let patchScratch = null;
function ccPatch(c, useArt, pad) {
  const span = ccSpan(c.z), s = Math.pow(2, c.z), x0w = c.tx * span, y1w = (c.ty + 1) * span;
  let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
  for (const r of c.dirty) {
    px0 = Math.min(px0, (r[0] - x0w) * s); px1 = Math.max(px1, (r[2] - x0w) * s);
    py0 = Math.min(py0, (y1w - r[3]) * s); py1 = Math.max(py1, (y1w - r[1]) * s);
  }
  px0 = Math.max(0, Math.floor(px0)); py0 = Math.max(0, Math.floor(py0)); px1 = Math.min(CC_PX, Math.ceil(px1)); py1 = Math.min(CC_PX, Math.ceil(py1));
  if (px1 > px0 && py1 > py0) {
    // Drawn on a scratch picture a margin wider than the box, and only the box copied back: pixels at the edge of a clip are not always what the same draw gives unclipped, so none of them are used.
    const M = 16, w = px1 - px0, h = py1 - py0, sw = w + 2 * M, sh = h + 2 * M;
    const sc = patchScratch || (patchScratch = makeCanvas());
    if (sc.width !== sw || sc.height !== sh) { sc.width = sw; sc.height = sh; }
    const sg = guardCtx(sc.getContext('2d'));
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalAlpha = 1;
    sg.clearRect(0, 0, sw, sh);
    const saved = [canvas, ctx, cam];
    canvas = sc; ctx = sg;
    cam = { x: x0w + (px0 - M + sw / 2) / s, y: y1w - (py0 - M + sh / 2) / s, scale: s };
    let drew = 0;
    const names = ['drawImage', 'fillRect', 'fill', 'stroke', 'strokeRect', 'fillText', 'strokeText'];
    const own = names.map((n) => (Object.prototype.hasOwnProperty.call(sg, n) ? sg[n] : undefined));
    names.forEach((n) => { const f = sg[n]; sg[n] = function (...a) { drew++; return f.apply(this, a); }; });
    try { drawCellLayers(useArt, pad, 4 * CELL, [cam.x - sw / 2 / s - CELL, cam.y - sh / 2 / s - CELL, cam.x + sw / 2 / s + CELL, cam.y + sh / 2 / s + CELL]); }
    finally {
      [canvas, ctx, cam] = saved;
      names.forEach((n, i) => { if (own[i]) delete sg[n]; else delete sg[n]; });
    }
    const g = guardCtx(c.cv.getContext('2d'));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(px0, py0, w, h);
    g.drawImage(sc, M, M, w, h, px0, py0, w, h);
    if (drew) c.empty = false;
  }
  c.stale = false; c.edit = false; c.dirty = null; c.full = false;
  cellCache.chunks.delete(ccKey(c.z, c.tx, c.ty));
  cellCache.chunks.set(ccKey(c.z, c.tx, c.ty), c);
  return c;
}
function ccRender(z, tx, ty, useArt, pad) {
  const cc = cellCache, span = ccSpan(z), s = Math.pow(2, z);
  const old = cc.chunks.get(ccKey(z, tx, ty));
  if (old && old.edit && old.stale && !old.full && !old.kids && old.dirty?.length && !cellCachePatchOff()) return ccPatch(old, useArt, pad);
  const cv = cc.pool.pop() || makeCanvas();
  if (cv.width !== CC_PX) cv.width = cv.height = CC_PX;
  const g = guardCtx(cv.getContext('2d'));
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.clearRect(0, 0, CC_PX, CC_PX);
  const saved = [canvas, ctx, cam];
  canvas = cv;
  ctx = g;
  cam = { x: (tx + 0.5) * span, y: (ty + 0.5) * span, scale: s };
  // Whether anything was drawn at all: a chunk of empty ground is not blitted over the view (most far-out chunks are).
  let drew = 0, fromKids = false;
  const names = ['drawImage', 'fillRect', 'fill', 'stroke', 'strokeRect', 'fillText', 'strokeText'];
  const own = names.map((n) => (Object.prototype.hasOwnProperty.call(g, n) ? g[n] : undefined));
  names.forEach((n) => { const f = g[n]; g[n] = function (...a) { drew++; return f.apply(this, a); }; });
  try {
    // Far out, a chunk is its four finer chunks shrunk by half when they are all there (zooming out), not the cells walked again.
    const kids = z < CC_HIGH && !mipsOff() ? [0, 1].flatMap((b) => [0, 1].map((a) => { const k = cc.chunks.get(ccKey(z + 1, tx * 2 + a, ty * 2 + b)); return k && !k.stale ? [k, a, b] : null; })) : [];
    if (kids.length === 4 && kids.every(Boolean)) {
      fromKids = true;
      for (const [k, a, b] of kids) if (!k.empty) { g.drawImage(k.cv, a * CC_PX / 2, (1 - b) * CC_PX / 2, CC_PX / 2, CC_PX / 2); drew++; }
    } else drawCellLayers(useArt, pad, 4 * CELL);
  } finally {
    [canvas, ctx, cam] = saved;
    names.forEach((n, i) => { if (own[i]) g[n] = own[i]; else delete g[n]; });
  }
  const c = { z, tx, ty, cv, stale: false, empty: drew === 0, kids: fromKids };
  if (old) cc.chunks.delete(ccKey(z, tx, ty));
  cc.chunks.set(ccKey(z, tx, ty), c);
  if (old) { if (cc.pool.length < 8) cc.pool.push(old.cv); else freeCanvas(old.cv); }
  return c;
}
// Something to show in place of a chunk that isn't built: the same area from a coarser level, or four finer chunks.
function ccSubstitute(z, tx, ty, x0, y0, x1, y1) {
  const get = (zz, a, b) => { const c = cellCache.chunks.get(ccKey(zz, a, b)); if (c) { cellCache.chunks.delete(ccKey(zz, a, b)); cellCache.chunks.set(ccKey(zz, a, b), c); } return c; };
  for (let zz = z - 1; zz >= CC_LOW; zz--) {
    const f = Math.pow(2, z - zz), px = Math.floor(tx / f), py = Math.floor(ty / f), c = get(zz, px, py);
    if (!c) continue;
    const sz = CC_PX / f, i = tx - px * f, j = ty - py * f;
    ctx.drawImage(c.cv, i * sz, (f - 1 - j) * sz, sz, sz, x0, y0, x1 - x0, y1 - y0);
    return true;
  }
  if (z < CC_HIGH) {
    let any = false;
    const mx = Math.round((x0 + x1) / 2), my = Math.round((y0 + y1) / 2);
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const c = get(z + 1, tx * 2 + a, ty * 2 + b);
      if (!c) continue;
      const dx0 = a ? mx : x0, dx1 = a ? x1 : mx, dy0 = b ? y0 : my, dy1 = b ? my : y1;
      ctx.drawImage(c.cv, dx0, dy0, dx1 - dx0, dy1 - dy0);
      any = true;
    }
    return any;
  }
  return false;
}
function drawCellView(useArt, pad) {
  const cc = cellCache;
  if (cellCacheOff() || cam.scale > Math.pow(2, CC_HIGH)) {
    ccSync();
    ccEdit.rects.length = 0; // the live path draws everything, so nothing waits for a chunk
    ccBacklogNote(0); // nothing is waiting for a picture
    return drawCellLayers(useArt, pad);
  }
  ccSync();
  const W = canvas.width, H = canvas.height;
  const z = Math.max(CC_LOW, Math.min(CC_HIGH, Math.ceil(Math.log2(cam.scale)))), span = ccSpan(z);
  const a = toWorld(0, 0), b = toWorld(W, H);
  const tx0 = Math.floor(Math.min(a.x, b.x) / span), tx1 = Math.floor(Math.max(a.x, b.x) / span);
  const ty0 = Math.floor(Math.min(a.y, b.y) / span), ty1 = Math.floor(Math.max(a.y, b.y) / span);
  const view = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) view.push({ tx, ty, d: Math.hypot((tx + 0.5) * span - cam.x, (ty + 0.5) * span - cam.y) });
  view.sort((p, q) => p.d - q.d);
  // The chunks an edit changed: they are built first, so the change shows in the same frame.
  const edited = new Set();
  for (const v of view) { const c = cc.chunks.get(ccKey(z, v.tx, v.ty)); if (c?.edit) edited.add(ccKey(z, v.tx, v.ty)); }
  // A chunk that has been stale past its bound is dropped: it may not show a picture from before the edit.
  const now = performance.now();
  for (const [k, c] of [...cc.chunks]) if (c.edit && c.stale && now - (c.at || 0) > CC_STALE_MS) {
    cc.chunks.delete(k);
    if (cc.pool.length < 8) cc.pool.push(c.cv); else freeCanvas(c.cv);
    if (dbg.on) dbgLog('cc stale dropped ' + k);
  }
  const missing = view.filter((v) => { const c = cc.chunks.get(ccKey(z, v.tx, v.ty)); return !c || c.stale; });
  missing.sort((p, q) => (edited.has(ccKey(z, p.tx, p.ty)) ? 0 : 1) - (edited.has(ccKey(z, q.tx, q.ty)) ? 0 : 1));
  const t0 = performance.now(), budget = cc.cold ? 40 : 10;
  let built = 0;
  while (built < missing.length && (!built || performance.now() - t0 < budget)) {
    const v = missing[built++];
    ccRender(z, v.tx, v.ty, useArt, pad);
  }
  cc.cold = false;
  if (dbg.on) Object.assign(dbg.cur, { built, ccMissing: missing.length });
  if (built < missing.length) requestDraw();
  // The chunks on screen still waiting for their picture: the view is behind, and the status bar says so.
  ccBacklogNote(missing.length - built);
  // The chunks still showing the old picture: their changed cells are cleared and drawn live.
  const areas = ccStaleAreas(view, z);
  ccClearChanged(areas);
  for (const v of view) {
    const p = toScreen(v.tx * span, (v.ty + 1) * span), q = toScreen((v.tx + 1) * span, v.ty * span);
    const x0 = Math.round(p.x), y0 = Math.round(p.y), x1 = Math.round(q.x), y1 = Math.round(q.y);
    if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H || !inStrips(x0, y0, x1, y1)) continue;
    const k = ccKey(z, v.tx, v.ty), c = cc.chunks.get(k);
    if (c) { cc.chunks.delete(k); cc.chunks.set(k, c); if (!c.empty || c.stale) ctx.drawImage(c.cv, x0, y0, x1 - x0, y1 - y0); if (dbg.on && c.stale) ccStaleMark(x0, y0, x1 - x0, y1 - y0); }
    else if (ccSubstitute(z, v.tx, v.ty, x0, y0, x1, y1)) dbg.cur.stand = (dbg.cur.stand || 0) + 1;
    else dbg.cur.none = (dbg.cur.none || 0) + 1;
  }
  // The cells an edit changed, drawn live on top of the picture that is still the old one.
  ccLive(useArt, pad, areas);
  // Oldest first out, but never what's in view.
  const cap = Math.max(Math.round(CC_MAX * cacheScale), view.length + 24);
  for (const [k, c] of cc.chunks) { if (cc.chunks.size <= cap) break; cc.chunks.delete(k); if (cc.pool.length < 8) cc.pool.push(c.cv); else freeCanvas(c.cv); }
}

// In debug mode a stale chunk is marked, so the state is visible while developing.
function ccStaleMark(x, y, w, h) {
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#ff0';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}
// The changed cells of the chunks that still show the old picture, in world and screen pixels.
function ccStaleAreas(view, z) {
  if (!ccEdit.rects.length) return [];
  const span = ccSpan(z), W = canvas.width, H = canvas.height, out = [];
  for (const v of view) {
    const c = cellCache.chunks.get(ccKey(z, v.tx, v.ty));
    if (!c || !c.edit || !c.stale) continue;
    for (const r of ccEdit.rects) {
      const x0 = Math.max(r[0], v.tx * span), y0 = Math.max(r[1], v.ty * span);
      const x1 = Math.min(r[2], (v.tx + 1) * span), y1 = Math.min(r[3], (v.ty + 1) * span);
      if (x1 <= x0 || y1 <= y0) continue;
      const p = toScreen(x0, y1), q = toScreen(x1, y0);
      const rx0 = Math.round(p.x), ry0 = Math.round(p.y), rx1 = Math.round(q.x), ry1 = Math.round(q.y);
      if (rx1 <= 0 || ry1 <= 0 || rx0 >= W || ry0 >= H) continue;
      out.push({ c, x0, y0, x1, y1, rx0, ry0, rx1, ry1 });
    }
  }
  return out;
}
// The changed cells are cleared in the chunk that still shows the old picture: the old block is not
// left lying under the new one.
function ccClearChanged(areas) {
  for (const a of areas) {
    const c = a.c, s = Math.pow(2, c.z), span = ccSpan(c.z);
    // The chunk's own pixels, a little inside the area so the edge of the old picture is not left.
    const px = (a.x0 - c.tx * span) * s + 2, py = ((c.ty + 1) * span - a.y1) * s + 2;
    const pw = (a.x1 - a.x0) * s - 4, ph = (a.y1 - a.y0) * s - 4;
    if (pw <= 0 || ph <= 0) continue;
    try { c.cv.getContext('2d').clearRect(px, py, pw, ph); } catch { /* the canvas is gone */ }
  }
}
// The cells an edit changed, drawn live over the stale chunk: the edit shows in the same frame, even
// where the chunk behind it is still the one from before the change.
function ccLive(useArt, pad, areas) {
  // Nothing waits for a rebuild any more: the picture on screen is current, so the live draw stops.
  if (!areas.length) { ccEdit.rects.length = 0; return; }
  const rects = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of areas) {
    rects.push([a.rx0, a.ry0, a.rx1 - a.rx0, a.ry1 - a.ry0]);
    x0 = Math.min(x0, a.x0); y0 = Math.min(y0, a.y0); x1 = Math.max(x1, a.x1); y1 = Math.max(y1, a.y1);
  }
  ctx.save();
  ctx.beginPath();
  for (const r of rects) ctx.rect(r[0], r[1], r[2], r[3]);
  ctx.clip();
  drawCellLayers(useArt, pad, CELL, [x0, y0, x1, y1]);
  ctx.restore();
}

// Debug strip: localStorage.mapMakerDebug = '1' or Ctrl+Shift+D in the editor (release builds have no devtools).
// Counters over the canvas, a log ring, and a "Copy debug log" button.
const dbg = { on: false, n: 0, ring: [], el: null, pre: null, cur: {} };
try { dbg.on = localStorage.mapMakerDebug === '1'; } catch { /* off */ }
function dbgLog(msg) { if (!dbg.on) return; dbg.ring.push(((performance.now() / 1000).toFixed(3)) + ' f' + dbg.n + ' ' + msg); if (dbg.ring.length > 400) dbg.ring.shift(); }
function dbgReport() {
  const r = (c) => { try { const b = c.getBoundingClientRect(); return b.width.toFixed(0) + 'x' + b.height.toFixed(0) + ' css'; } catch { return '?'; } };
  const sz = (c) => c ? c.width + 'x' + c.height : '-';
  const mb = ((tileCache.size * TILE_PX * TILE_PX + cellCache.chunks.size * CC_PX * CC_PX) * 4 / 1048576).toFixed(0);
  return [
    'Amplifier debug log ' + new Date().toISOString(),
    'userAgent: ' + navigator.userAgent,
    'page: ' + location.protocol + '//' + location.host + ' Worker=' + (typeof Worker !== 'undefined') + ' OffscreenCanvas=' + (typeof OffscreenCanvas !== 'undefined') + ' createImageBitmap=' + (typeof createImageBitmap !== 'undefined'),
    'art: ready=' + artReady() + ' sceneReady=' + sceneReady() + ' atlas=' + (atlasImg ? atlasImg.naturalWidth + 'x' + atlasImg.naturalHeight : 'none') + ' scene=' + (sceneImg ? sceneImg.naturalWidth + 'x' + sceneImg.naturalHeight : 'none') + ' plants=' + (plantList?.length ?? 'none'),
    'draft: useBase=' + draft.useBase + ' baseOn=' + baseOn() + ' state=' + draft.baseState + ' bg=' + JSON.stringify(draft.background ?? null) + ' layers=' + JSON.stringify(draft.layers || {}) + ' hiddenGroups=' + (draft.hiddenGroups || []).length + ' moss=' + mossCells.size,
    'workers: n=' + pool.workers.length + ' ready=' + pool.ready + ' failed=' + pool.failed + ' why=' + (pool.why || '-') + ' err=' + (pool.err || '-') + ' noWorkers=' + (() => { try { return !!localStorage.getItem('mapMakerNoWorkers'); } catch { return '?'; } })(),
    'assets: ' + [...assetLog].filter(([, v]) => v.ok).length + ' ok; failed: ' + ([...assetLog].filter(([, v]) => !v.ok).map(([k, v]) => k + ' x' + v.tries + ' ' + v.err).join('; ') || 'none'),
    'bgImages: ' + Object.entries(bgImages).map(([k, v]) => k + (v.complete && v.naturalWidth ? ' ok' : v.failed ? ' FAILED' : ' pending')).join(', '),
    'devicePixelRatio: ' + window.devicePixelRatio + ' screen ' + screen.width + 'x' + screen.height,
    'canvases: visible ' + sz(visCanvas) + ' (' + (visCanvas ? r(visCanvas) : '?') + '), back ' + sz(backCanvas),
    'caches: tiles ' + tileCache.size + '/' + maxTiles() + ', chunks ' + cellCache.chunks.size + ' (pool ' + cellCache.pool.length + '), tileJobs ' + tileJobs.size + ', ahead ' + aheadQueue.size + ', ~' + mb + ' MB, lostCanvases ' + lostCanvases.size + ', cacheScale ' + cacheScale.toFixed(2),
    'overview: ' + JSON.stringify({ persisted: overview.persisted.size, sig: overview.persistedSig ? 'set' : '-', dirty: overview.dirty, saving: overview.saving, reason: overview.reason || 'ok' }),
    'counters: ' + Object.entries(flick).map(([k, v]) => k + '=' + v).join(' ') + ' frames=' + dbg.n,
    'baseVersion ' + baseVersion + ' stateVersion ' + stateVersion + ' scale ' + cam.scale.toFixed(4),
    '--- ring (' + dbg.ring.length + ') ---',
    ...dbg.ring,
  ].join('\n');
}
function dbgCopy() {
  const text = dbgReport();
  console.log(text);
  const done = () => flash('Debug log copied');
  const fallback = () => {
    // No async clipboard (or it was refused): a textarea to select, copied with execCommand when that works.
    const ta = document.createElement('textarea');
    ta.value = text; ta.readOnly = true;
    ta.style.cssText = 'position:fixed;left:8px;right:8px;bottom:60px;height:35%;z-index:9999;font:11px monospace;background:#111;color:#9f9;border:1px solid #9f9';
    ta.title = 'Select all and copy; Esc or click away closes this';
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') ta.remove(); });
    ta.addEventListener('blur', () => setTimeout(() => ta.remove(), 150));
    (canvas?.parentElement || document.body).appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* manual */ }
    if (ok) { ta.remove(); done(); } else flash('Select the text and press Ctrl+C');
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
function setDebug(on) {
  dbg.on = on;
  try { if (on) localStorage.mapMakerDebug = '1'; else localStorage.removeItem('mapMakerDebug'); } catch { /* not persisted */ }
  if (!on && dbg.el) { dbg.el.remove(); dbg.el = dbg.pre = null; }
  if (on) dbgLog('debug on');
  flash(on ? 'Debug strip on (Ctrl+Shift+D hides it)' : 'Debug strip off');
  requestDraw();
}
function dbgFrame(ms, err) {
  if (!dbg.on || IN_WORKER) return;
  dbg.n++;
  const c = dbg.cur;
  const line = `f${dbg.n} ${perf.fps.toFixed(0)}fps (draw ${perf.drawMs.toFixed(1)}ms avg, ${ms.toFixed(1)}ms now) ${canvas.width}x${canvas.height} tiles ${c.shown ?? '-'}/${c.inView ?? '-'} miss ${c.missing ? 'Y' : 'n'} z${c.z ?? '-'} | chunks built ${c.built ?? '-'} miss ${c.ccMissing ?? '-'} none ${c.none ?? 0} stand ${c.stand ?? 0} | bv${baseVersion} sv${stateVersion} drops ${c.drops || 0} full${cellCache.fulls} | thr${flick.throws} skip${flick.skipped} mis${flick.mismatch} rs${flick.resizes} lost${flick.lost}/${flick.restored} purged${flick.purged} cp${flick.copies} cs${cacheScale.toFixed(2)}${err ? ' ERR ' + err : ''}`;
  if (err || ms > 40 || c.none || c.drops) dbgLog(line);
  if (!dbg.el) {
    dbg.el = document.createElement('div');
    dbg.el.style.cssText = 'position:absolute;left:4px;bottom:4px;z-index:50;display:flex;gap:6px;align-items:flex-end;max-width:95%';
    dbg.pre = document.createElement('pre');
    dbg.pre.style.cssText = 'margin:0;padding:3px 6px;font:11px monospace;color:#9f9;background:rgba(0,0,0,.7);white-space:pre-wrap;pointer-events:none';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Copy debug log';
    btn.style.cssText = 'font:11px sans-serif;padding:3px 8px;cursor:pointer;color:#9f9;background:rgba(0,0,0,.8);border:1px solid #9f9;border-radius:3px';
    btn.addEventListener('click', dbgCopy);
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    dbg.el.append(dbg.pre, btn);
    canvas.parentElement.appendChild(dbg.el);
  }
  if (dbg.n % 6 === 0 || err || !dbg.pre.textContent) dbg.pre.textContent = line + '\nlog ' + dbg.ring.length + ' lines';
  dbg.cur = {};
}

let artRetryAt = 0;
// Real frame rate: the gap between draws (what you see), apart from how long a draw takes (what the code costs).
const perf = { reused: 0, scrolled: 0, last: 0, gaps: [], draws: [], fps: 0, drawMs: 0, n: 0, total: 0 };
function perfFrame(t0, t1) {
  if (perf.last) { perf.gaps.push(t0 - perf.last); if (perf.gaps.length > 60) perf.gaps.shift(); }
  perf.last = t0;
  perf.n++; perf.total += t1 - t0;
  perf.draws.push(t1 - t0); if (perf.draws.length > 60) perf.draws.shift();
  const g = perf.gaps.length ? perf.gaps.reduce((a, b) => a + b, 0) / perf.gaps.length : 0;
  // A gap over half a second is the editor sitting idle, not a slow frame.
  perf.fps = g && g < 500 ? 1000 / g : 0;
  perf.drawMs = perf.draws.reduce((a, b) => a + b, 0) / perf.draws.length;
}
const worldCacheOff = () => { try { return localStorage.mapMakerNoWorldCache === '1'; } catch { return false; } };
function draw() {
  drawPhase = 0;
  if (root && root.isConnected === false) return; // the editor was closed with a frame queued
  const t0 = performance.now();
  let err = null;
  purgeLost();
  // The level's art is missing (a failed load): try again now and then rather than drawing without it for good.
  if (base?.art && baseSettled && !loading && !IN_WORKER && (!atlasImg || !sceneImg) && performance.now() > artRetryAt) {
    artRetryAt = performance.now() + 5000;
    if (!atlasImg) buildArtIndex();
    if (!sceneImg && base.scene) loadLazy(MAPS + base.scene.atlas, (i) => { sceneImg = i; invalidateBase(); }, 'Level scenery');
    flash('Level art failed to load - retrying', true);
  }
  const vis = visCanvas;
  if (vis && vis.isConnected !== false && vis.width && vis.height) {
    if (!backCanvas) { backCanvas = makeCanvas(); backCanvas.addEventListener('contextlost', () => { backCtx = null; }); backCanvas.addEventListener('contextrestored', () => { backCtx = null; requestDraw(); }); }
    if (backCanvas.width !== vis.width || backCanvas.height !== vis.height) { backCanvas.width = vis.width; backCanvas.height = vis.height; backCtx = null; }
    if (!backCtx) backCtx = guardCtx(backCanvas.getContext('2d', { alpha: false }));
    const saved = [canvas, ctx];
    canvas = backCanvas; ctx = backCtx;
    let ok = false;
    try { drawFrame(); drawFx(); ok = true; } catch (e) { err = String(e && e.message || e); flick.skipped++; dbgLog('present SKIPPED, frame threw: ' + (e && e.stack || e)); if (!dbg.on) throw e; }
    finally { [canvas, ctx] = saved; }
    if (backCanvas.width !== vis.width || backCanvas.height !== vis.height) { flick.mismatch++; dbgLog('size mismatch: back ' + backCanvas.width + 'x' + backCanvas.height + ' vs visible ' + vis.width + 'x' + vis.height); }
    // One present: the finished frame replaces the visible one in a single copy.
    if (ok) { visCtx.setTransform(1, 0, 0, 1, 0, 0); visCtx.globalAlpha = 1; visCtx.globalCompositeOperation = 'copy'; visCtx.drawImage(backCanvas, 0, 0); visCtx.globalCompositeOperation = 'source-over'; flick.copies++; }
  } else {
    try { drawFrame(); drawFx(); } catch (e) { err = String(e && e.message || e); dbgLog('draw threw (direct): ' + (e && e.stack || e)); if (!dbg.on) throw e; }
  }
  drawPhase = 0;
  const t1 = performance.now();
  perfFrame(t0, t1);
  if (dbg.on) dbgFrame(t1 - t0, err);
}
// The level layer: tiles, live things and your blocks on a transparent canvas of the window's size, drawn over the backdrop.
// While the map is dragged (scroll = true) it is moved by whole pixels and only the strip that came into view is drawn, so a pan
// costs a copy and a sliver of drawing instead of resampling every tile again; any other change redraws it whole.
// While a pan frame redraws only the strips that came into view, whatever lies wholly outside them is not drawn at all.
let stripClip = null;
const inStrips = (x0, y0, x1, y1) => !stripClip || stripClip.some((r) => x1 > r[0] && x0 < r[0] + r[2] && y1 > r[1] && y0 < r[1] + r[3]);
const levelLayer = { a: null, b: null, ax: 0, ay: 0, key: '', ok: false };
const layerOff = () => { try { return localStorage.mapMakerNoLayer === '1'; } catch { return false; } };
function layerSurface(W, H) {
  const mk = () => { const cv = makeCanvas(); cv.width = W; cv.height = H; return { cv, g: guardCtx(cv.getContext('2d')) }; };
  const L = levelLayer;
  if (!L.a || L.a.cv.width !== W || L.a.cv.height !== H) { L.a = mk(); L.b = mk(); L.ok = false; }
  return L;
}
function drawLevelLayer(W, H, key, scroll, content) {
  const L = layerSurface(W, H), saved = [canvas, ctx];
  let strips = null;
  if (scroll && L.ok && L.key === key && !layerOff()) {
    const dx = (L.ax - cam.x) * cam.scale, dy = (cam.y - L.ay) * cam.scale, rx = Math.round(dx), ry = Math.round(dy);
    if (Math.abs(dx - rx) < 1e-3 && Math.abs(dy - ry) < 1e-3 && Math.abs(rx) < W && Math.abs(ry) < H) {
      const t = L.b;
      t.g.clearRect(0, 0, W, H);
      t.g.drawImage(L.a.cv, rx, ry);
      L.b = L.a; L.a = t;
      strips = [];
      if (rx > 0) strips.push([0, 0, rx, H]); else if (rx < 0) strips.push([W + rx, 0, -rx, H]);
      if (ry > 0) strips.push([0, 0, W, ry]); else if (ry < 0) strips.push([0, H + ry, W, -ry]);
    }
  }
  if (!strips) L.a.g.clearRect(0, 0, W, H);
  canvas = L.a.cv; ctx = L.a.g;
  ctx.imageSmoothingEnabled = !zooming();
  try {
    if (strips) {
      stripClip = strips;
      ctx.save();
      ctx.beginPath();
      for (const r of strips) ctx.rect(r[0], r[1], r[2], r[3]);
      ctx.clip();
      try { content(); } finally { ctx.restore(); stripClip = null; }
      perf.scrolled++;
    } else content();
  } finally { [canvas, ctx] = saved; }
  L.ax = cam.x; L.ay = cam.y; L.key = key;
  L.ok = worldClean && !worldDirty && !cellCache.cold;
  ctx.drawImage(L.a.cv, 0, 0);
}
function drawFrame() {
  if (!ctx) return;
  viewMissing = false;
  if (loading?.render && !baseOn()) hideLoading();
  const W = canvas.width, H = canvas.height;
  const tl = cellOf(toWorld(0, 0).x, toWorld(0, 0).y);
  const br = cellOf(toWorld(W, H).x, toWorld(W, H).y);
  const minCx = tl.cx - 1, maxCx = br.cx + 1, minCy = br.cy - 1, maxCy = tl.cy + 1;
  const cellPx = CELL * cam.scale;
  const pad = cellPx < 2 ? 0.6 : 0.5;
  const useArt = artReady();

  // The world layer: blitted from the last frame when nothing but overlays changed (see worldCache), else drawn and kept.
  const fast = zooming();
  const wkey = [fast, W, H, cam.x, cam.y, cam.scale, stateVersion, baseVersion, draft.baseState, useArt, baseOn(), draft.noGrid, platformEdit != null].join('|');
  drawPhase = 1;
  const pan = panFrame, dirty = worldDirty;
  panFrame = false;
  if (!dirty && worldCache.ok && worldCache.key === wkey && worldCache.cv.width === W && worldCache.cv.height === H && !worldCacheOff()) {
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(worldCache.cv, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    perf.reused++;
  } else {
  worldDirty = false; worldClean = true; worldCache.ok = false;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  if (cellPx >= 10 && !draft.noGrid) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let cx = minCx; cx <= maxCx; cx++) { const x = Math.round(cellRect(cx, 0).x) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let cy = minCy; cy <= maxCy; cy++) { const y = Math.round(cellRect(0, cy).y) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }
  const levelOn = baseOn() && !layerHidden('level');
  ctx.imageSmoothingEnabled = !fast;
  if (levelOn && useArt) drawBackground(W, H);
  ctx.imageSmoothingEnabled = true;

  // Everything over the backdrop: the level's tiles and live things, then your blocks.
  drawLevelLayer(W, H, [fast, W, H, cam.scale, stateVersion, baseVersion, draft.baseState, useArt, levelOn, platformEdit != null].join('|'), pan && !dirty, () => {
    if (levelOn) {
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
    drawCellView(useArt, pad);
  });
  // Kept for the next frame unless the picture is still being built (missing tiles / chunks, a queued redraw).
  if (worldClean && !worldDirty && !cellCache.cold) {
    if (!worldCache.cv) worldCache.cv = makeCanvas();
    if (worldCache.cv.width !== W || worldCache.cv.height !== H) { worldCache.cv.width = W; worldCache.cv.height = H; }
    const wg = worldCache.cv.getContext('2d');
    wg.globalCompositeOperation = 'copy';
    wg.drawImage(canvas, 0, 0);
    worldCache.key = wkey; worldCache.ok = true;
  } else worldCache.ok = false;
  }
  drawPhase = 2;
  // Course screens show in front of the walls, as in the game; placed objects still go over them.
  if (!layerHidden('course')) for (const c of courses()) drawCourseScreen(c, courseColor(c.id), courseNumber(c.id));
  // Things behind the level are drawn with it (above); without the level, before your blocks.
  if (!(baseOn() && !layerHidden('level') && useArt)) drawStackEntries(stack().filter((e) => e.it.behind));
  drawStackEntries(stack().filter((e) => !e.it.behind));
  if (draft.hitboxes) drawHitboxes(minCx, maxCx, minCy, maxCy);

  if (baseOn()) for (const o of baseObjects) {
    if (!baseObjectVisible(o) || o.checkpoint) continue;
    const c = toScreen(o.hitX ?? o.x, o.hitY ?? o.y);
    if (removedObjects.has(o.id)) continue;
    if (useArt && sceneReady() && o.kind === 'upgrade') continue;
    if (o.kind === 'trigger' && cam.scale < AREA_BADGE_MIN) continue;
    if (cam.scale < 0.1 && o.kind !== 'trigger') {
      if (c.x < -3 || c.x > W + 3 || c.y < -3 || c.y > H + 3) continue;
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
    if (o.kind !== 'trigger' && cam.scale >= 0.12 && !(useArt && sceneReady())) {
      ctx.fillStyle = color;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(o.label, c.x, c.y - h / 2 - 4);
    }
    ctx.restore();
    if (o.kind === 'trigger') { const b = areaBadge(o); drawBadge(b.icon, c.x, c.y - h / 2 - 14, color, cam.scale >= AREA_LABEL_MIN ? b.text : ''); }
  }

  if (baseOn()) {
    for (const c of base.courses) {
      ctx.globalAlpha = courses().length ? 0.35 : 1;
      if (c.start) drawGate(c.start, c.start.box || START_BOX, COLORS.start, 'START');
      ctx.globalAlpha = courses().length ? 0.35 : 1;
      if (c.end) drawGate(c.end, c.end.box || END_BOX, COLORS.end, 'END');
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.55;
      if (cam.scale >= 0.15) for (const r of c.resets || []) drawGate(r, r.box || RESET_BOX, COLORS.reset, 'TIMER RESET');
    }
    ctx.globalAlpha = 1;
  }
  if (baseOn() && !layerHidden('level')) drawBaseCheckpoints();
  if (baseOn() && base.scene && cam.scale >= 0.15 && !layerHidden('level')) drawMarkers();
  if (baseOn() && !layerHidden('level')) drawStageMask(minCx, maxCx, minCy, maxCy);
  if (!layerHidden('course')) { drawCourses(); triggers.forEach(drawTrigger); }
  drawSelection();
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
    if (cam.scale >= AREA_BADGE_MIN) drawBadge('hitbox', a.x + 13, a.y - 14, COLORS.area, cam.scale >= AREA_LABEL_MIN ? 'EXPORT AREA' : '');
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
    else if (tool === 'reset') drawGate(gateAt(cx, cy, 'reset'), RESET_BOX, COLORS.reset, 'TIMER RESET');
    else if (tool === 'spawn') drawGate(gateAt(cx, cy, 'spawn'), SPAWN_BOX, COLORS.spawn, 'SPAWN');
    else { ctx.strokeStyle = COLORS.end; ctx.lineWidth = 2; const r = cellRect(cx, cy); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    ctx.globalAlpha = 1;
  }
}

// The level's own checkpoints, drawn exactly like one you place (same box, colour, badge), at their real trigger area.
function drawBaseCheckpoints() {
  for (const o of baseObjects) {
    if (!o.checkpoint || !baseObjectVisible(o) || removedObjects.has(o.id)) continue;
    const x = o.hitX ?? o.x, y = o.hitY ?? o.y;
    ctx.save();
    drawGate({ x, y }, { dx: 0, dy: 0, w: o.w, h: o.h }, o.label === 'Course checkpoint' ? COLORS.courseCheckpoint : COLORS.checkpoint, (o.label === 'Course checkpoint' ? 'COURSE CHECKPOINT' : 'CHECKPOINT') + (isLinked(baseCheckpointCourse(o)) ? ' · ' + linkLabel(baseCheckpointCourse(o)).toUpperCase() : o.label === 'Course checkpoint' ? ' · ANY COURSE' : ''));
    ctx.restore();
  }
}
function drawMarkers() {
  ctx.save();
  ctx.globalAlpha = 0.55;
  for (const r of levelRespawns()) {
    const label = 'C' + r.course + ' RESPAWN';
    if (r.g) {
      drawGate(r.g, SPAWN_BOX, COLORS.respawn, label);
      // Where it came from, faint, so a moved respawn shows what it left behind.
      if (r.g.x !== r.at.x || r.g.y !== r.at.y) {
        ctx.save();
        ctx.globalAlpha = 0.2;
        drawGate(r.at, SPAWN_BOX, COLORS.respawn, label);
        ctx.restore();
      }
    } else {
      // Removed: the spot stays, crossed out.
      ctx.save();
      ctx.globalAlpha = 0.25;
      drawGate(r.at, SPAWN_BOX, COLORS.respawn, label + ' (REMOVED)');
      ctx.restore();
      const hw = SPAWN_BOX.w / 2, hh = SPAWN_BOX.h / 2;
      const tl = toScreen(r.at.x - hw, r.at.y + hh), br = toScreen(r.at.x + hw, r.at.y - hh);
      const tr = toScreen(r.at.x + hw, r.at.y + hh), bl = toScreen(r.at.x - hw, r.at.y - hh);
      ctx.strokeStyle = COLORS.respawn;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y); ctx.lineTo(br.x, br.y);
      ctx.moveTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y);
      ctx.stroke();
    }
  }
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
  const thin = cam.scale * CELL < 4; // outlines under 4 px a cell are a smear: fill only
  const cellBox = (cx, cy, len = 1) => { const r = cellRect(cx, cy, len); ctx.fillRect(r.x, r.y, r.w, r.h); if (!thin) ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1); };
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
  // Your blocks: the game paints them on a tilemap with a composite collider, so each connected region is one outline.
  // Only kinds on a collider tilemap count (illusory walls, backgrounds and breakable-ground art are walk-through).
  const solidStyle = { ground: [HIT.solid, HIT.solidFill], blue: [COLORS.blue, 'rgba(63, 127, 224, 0.2)'], orange: [COLORS.orange, 'rgba(224, 138, 63, 0.2)'] };
  const own = { ground: [], blue: [], orange: [] };
  blocks.forEach((kind, k) => {
    const g = solidGroup(kind, BLOCK_SETS);
    if (!g) return;
    const [cx, cy] = unkey(k);
    if (inView(cx, cy, 1)) own[g].push(k);
  });
  for (const g in own) {
    if (!own[g].length) continue;
    ctx.strokeStyle = solidStyle[g][0];
    ctx.fillStyle = solidStyle[g][1];
    ctx.beginPath();
    for (const loop of outlineLoops(own[g])) {
      loop.forEach(([x, y], i) => {
        const w = cellWorld(x, y), p = toScreen(w.x, w.y);
        i ? ctx.lineTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5) : ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.stroke();
  }
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
    freeSpikes.forEach((f) => {
      const c = cellOf(f.x, f.y);
      if (!inView(c.cx, c.cy, 2)) return;
      const E = freeSpikeExtra(f);
      let shape, m;
      if (f.c === 'true') { shape = trueSpikeDef().shape; m = mul2(E, rotMatrix(f.q)); }
      else { const t = spikeTile(f.c, f.q), d = defByTile(t.layer + '|' + t.tile); shape = d?.shape || [[[-12, -16], [12, -16], [0, 14]]]; m = mul2(E, t.matrix); }
      ctx.beginPath();
      for (const poly of shape) {
        poly.forEach(([x, y], i) => { const p = toScreen(f.x + m[0] * x + m[1] * y, f.y + m[2] * x + m[3] * y); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
        ctx.closePath();
      }
      ctx.fill();
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
const assetMiss = new Set(); // files nobody has (this session): not asked for again until they're stored
const tauriInvoke = () => window.__TAURI__?.core?.invoke;
const b64Blob = (b64) => { const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new Blob([bytes]); };
const blobData = (blob) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ok(null); r.readAsDataURL(blob); });
// IndexedDB first; if it has lost the file, the app's own copy (or any installed map's) brings it back.
async function assetBlob(file) {
  const db = await assetDb();
  const got = await new Promise((ok) => { const r = db.transaction('files').objectStore('files').get(file); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); });
  if (got || assetMiss.has(file) || !tauriInvoke()) return got;
  try {
    const blob = b64Blob(await tauriInvoke()('find_map_asset', { file }));
    await putAsset(file, blob);
    return blob;
  } catch { assetMiss.add(file); return null; }
}
// A copy on disk, outside the browser's storage (best effort).
async function keepAsset(file, blob) {
  assetMiss.delete(file);
  try { const data = await blobData(blob); if (data && tauriInvoke()) await tauriInvoke()('store_map_asset', { file, data }); } catch { /* older build: IndexedDB only */ }
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
  await keepAsset(file, fileObj);
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
  out.missing = [];
  for (const file of used) {
    const blob = await assetBlob(file);
    if (!blob) { out.missing.push(file); continue; }
    out.push({ file, data: await blobData(blob) });
  }
  return out;
}
// "3 pictures are missing: a.jpg, b.jpg - pick them again" (empty when none are).
function missingNote(assets) {
  const m = assets?.missing || [];
  if (!m.length) return '';
  const kind = (f) => (draft.assets || []).find((a) => a.file === f)?.kind;
  const pics = m.filter((f) => (kind(f) || 'image') === 'image').length, noun = pics === m.length ? (m.length === 1 ? 'picture is' : 'pictures are') : (m.length === 1 ? 'file is' : 'files are');
  return `${m.length} ${noun} missing: ${m.map(assetName).join(', ')} - pick ${m.length === 1 ? 'it' : 'them'} again`;
}
// Turns a thrown invoke error into a short machine-readable code (unsupported / not_installed / ...).
function errorCode(e) {
  const s = String(e ?? '');
  try { const j = JSON.parse(s); if (j && typeof j.code === 'string') return j.code; } catch {}
  for (const c of ['unsupported', 'not_installed', 'navigator_missing', 'invalid_map', 'io', 'too_large', 'spawn_failed']) {
    if (s === c || s.startsWith(c + ':') || s.startsWith(c + ' ')) return c;
  }
  if (/unknown command|not found|command .* not registered|is not a valid command/i.test(s)) return 'unsupported';
  return '';
}
// A map opened from the installed maps brings its files back into the editor.
async function fetchInstalledAssets(id) {
  const failed = [];
  let hasUnsupported = false, hasFailed = false;
  for (const a of draft.assets || []) {
    if (await assetBlob(a.file)) continue;
    try {
      await putAsset(a.file, b64Blob(await window.__TAURI__.core.invoke('read_map_asset', { id, file: a.file })));
      assetMiss.delete(a.file);
    } catch (e) {
      failed.push(a.file);
      assetMiss.add(a.file);
      const code = errorCode(e);
      if (code === 'unsupported') hasUnsupported = true; else hasFailed = true;
      dbgLog('fetchInstalledAssets ' + a.file + ': ' + (e && e.stack || e));
    }
  }
  if (!failed.length) return;
  const names = failed.map(assetName).join(', ');
  const msg = (hasUnsupported && !hasFailed)
    ? `${failed.length} media file${failed.length === 1 ? '' : 's'} could not be loaded by this build (${names}). Update Recharge or re-pick them.`
    : `${failed.length} media file${failed.length === 1 ? '' : 's'} could not be loaded (${names}). Re-pick them to restore previews.`;
  flash(msg, true);
}
const assetImages = new Map();
function assetImage(file) {
  let img = assetImages.get(file);
  if (!img) {
    img = new Image();
    assetImages.set(file, img);
    assetBlob(file).then((b) => { if (!b) { img.missing = true; requestDraw(); } else { img.onload = () => { invalidateBase?.(); requestDraw(); }; img.src = URL.createObjectURL(b); } });
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
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col + '12';
  ctx.fillRect(a.x, a.y, w, h);
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
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
  if (!img) { const pl = plantOf(cs); img = newMapImage(); img.onload = () => requestDraw(); img.onerror = () => assetLog.set(MAPS + 'plants/' + (pl?.file || cs.game), { ok: false, tries: 1, err: 'load error' }); if (pl) img.src = MAPS + 'plants/' + pl.file; plantImages.set(cs.game, img); }
  return img;
}
function customSpriteSize(cs) {
  const pl = cs.game && plantOf(cs), s = cs.scale || 1;
  if (pl) return { w: pl.w * s * (cs.sx || 1), h: pl.h * s * (cs.sy || 1) };
  const img = assetImage(cs.image);
  if (img.missing) return { w: Math.max(64, 256 * s * (cs.sx || 1)), h: Math.max(64, 256 * s * (cs.sy || 1)) }; // unknown size: a box you can still hit
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
  else if (img.missing) {
    const w = b.w * cam.scale, h = b.h * cam.scale;
    ctx.fillStyle = 'rgba(200,60,60,0.12)'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#d05050'; ctx.lineWidth = 2; ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.moveTo(w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); ctx.stroke();
    ctx.fillStyle = '#e8a0a0'; ctx.font = `${Math.max(10, 14 * cam.scale)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(assetName(cs.image) + ' (missing)', 0, 0, Math.max(w, 40));
  } else { ctx.strokeStyle = '#8aa0b8'; ctx.setLineDash([4, 3]); ctx.strokeRect((-b.w / 2) * cam.scale, (-b.h / 2) * cam.scale, b.w * cam.scale, b.h * cam.scale); }
  ctx.restore();
}
// Replaces a picture's bytes under the SAME file name: every object using it keeps its place and size.
async function repickImage(file) {
  const f = await pickFile('image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp');
  if (!f) return;
  await putAsset(file, f);
  await keepAsset(file, f);
  const a = (draft.assets || []).find((x) => x.file === file);
  if (a) a.name = f.name; else draft.assets = [...(draft.assets || []), { file, name: f.name, kind: 'image' }];
  assetImages.delete(file);
  saveDraft(); invalidateBase?.(); renderConfig(); requestDraw();
  flash('Picture replaced: ' + f.name);
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
  let rmax = 80;
  for (const n in vineImages) { const i = vineImages[n]; rmax = Math.max(rmax, (i.naturalWidth || 0) / 2, (i.naturalHeight || 0) / 2); }
  const c = cellOf(wx, wy), n = Math.ceil(rmax / CELL) + 1;
  vines.forEachIn(c.cx - n, c.cy - n, c.cx + n, c.cy + n, (k, v) => consider(k, v.s, true));
  if (baseOn()) for (const k of baseVineKeys) { const h = baseHaz.get(k); if (!removedVines.has(k) && !vines.has(k)) consider(k, base.defs[h.d].sprite, false); }
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
    ['Esc', 'Deselect, or close what is open'],
    ['Shift+Esc', 'Back to the main menu (saves first)'],
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
    const selXs = sel.cells.map((k) => unkey(k)[0]);
    const w = maxOf(selXs) - minOf(selXs) + 1;
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
  // Selecting on the canvas never opens the palette popover (only its toolbar button does); one already open follows.
  if (popCat) setTimeout(() => { if (popCat) { popCat = cat; renderPopover(''); } }, 0);
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

// Leaving the editor for the main menu: the draft is saved here so no work is lost, and nothing is restored on reopening.
async function leaveEditor() {
  saveDraft();
  // The write can be an IndexedDB one (a big map), so wait for it before the editor is torn down.
  await flushDraft();
  if (window.__amplifierOldClose) window.__amplifierOldClose();
}

// The editor closed: what it holds for drawing is let go. The tile workers alone keep a copy of the level's art and data each
// (~0.4 GB apiece), and the caches fill up to a few hundred MB more, none of which anything frees once the editor is off screen.
// Opening it again rebuilds them (mountEditor starts the workers; the caches refill as it draws).
function releaseEditorMemory() {
  for (const w of pool.workers) w.terminate();
  Object.assign(pool, { workers: [], ready: 0, failed: false, version: -1, err: '', why: '' });
  workersAsked = false;
  pool.inflight.clear();
  for (const c of tileCache.values()) freeCanvas(c);
  tileCache.clear(); dirtyGen.clear();
  for (const j of tileJobs.values()) freeCanvas(j.cv);
  tileJobs.clear(); aheadQueue.clear(); prefetch = null; prefetchAt = '';
  for (const c of cellCache.chunks.values()) freeCanvas(c.cv);
  for (const cv of cellCache.pool) freeCanvas(cv);
  Object.assign(cellCache, { chunks: new Map(), pool: [], refs: null, sig: '', cold: true });
  for (const c of [levelLayer.a?.cv, levelLayer.b?.cv, worldCache.cv, backCanvas, pieceCanvas]) freeCanvas(c);
  levelLayer.a = levelLayer.b = null; levelLayer.ok = false;
  worldCache.cv = null; worldCache.ok = false; worldDirty = true;
  backCanvas = null; backCtx = null; pieceCanvas = null;
  for (const c of bdCache.values()) freeCanvas(c);
  bdCache.clear(); bdPx = 0;
  for (const c of tintCache.values()) freeCanvas(c);
  tintCache.clear(); artCache.clear();
  for (const k of Object.keys(scratchCanvas)) { freeCanvas(scratchCanvas[k]); delete scratchCanvas[k]; }
  // The decoded pictures (level art, scenery, backdrops, fonts, vines: ~100 MB) and the baked text live on only through these references;
  // each has its own loader that fetches it again when the editor next draws with it. The undo history of a closed editor is no use either:
  // reopening reads the draft afresh.
  atlasImg = null; sceneImg = null; lazyLoading.clear();
  for (const k of Object.keys(bgImages)) delete bgImages[k];
  fontImages.length = 0;
  for (const k of Object.keys(vineImages)) delete vineImages[k];
  textCache.clear(); sizeCache.clear();
  undoStack = []; redoStack = [];
}

function syncChrome() {
  if (!root) return;
  const snapSel = root.querySelector('#mm-snap');
  if (snapSel) snapSel.value = String(draft.snap || CELL);
  root.classList.toggle('mm-full', !draft.inline);
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
  // The level's own cells in the box turn with it, as your own.
  if (baseOn()) {
    liftBase(baseKeysIn(x0, y0, x1, y1), 0, 0);
    for (const d of decoInRegion(sel)) liftDeco(d.layer, d.cells, 0, 0);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const mapCell = (x, y) => (mode === 'x' ? [x0 + x1 - x, y] : mode === 'y' ? [x, y0 + y1 - y] : [Math.round(mx - (y - my)), Math.round(my + (x - mx))]);
  const M = mode === 'x' ? [-1, 0, 0, 1] : mode === 'y' ? [1, 0, 0, -1] : [0, -1, 1, 0];
  const mapQ = (q) => (q == null ? q : mode === 'x' ? [0, 3, 2, 1][q] : mode === 'y' ? [2, 1, 0, 3][q] : (q + 1) % 4);
  for (const m of [blocks, spikes, vines]) {
    const moving = cellsIn(m, x0, y0, x1, y1);
    for (const [k] of moving) m.delete(k);
    for (const [, v, cx, cy] of moving) {
      const [x, y] = mapCell(cx, cy);
      m.set(key(x, y), m === spikes ? { ...v, q: mapQ(v.q) } : m === vines ? { ...v, q: mode === 'r' ? (v.q + 1) % 4 : v.q } : v);
    }
  }
  const movingT = [];
  for (const [k, t, , cc] of tilesInCells(x0, y0, x1, y1)) if (!t.arrow && layerGrid(t.layer).size === CELL) movingT.push([k, t, cc]);
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
// The "Belongs to" options: your courses, then the level's.
function courseLinkOptions(cur, none) {
  return `<option value="">${none}</option>` + courses().map((c) => `<option value="${c.id}"${cur === c.id ? ' selected' : ''}>Course ${courseNumber(c.id)}</option>`).join('')
    + (baseOn() ? base.courses.map((c, i) => `<option value="level:${i + 1}"${cur === 'level:' + (i + 1) ? ' selected' : ''}>Level course ${i + 1}</option>`).join('') : '');
}
// A level checkpoint's course, as the map files it (draft.baseEdits[id].course).
const baseCheckpointCourse = (o) => draft.baseEdits?.[o.id]?.course || '';
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
  const out = { id: c.id, startX: r(c.start.x - ox), startY: r(c.start.y - oy), endX: r(c.end.x - ox), endY: r(c.end.y - oy), screenX: r(screen.x - ox), screenY: r(screen.y - oy), reward: c.reward || { currency: 'Cash', amount: 0 } };
  // Timer resets: a run ends here without finishing the course, so no reward.
  const resets = (c.resets || []).filter((g) => g && Number.isFinite(g.x) && Number.isFinite(g.y));
  if (resets.length) out.resets = resets.map((g) => ({ x: r(g.x - ox), y: r(g.y - oy), w: g.w ?? 20, h: g.h ?? 400, dx: g.dx ?? 0, dy: g.dy ?? 150 }));
  return out;
}
function clearMarker(m) {
  if (m.which === 'lrespawn') { (draft.levelRespawns ||= {})[m.course] = null; return; }
  if (m.which === 'spawn') { draft.spawn = null; return; }
  if (m.which === 'screen') { const c = courseById(m.course); if (c) delete c.screen; return; }
  const c = courseById(m.course);
  if (m.which === 'reset') { if (c?.resets) c.resets.splice(m.index, 1); pruneCourses(); return; }
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
  // A reset is a full-height trigger like the level's own, so a run ends whichever way the player passes.
  if (kind === 'reset') return { x: w.x + CELL / 2, y: w.y + END_LIFT, w: 20, h: 400, dx: 0, dy: 150 };
  return { x: w.x + CELL / 2, y: w.y + { start: START_LIFT, end: END_LIFT, spawn: SPAWN_LIFT, lrespawn: SPAWN_LIFT }[kind] };
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
  if (t.which === 'lrespawn') return levelRespawns().find((r) => r.course === t.course)?.g || null;
  const c = courseById(t.course);
  if (t.which === 'reset') return c?.resets?.[t.index];
  return t.which === 'screen' ? courseScreen(c) : c?.[t.which];
}
// A reset's trigger is a tall box centred above the gate, like the level's own.
const RESET_BOX = { dx: 0, dy: 150, w: 20, h: 400 };
const MARKER_BOX = { spawn: SPAWN_BOX, start: START_BOX, end: END_BOX, reset: RESET_BOX, lrespawn: SPAWN_BOX, get screen() { return screenBox(); } };
const screenBox = () => SCREEN_BOX;

// The game's board image (course Canvas "Screen_0") stretched as its UI does: 9-sliced, 30px borders at 120 pixels per unit on a 100-unit canvas scaled 1.1 x 1.15.
const BOARD_SLICE = 30, BOARD_EDGE = [(30 / 1.2) * 1.1, (30 / 1.2) * 1.15];
let boardImg = null;
function drawBoardSprite(x, y, w, h) {
  if (!boardImg) { boardImg = newMapImage(); boardImg.onload = requestDraw; boardImg.src = MAPS + 'course-screen.png'; }
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

// The level's own course respawn markers and where they are now: moved by this map, removed, or left alone.
// 'at' is where the level put them, 'g' where they are (null when the map removed them).
function levelRespawns() {
  if (!baseOn()) return [];
  return (base.scene?.respawns || []).map((r) => {
    const at = { x: r.at[0], y: r.at[1] };
    const v = draft.levelRespawns?.[r.course];
    const g = v === null ? null : Array.isArray(v) ? { x: v[0], y: v[1] } : at;
    return { course: r.course, at, g };
  });
}
// The moved and removed ones, as the map files them: course number -> [x, y] or null.
function levelRespawnsJson() {
  const out = {};
  for (const r of levelRespawns()) {
    if (r.g === null) out[r.course] = null;
    else if (r.g && (r.g.x !== r.at.x || r.g.y !== r.at.y)) out[r.course] = [Math.round(r.g.x), Math.round(r.g.y)];
  }
  return Object.keys(out).length ? { levelRespawns: out } : {};
}

// Every course gate and the spawn marker with its box, in hit priority order.
function markerList() {
  const out = [], put = (g, b, target) => { if (g) out.push({ g, b, target }); };
  put(draft.spawn, SPAWN_BOX, { kind: 'gate', which: 'spawn' });
  for (const r of levelRespawns()) put(r.g, SPAWN_BOX, { kind: 'gate', which: 'lrespawn', course: r.course });
  for (const c of courses()) {
    put(c.start, START_BOX, { kind: 'gate', which: 'start', course: c.id });
    put(c.end, END_BOX, { kind: 'gate', which: 'end', course: c.id });
    (c.resets || []).forEach((r, i) => put(r, r.box || RESET_BOX, { kind: 'gate', which: 'reset', course: c.id, index: i }));
  }
  for (const c of courses()) put(courseScreen(c), screenBox(), { kind: 'gate', which: 'screen', course: c.id });
  return out;
}
function markerAt(wx, wy) {
  const m = markerList().find(({ g, b }) => Math.abs(wx - (g.x + b.dx)) <= Math.max(b.w / 2, CELL / 2) && Math.abs(wy - (g.y + b.dy)) <= Math.max(b.h / 2, CELL / 2));
  if (!m) return null;
  const { kind, ...rest } = m.target;
  return rest;
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
      const oi = placed.findLastIndex((o) => objectHit(o, px, py, 'art'));
      if (oi >= 0) { placed.splice(oi, 1); return true; }
      const fi = freeSpikeAt(hoverWorld?.x ?? px, hoverWorld?.y ?? py);
      if (fi >= 0) { freeSpikes.splice(fi, 1); return true; }
      const si = signAt(hoverWorld?.x ?? px, hoverWorld?.y ?? py);
      if (si >= 0) { signs.splice(si, 1); return true; }
      const ci = csprites.findLastIndex((c) => customSpriteHit(c, hoverWorld?.x ?? px, hoverWorld?.y ?? py));
      if (ci >= 0) { csprites.splice(ci, 1); return true; }
      const t = tileAt(px, py);
      if (t) { if (t[1].arrow) removeArrow(t[1].arrow); else tiles.delete(t[0]); return true; }
      if (mossCells.delete(mossKeyAt(px, py))) return true;
    }
    const w = cellWorld(cx, cy);
    const obj = baseOn() && baseObjects.find((o) => !isBaseArea(o) && baseObjectVisible(o) && !removedObjects.has(o.id) && Math.abs(w.x + CELL / 2 - (o.hitX ?? o.x)) <= o.w / 2 && Math.abs(w.y + CELL / 2 - (o.hitY ?? o.y)) <= o.h / 2);
    if (obj) { removedObjects.add(obj.id); return true; }
    const hit = vineAt(w.x + CELL / 2, w.y + CELL / 2);
    if (hit) {
      if (hit.own) vines.delete(hit.k);
      else removedVines.add(hit.k);
      return true;
    }
    const isBase = baseOn() && (groundSet.has(k) || mossSet.has(k) || blueSet.has(k) || orangeSet.has(k) || (baseHaz.get(k) && baseHaz.get(k).kind !== 'vine'));
    if (isBase && !removed.has(k)) { removed.add(k); return true; }
    const dt = baseOn() && decoAt(w.x + CELL / 2, w.y + CELL / 2);
    if (dt) { dt.cells.forEach((k2) => removedDeco.add(dt.layer + '|' + k2)); return true; }
    const sp = baseOn() && sceneSpriteAt(w.x + CELL / 2, w.y + CELL / 2);
    if (sp) { removeScene(sp.id); return true; }
    // Nothing visible here: a trigger area (checkpoint, gate, long-fall zone, trigger) goes instead.
    const area = areaHits(hoverWorld?.x ?? w.x + CELL / 2, hoverWorld?.y ?? w.y + CELL / 2, false)[0]?.target || areaHits(w.x + CELL / 2, w.y + CELL / 2, false)[0]?.target;
    if (!area) return false;
    if (area.kind === 'mtrig') triggers.splice(area.index, 1);
    else if (area.kind === 'object') placed.splice(area.index, 1);
    else if (area.kind === 'xspawn') xspawns.splice(area.index, 1);
    else if (area.kind === 'base') removedObjects.add(area.id);
    else if (area.kind === 'gate') clearMarker(area);
    else return false;
    return true;
  } else if (tool === 'spawn') {
    draft.spawn = gateAt(cx, cy, 'spawn');
  } else if (tool === 'start' || tool === 'end') {
    if (drag?.placedObject) return false;
    let c = courseById(draft.activeCourse);
    if (!c || c[tool]) c = (tool === 'end' && courses().find((x) => x.start && !x.end)) || newCourse();
    c[tool] = gateAt(cx, cy, tool);
    draft.activeCourse = c.id;
    if (drag) drag.placedObject = true;
  } else if (tool === 'reset') {
    // A reset ends the run without finishing the course, so no reward; there can be several per course.
    if (drag?.placedObject) return false;
    let c = courseById(draft.activeCourse);
    if (!c) c = courses().find((x) => x.start && !x.end) || newCourse();
    (c.resets ||= []).push(gateAt(cx, cy, 'reset'));
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
    undoStack.push(before);
    redoStack = [];
    trimUndo(); // the same caps as every other step (a drag's first step is a step like any other)
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
  if (pool.tileErrorCount > 0) parts.push(`${pool.tileErrorCount} tile error${pool.tileErrorCount > 1 ? 's' : ''}`);
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
  // Undo depth and what the history costs (the snapshot sizes are estimates, see UNDO_ENTRY_OVERHEAD).
  let undoBytes = 0;
  for (const s of undoStack) undoBytes += s.bytes || 0;
  parts.push(`Undo: ${undoStack.length} steps (${(undoBytes / 1048576).toFixed(1)} MB)`);
  if (undoTrimReported) parts.push('<span class="mm-warn">history trimmed</span>');
  el.innerHTML = parts.map((p) => `<span>${p}</span>`).join('')
    + (lonely ? `<span class="mm-warn">a course is missing a gate - it's skipped</span>` : '')
    + (overview.reason ? `<span class="mm-warn">overview cache unavailable (${overview.reason}) - this map redraws on open</span>` : '')
    + (ccBacklog ? `<span class="mm-warn">rebuilding the view - the old picture is on show</span>` : '')
    + (hover ? `<span class="mm-coord">${hover.cx}, ${hover.cy}</span>` : '');
}

// The draft autosave line: a fact of its own, separate from the file save (#mm-save-state says when the map was saved).
function autosaveLabel() {
  if (autosaveOff) return 'autosave off - use Save or Export' + (autosaveAt ? ` (the last draft that fit is from ${clockOf(autosaveAt)})` : '');
  if (autosaveAt) return 'Draft autosaved ' + clockOf(autosaveAt) + (autosaveStore === 'idb' ? " (in this browser's database)" : '');
  return '';
}

function updateAutosaveIndicator() {
  const el = root?.querySelector('#mm-autosave-state');
  if (!el) return;
  const text = autosaveLabel();
  el.textContent = text;
  el.classList.toggle('mm-off', autosaveOff);
  el.hidden = !text;
  el.title = autosaveOff
    ? "This browser has no room for the draft. Save or export the map to keep your work - click to try the autosave again."
    : 'The draft is kept in this browser, so a reload or a crash does not lose it.';
}


// How many edits to the level the map holds (loaded or not).
function baseEditCount() {
  return removed.size + removedVines.size + removedObjects.size + removedScene.size + removedDeco.size + movedScene.size + movedObjects.size
    + levelTf.size + levelOrder.size + levelGroups.size + Object.keys(draft.baseEdits || {}).length;
}
function syncBaseUi() {
  const on = baseOn();
  const btn = root.querySelector('#mm-base');
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
  const st = root.querySelector('#mm-base-state');
  if (st) st.textContent = on ? 'Loaded' : 'Unloaded';
  const edits = baseEditCount();
  btn.title = on ? 'Base game is loaded into this map. Click to unload it (your changes to it are kept' + (edits ? ': ' + edits + ' edits' : '') + ').'
    : 'Base game is unloaded. Click to load the real level into this map' + (edits ? ' (your ' + edits + ' changes to it come back)' : '') + '.';
  root.querySelector('#mm-jump').hidden = !on;
  root.querySelector('#mm-state').hidden = !on;
  root.querySelectorAll('[data-state]').forEach((b) => b.classList.toggle('active', b.dataset.state === draft.baseState));
}

async function toggleBase() {
  if (baseOn()) {
    draft.useBase = false;
    selection = selection && ['base', 'basecells', 'scene', 'decotiles'].includes(selection.kind) ? null : selection;
    flash('Base game unloaded.' + (baseEditCount() ? ' Your changes to it are kept and come back when you load it.' : ''));
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
    if (baseEditCount()) { lastLevelEdits = levelEditSets(); invalidateBase(); }
    flash('Base game loaded' + (baseEditCount() ? ' with your changes to it.' : '.'));
    if (!blocks.size && !spikes.size && !courses().length && base.courses[0]) jumpTo(base.courses[0].start.x, base.courses[0].start.y);
  }
  saveDraft();
  syncBaseUi();
  requestDraw();
}

// Start over on the base game's level, with nothing placed.
async function newMapOnBase() {
  const hasContent = blocks.size || spikes.size || vines.size || tiles.size || mossCells.size
    || placed.length || freeSpikes.length || signs.length || triggers.length || csprites.length || arrows.length
    || removed.size || draft.courses.length || movedScene.size || movedObjects.size || levelTf.size || levelOrder.size
    || levelGroups.size || cellGroups.size || Object.keys(draft.baseEdits || {}).length || draft.music || draft.background
    || (draft.assets || []).length || (draft.stageEdits && Object.keys(draft.stageEdits).length);
  if (hasContent && !confirm('Start a new map on the base game? Your current draft will be replaced - export it first if you want to keep it.')) return false;
  // Load the level before touching the draft: a failed load leaves the current map alone.
  if (!baseOn()) {
    const btn = root.querySelector('#mm-base');
    btn.disabled = true;
    btn.classList.add('mm-busy');
    try {
      await loadBase(true);
    } catch (e) {
      flash("Couldn't load the base game map: " + e, true);
      return false;
    } finally {
      btn.disabled = false;
      btn.classList.remove('mm-busy');
    }
    draft.useBase = true;
    fillJumpList();
  }
  pushUndo();
  resetDraftContents();
  draft.mapUid = undefined; // a new map is a different map
  draft.name = '';
  draft.description = '';
  draft.baseState = 'start';
  // resetDraftContents keeps the map's own settings, so drop the old map's level edits and media too.
  draft.stageEdits = undefined;
  draft.baseEdits = {};
  draft.levelRespawns = {};
  movedScene.clear();
  movedObjects.clear();
  levelOrder.clear();
  levelTf.clear();
  levelGroups.clear();
  cellGroups.clear();
  draft.hiddenGroups = [];
  draft.music = undefined;
  draft.background = undefined;
  draft.assets = [];
  draft.activeCourse = null;
  if (base) applyBaseState();
  if (base?.courses?.[0]) jumpTo(base.courses[0].start.x, base.courses[0].start.y);
  saveDraft();
  syncBaseUi();
  requestDraw();
  flash('New map on the base game.');
  return true;
}

// ---- the overgrown stages: edited separately for the Start and Overgrown states ----
// The cells the overgrowth changes (its sprites, and ground / moss only one state has) plus a cell around them: edits there belong to the viewed state, everything else is shared.
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
  pushAll(placed, v.placed); pushAll(freeSpikes, v.freeSpikes); pushAll(signs, v.signs); pushAll(triggers, v.triggers); pushAll(csprites, v.csprites || []);
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
let stagePath = null, stagePathOf = null, stageAnchors = [];
// One label anchor (top-left corner, world units) per connected piece of the overgrowth area.
function stageLabelAnchors(set) {
  const seen = new Set(), out = [];
  for (const k0 of set) {
    if (seen.has(k0)) continue;
    seen.add(k0);
    const queue = [k0];
    let best = null;
    for (let qi = 0; qi < queue.length; qi++) {
      const [x, y] = unkey(queue[qi]), w = cellWorld(x, y);
      if (!best || w.y > best.y || (w.y === best.y && w.x < best.x)) best = { x: w.x, y: w.y + CELL };
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = key(x + dx, y + dy); if (set.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); } }
    }
    out.push(best);
  }
  return out;
}
const stageBadge = () => ({ icon: 'layers', text: draft.baseState === 'overgrown' ? 'OVERGROWTH AREA · OVERGROWN STATE' : 'OVERGROWTH AREA · START STATE', color: draft.baseState === 'overgrown' ? '#78c85a' : '#e6aa46' });
function drawStageMask() {
  if (cam.scale < 0.05) return;
  const set = stageCells();
  if (!set.size) return;
  if (stagePathOf !== set) {
    stagePathOf = set;
    stagePath = new Path2D();
    stageAnchors = stageLabelAnchors(set);
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
  // Dashes this small are a smear (and a dashed stroke over the whole outline is slow): far out the line is solid.
  if (k >= 0.1) ctx.setLineDash([6 / k, 5 / k]);
  ctx.lineWidth = 1.5 / k;
  ctx.stroke(stagePath);
  ctx.restore();
  // The dashed outline is the area the overgrowth changes: named like the other zones (same zoom rules).
  const b = stageBadge(), W = canvas.width, H = canvas.height;
  for (const a of stageAnchors) {
    const c = toScreen(a.x, a.y);
    if (c.x < -300 || c.x > W + 50 || c.y < -30 || c.y > H + 30) continue;
    drawBadge(b.icon, c.x + 13, c.y - 14, b.color, cam.scale >= AREA_LABEL_MIN ? b.text : '');
  }
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
  const el = root?.querySelector('#mm-flash');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('mm-out');
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.classList.add('mm-out'); flash.t = setTimeout(() => { el.hidden = true; }, 200); }, 3500);
}

// The map as the pretty JSON every export writes. A big map is written a slice at a time, so the page keeps answering
// (the text is byte for byte JSON.stringify(map, null, 2)).
const mapJsonText = (map) => prettyStringify(map);

// Asks where to save (the app's save dialog); builds without it fall back to a download.
async function exportZip() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      const assets = await mapAssets();
      const path = await invoke('export_map_zip', { mapJson: await mapJsonText(map), fileName: slug(map.name) + '.zip', assets });
      if (path) flash(`Exported to ${path} · ${map.groups[0].objects.length} objects` + (missingNote(assets) ? ' · ' + missingNote(assets) : ''), !!missingNote(assets));
      return;
    } catch (e) {
      if (!/export_map_zip|unknown command|not found/i.test(String(e))) { flash('Couldn\'t export: ' + e, true); return; }
    }
  }
  const blob = zipSingle('map.json', await mapJsonText(map));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slug(map.name) + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  flash(`Saved ${a.download} · ${map.groups[0].objects.length} objects`);
}

// Saves into the game's installed maps: the first save picks a folder from the map's name (never another map's), later ones replace that map.
let saveBusy = false, saveAgain = false;
async function saveMap() {
  // A save asked for while one is being written follows it (with the edits made since) instead of racing it.
  if (saveBusy) { saveAgain = true; return; }
  saveBusy = true;
  try { await saveMapNow(); } finally { saveBusy = false; }
  if (saveAgain) { saveAgain = false; return saveMap(); }
}
async function saveMapNow() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) { flash('Saving needs the Recharge app.', true); return; }
  try {
    let id = draft.savedId;
    if (!id) {
      const taken = new Set((await invoke('list_maps')).map((m) => m.id));
      // The editor's own test map is overwritten by every test run, so it's never a save target.
      taken.add(TEST_MAP_ID);
      const stem = slug(map.name);
      id = stem;
      for (let n = 2; taken.has(id); n++) id = stem + '-' + n;
    }
    const assets = await mapAssets();
    await invoke('save_map', { id, mapJson: await mapJsonText(map), assets });
    draft.savedId = id;
    draft.savedAt = Date.now();
    clearDraftOff(); // the map is in a file now: the lost-draft note has nothing to warn about
    saveDraft();
    syncSaveState();
    const warn = missingNote(assets);
    flash(`Saved "${map.name}" to your maps (${id})` + (warn ? ' · ' + warn : ''), !!warn);
  } catch (e) {
    const code = errorCode(e);
    const isUnsupported = code === 'unsupported' || (!code && /save_map|unknown command|not found/i.test(String(e)));
    let msg;
    if (isUnsupported) msg = 'Update Recharge to save maps - this build can\'t yet. Export .zip still works.';
    else if (code === 'invalid_map') msg = 'Couldn\'t save: invalid map data (' + String(e).replace(/^invalid_map:\s*/, '') + '). Export .zip still works.';
    else if (code === 'too_large') msg = 'Couldn\'t save: map is too large for this build. Export .zip still works.';
    else if (code === 'io') msg = 'Couldn\'t save: storage error (' + String(e).replace(/^io:\s*/, '') + '). Export .zip still works.';
    else msg = 'Couldn\'t save: ' + e + ' Export .zip still works.';
    dbgLog('save_map failed code=' + (code || (isUnsupported ? 'unsupported' : 'unknown')) + ': ' + (e && e.stack || e));
    flash(msg, true);
  }
}

function syncSaveState() {
  const el = root?.querySelector('#mm-save-state');
  if (!el) return;
  el.textContent = draft.savedId ? `Saves to your maps as ${draft.savedId}` + (draft.savedAt ? ' · last saved ' + clockOf(draft.savedAt) : '') : 'Not saved yet - Save adds it to your maps';
}

async function testInGame() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const btn = root.querySelector('#mm-test');
  btn.disabled = true;
  btn.textContent = 'Launching…';
  try {
    const assets = await mapAssets();
    await window.__TAURI__.core.invoke('test_launch_map', { mapJson: await mapJsonText(map), assets });
    const warn = missingNote(assets);
    flash('Launching IGTAP - Navigator opens the map from the title screen. Other mods are off until you close the game.' + (warn ? ' · ' + warn : ''), !!warn);
  } catch (e) {
    const code = errorCode(e);
    const isUnsupported = code === 'unsupported' || (!code && /test_launch_map|not found|unknown command/i.test(String(e)));
    const detail = String(e).replace(/^[a-z_]+:\s*/, '');
    let msg;
    if (isUnsupported) msg = 'This Recharge build can\'t test-launch maps yet. Export .zip still works.';
    else if (code === 'not_installed') msg = 'IGTAP is not installed or its path is not set. Set the game path in Settings, then retry. Export .zip still works.';
    else if (code === 'navigator_missing') msg = 'Navigator is missing from the test build. Redeploy Navigator, then retry. Export .zip still works.';
    else if (code === 'spawn_failed') msg = 'Couldn\'t launch IGTAP (' + detail + '). Export .zip still works.';
    else if (code === 'invalid_map') msg = 'Map failed validation (' + detail + '). Fix the map and retry. Export .zip still works.';
    else if (code === 'io') msg = 'Couldn\'t test-launch: storage/IO error (' + detail + '). Export .zip still works.';
    else msg = 'Couldn\'t test-launch: ' + e + ' Export .zip still works.';
    dbgLog('test_launch_map failed code=' + (code || (isUnsupported ? 'unsupported' : 'unknown')) + ': ' + (e && e.stack || e));
    flash(msg, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test in game';
  }
}

async function copyJson() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  try {
    await navigator.clipboard.writeText(await mapJsonText(map));
    flash('map.json copied to the clipboard.');
  } catch (e) {
    flash("Couldn't copy: " + e, true);
  }
}

// Wipes everything placed or erased, keeping the map's own settings.
function resetDraftContents() {
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
}

function clearAll() {
  if (!confirm('Clear everything you placed or erased in this draft?')) return;
  pushUndo();
  resetDraftContents();
  saveDraft();
  requestDraw();
}

function jumpTo(x, y) {
  glideCamera({ x, y, scale: Math.max(cam.scale, 0.5), anchor: null });
}

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const w = Math.round(r.width), h = Math.round(r.height);
  if (canvas.width === w && canvas.height === h) return;
  dbgLog('canvas resize ' + canvas.width + 'x' + canvas.height + ' -> ' + w + 'x' + h);
  flick.resizes++;
  canvas.width = w;
  canvas.height = h;
  visCtx = canvas.getContext('2d', { alpha: false });
  // Resizing blanks the canvas; paint again before the browser does (the one draw outside the rAF loop).
  if (ctx && !IN_WORKER) { try { draw(); } catch { /* next frame */ } }
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
    if (selectCanvasTarget(wp, e)) return;
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
      requestPanDraw();
      return;
    }
    if (drag?.platform) { const r = canvas.getBoundingClientRect(); hoverWorld = toWorld(e.clientX - r.left, e.clientY - r.top); platformPaint(hoverWorld); return; }
    if (drag?.resize) { resizeMove(e); return; }
    if (drag && (drag.pending || drag.region || drag.move || drag.moveSel || drag.zip || drag.gate || drag.group || drag.fspike || drag.sign)) { selectMove(e); return; }
    if (!drag && tool === 'select' && e.target === canvas) canvas.style.cursor = edgeCursor(edgesAt(worldAt(e)));
    if (drag?.zipPlace != null) { zipPlaceMove(e); return; }
    if (e.target !== canvas && !drag) {
      if (hover) { hover = null; updateStatus(); requestOverlayDraw(); }
      return;
    }
    if (!drag) {
      const rect = canvas.getBoundingClientRect();
      const wp = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    }
    const c = eventCell(e);
    hoverWorld = worldAt(e);
    if (hover && hover.cx === c.cx && hover.cy === c.cy) { if ((tool === 'select' || platformEdit != null) && !drag) requestOverlayDraw(); return; }
    hover = c;
    if (drag?.arrow) arrowMove(c.cx, c.cy);
    else if (drag && (BLOCK_KIND[tool] || SPIKE_KIND[tool] || tool === 'erase' || tool === 'tile' || tool === 'moss')) {
      strokeAt(c.cx, c.cy);
    }
    updateStatus();
    if (drag) requestDraw(); else requestOverlayDraw();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.pending) pendingUp();
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
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setDebug(!dbg.on); return; }
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
    // Shift+Esc leaves the editor, saving first; plain Esc only backs out of what's open.
    if (e.shiftKey) { leaveEditor(); return; }
    if (platformEdit != null) setPlatformEdit(null);
    else if (popCat) closePopover();
    else if (selection || tool === 'paste') { selection = null; renderConfig(); if (tool === 'paste') setTool('select'); requestDraw(); }
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
        <span class="mm-ver" id="mm-ver" title="${editorVersion() === 'built-in' ? 'The Amplifier that came with this Recharge' : 'Downloaded Amplifier update'}" style="font-size:11px;opacity:.6;white-space:nowrap">Amplifier ${editorVersion()}</span>
        <div class="mm-group" aria-label="Edit">
          <button class="mm-tool mm-icon" id="mm-undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
          <button class="mm-tool mm-icon" id="mm-redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
          <select class="mm-input mm-snap" id="mm-snap" title="Snap for placed things - objects, decorations, text, free spikes (Shift: 1 unit). Blocks and grid spikes always fill whole cells"><option value="32">▦ Cell</option><option value="16">▦ ½</option><option value="8">▦ ¼</option><option value="4">▦ ⅛</option><option value="1">▦ Free</option></select>
        </div>
        <div class="mm-group" aria-label="View">
          <button class="mm-tool mm-base-toggle" id="mm-base" aria-pressed="false" title="Base game: load the real level into this map, or unload it. Your changes to it are kept while it is unloaded.">${icon('basemap')}<span class="mm-base-label">Base game</span><span class="mm-base-state" id="mm-base-state">Loaded</span></button>
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
    <div class="mm-autosave-state" id="mm-autosave-state" hidden></div>
`;

  canvas = root.querySelector('#mm-canvas');
  // alpha: false (the canvas is opaque) lets the compositor skip a blend per frame; not desynchronized, which could present a background-only frame mid-draw and blink the map off while panning.
  ctx = canvas.getContext('2d', { alpha: false });
  visCanvas = canvas; visCtx = ctx;
  // The main canvas can lose its backing too (Chromium GPU memory pressure / device reset): repaint on restore.
  canvas.addEventListener('contextlost', (e) => { e.preventDefault?.(); flick.lost++; cacheScale = Math.max(0.25, cacheScale * 0.7); dbgLog('contextlost on main canvas'); });
  canvas.addEventListener('contextrestored', () => { flick.restored++; visCtx = canvas.getContext('2d', { alpha: false }); requestDraw(); });
  root.querySelector('[data-tool="erase"]').addEventListener('click', () => { closePopover(); setTool('erase'); });
  root.querySelector('[data-tool="select"]').addEventListener('click', () => { closePopover(); setTool('select'); });
  root.querySelector('#mm-layers-btn').addEventListener('click', () => togglePanel('mm-layers'));
  root.querySelector('#mm-keys-btn').addEventListener('click', () => togglePanel('mm-keys'));
  root.querySelector('#mm-sim-btn').addEventListener('click', () => toggleSimulate());
  // No back or fullscreen buttons: Shift+Esc leaves, saving first.
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
  // The autosave badge is also the "try again" button: the storage may have room again (or the map may have shrunk).
  root.querySelector('#mm-autosave-state').addEventListener('click', () => {
    if (!autosaveOff) return;
    tooBigAt = Infinity; // try localStorage again before falling back to IndexedDB
    persistDraft();
  });

  window.__amplifierRelease = releaseEditorMemory;
  await loadDraft();
  updateAutosaveIndicator();
  if (draftOffNote) flash(draftOffNote, true);
  if (container.dataset.amplifier) draft.inline = false; // opened from Amplifier: always fill the window
  if (!draft.useBase) loadBase().then(() => { fillJumpList(); requestDraw(); }).catch(() => {});
  if (draft.useBase) {
    try { await loadBase(true); } catch { draft.useBase = false; }
  }
  applyBaseState();
  if (baseSettled && draft.useBase) startTileWorkers();

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

// Test hooks (tests/amp-base.test.mjs drives the editor headlessly through these).
export const __test = {
  get baseVersion() { return baseVersion; }, perf, caches: () => ({ tiles: tileCache.size, maxTiles: maxTiles(), chunks: cellCache.chunks.size, pool: cellCache.pool.length, jobs: tileJobs.size, inflight: pool.inflight.size, ahead: aheadQueue.size, prefetch: prefetch ? prefetch.queue.length : 0, tint: tintCache.size, workers: pool.workers.length, ready: pool.ready, failed: pool.failed, cacheScale }), errorCode,
  fetchBase, loadImage, assetLog, MAPS, MAPS_CROSS, editorVersion,
  ov: () => ({ epoch: overview.epoch, restoring: overview.restoring, saving: overview.saving, dirty: overview.dirty, timer: !!overview.timer, persisted: overview.persisted.size, fp: baseFp, sig: overviewSig(), reason: overview.reason, reports: overview.reports }),
  ovDb: () => ovDb(),
  ovReason: (e) => ovReason(e),
  bench: (z, tx, ty, part = null) => { mipOn = false; const t0 = performance.now(); const cv = renderTile(z, tx, ty, part); const ms = performance.now() - t0; freeCanvas(cv); return ms; },
    view: (x, y, k) => { cam.x = x; cam.y = y; cam.scale = k; camGoal.active = false; worldDirty = true; requestDraw(); }, levelBounds: () => levelBounds(), get cam() { return cam; },
  open: (d) => { loadDraftFrom(d); if (base) applyBaseState(); },
  save: () => { syncDraft(); return JSON.parse(JSON.stringify(editorState())); },
  buildMap: () => buildMap(),
  setBaseOn: (on) => { draft.useBase = on; saveDraft(); },
  baseEditCount: () => baseEditCount(),
  get base() { return base; },
  get objects() { return baseObjects; },
  setScale: (k) => { cam.scale = k; }, areaBadgeAt: (id) => { const o = baseObjects.find((x) => x.id === id); return o && isBaseArea(o) && cam.scale >= AREA_BADGE_MIN ? { ...areaBadge(o), text: cam.scale >= AREA_LABEL_MIN ? areaBadge(o).text : '' } : null; },
  get scene() { return sceneList; }, stageZone: () => { const set = stageCells(); return { badge: stageBadge(), anchors: stageLabelAnchors(set), cells: set.size }; }, isBackgroundScene, itemsAt: (x, y) => [...itemsAtAny(x, y)],
  get sets() { return { ground: groundSet, moss: mossSet, blue: blueSet, orange: orangeSet, haz: baseHaz }; },
  get own() { return { blocks, spikes, vines, tiles, moss: mossCells }; },
  get gone() { return { removed, removedVines, removedObjects, removedScene, removedDeco, movedScene, movedObjects, levelTf, baseEdits: draft.baseEdits }; },
  get selection() { return selection; },
  set selection(v) { selection = v; },
  itemAt, marqueeTargets, setSelection, baseCellsAt, decoAt, cellWorld, cellOf, key, blockArt, BLOCK_SETS, levelOverrides, levelRails, joinSolid, levelJoinCells, joinInfo,
  snapRect, drawNineSlice,
  clickSelectsAt: (x, y) => clickSelects({ x, y }), selectTriggerAt: (x, y) => selectTriggerAt({ x, y }), selectCheckpointAt: (x, y) => selectCheckpointAt({ x, y }), selectCanvasTargetAt: (x, y) => selectCanvasTarget({ x, y }, null), checkpointHitAt: (x, y) => (baseCheckpointAt(x, y, true) || baseCheckpointAt(x, y))?.id || null, areaHitsAt: (x, y, badge) => areaHits(x, y, badge).map((h) => h.target), eraseAt: (cx, cy) => applyTool(cx, cy), setTool,
  deleteSelection, nudgeSelection, undo, redo, pushUndo, transformRegion,
  // A selection drag without the mouse: begin() returns the drag, move(drag, cx, cy) puts the selection cx, cy cells from where it began.
  beginSelectionDrag: (sel) => { selection = sel; return { before: snapshot(), selOrig: JSON.stringify(sel) }; },
  moveSelectionDrag: (d, cx, cy) => placeSelectionAt(d, cx * CELL, cy * CELL, cx, cy, false), saveMap, mapJsonText, exportArea,
  // The draft autosave (E20) and the undo budget (E22), for tests/amp-autosave-undo.test.mjs.
  updateStatus, updateAutosaveIndicator, autosaveLabel, persistDraft, loadDraft, trimUndo, flash, syncSaveState,
  setRoot: (el) => { root = el; },
  get draft() { return draft; },
  get undoStack() { return undoStack; },
  set undoStack(v) { undoStack = v; },
  get undoTrimReported() { return undoTrimReported; },
  set undoTrimReported(v) { undoTrimReported = v; },
  get autosaveOff() { return autosaveOff; },
  set autosaveOff(v) { autosaveOff = v; },
  get autosaveAt() { return autosaveAt; },
  set autosaveAt(v) { autosaveAt = v; },
  get autosaveStore() { return autosaveStore; },
  get draftOffNote() { return draftOffNote; },
  get exportGridOff() { return exportGridOff; },
  set exportGridOff(v) { exportGridOff = v; },
  get tooBigAt() { return tooBigAt; },
  set tooBigAt(v) { tooBigAt = v; },
  undoBytes: () => { let n = 0; for (const s of undoStack) n += s.bytes || 0; return n; },
  undoLimits: () => ({ maxSteps: UNDO_MAX_STEPS, maxBytes: UNDO_MAX_BYTES, entryOverhead: UNDO_ENTRY_OVERHEAD }),
  levelRespawns: () => levelRespawns(),
  editBaseUpgrade: (id, field, raw) => { selection = { kind: 'base', id }; applyBaseUpgrade(field, raw); },
  get baseOn() { return baseOn(); },
  paletteItems: (cat) => categoryItems(cat),
  setBaseCheckpointLink: (v) => applyBaseCheckpointLink(v),
  checkpointFlag: (i) => { const o = placed[i], item = catalogItem(o); return checkpointExport(o.x, o.y, trigOf(o, item)); },
  showInDropdownOpens: () => { const was = popCat; showInDropdown({ kind: 'object', index: 0 }); return popCat !== was && popCat != null; },
};
