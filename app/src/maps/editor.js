const DRAFT_KEY = 'rechargeMapMakerDraft';
const START_BOX = { dx: 0, dy: 0, w: 60, h: 250 };
const END_BOX = { dx: 0, dy: -26, w: 240, h: 13 };
const START_LIFT = 125;
const SPAWN_BOX = { dx: 0, dy: 0, w: 32, h: 64 };
const SPAWN_LIFT = 40;
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
  kill: 'rgba(214, 64, 88, 0.35)',
  removed: 'rgba(198, 62, 216, 0.6)',
  start: '#41f88d',
  spawn: '#5ec8f0',
  reset: '#f0a040',
  checkpoint: '#5ec8f0',
  respawn: '#b98cff',
  upgrade: '#f0a040',
  trigger: '#e8d85a',
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
const DEFAULT_PLAYER = { dashes: 1, airJumps: 1, wallJump: true, blockSwap: false, omniDash: false, zipMovers: true, refreshers: true, cash: 0 };
let draft = emptyDraft();
let mounted = false;
let frameQueued = false;

function emptyDraft() {
  return { name: '', description: '', pad: 12, useBase: false, baseState: 'start', blocks: {}, spikes: {}, vines: {}, tiles: {}, arrows: [], placed: [], removed: [], removedVines: [], removedObjects: [], removedScene: [], vineSprite: 'smallArc', start: null, end: null, spawn: null, courses: [], activeCourse: null, cat: 'blocks', pick: {}, player: { ...DEFAULT_PLAYER }, ownProgress: false };
}

let blocks = new Map();
let spikes = new Map();
let vines = new Map();
let tiles = new Map();
let placed = [];
let arrows = [];
let removed = new Set();
let removedVines = new Set();
let removedObjects = new Set();
let removedScene = new Set();
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

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (saved) draft = Object.assign(emptyDraft(), saved);
  } catch {}
  draft.player = { ...DEFAULT_PLAYER, ...(draft.player || {}) };
  migrateGates();
  blocks = new Map(Array.isArray(draft.blocks) ? draft.blocks.map((k) => [k, 'ground']) : Object.entries(draft.blocks));
  spikes = new Map(Object.entries(draft.spikes).map(([k, v]) => [k, typeof v === 'number' ? { q: v, c: 'spike' } : v]));
  vines = new Map(Object.entries(draft.vines));
  tiles = new Map(Object.entries(draft.tiles || {}));
  mossCells = new Map(Object.entries(draft.moss || {}));
  placed = [...(draft.placed || [])];
  arrows = (draft.arrows || []).map((a) => ({ ...a, cells: a.cells.map((c) => [...c]) }));
  for (const [k, v] of spikes) if (v.c === 'vine') { spikes.delete(k); vines.set(k, { s: 'smallArc', q: v.q }); }
  removedVines = new Set(draft.removedVines);
  removedObjects = new Set(draft.removedObjects);
  removedScene = new Set(draft.removedScene || []);
  removed = new Set(draft.removed);
}

function saveDraft() {
  draft.blocks = Object.fromEntries(blocks);
  draft.spikes = Object.fromEntries(spikes);
  draft.vines = Object.fromEntries(vines);
  draft.tiles = Object.fromEntries(tiles);
  draft.moss = Object.fromEntries(mossCells);
  draft.placed = placed;
  draft.arrows = arrows;
  draft.removedVines = [...removedVines];
  draft.removedObjects = [...removedObjects];
  draft.removedScene = [...removedScene];
  const vineSig = [...removedVines].sort().join(';') + '|' + [...removed].sort().join(';') + '|' + [...removedScene].sort().join(';');
  if (vineSig !== lastVineSig) { lastVineSig = vineSig; baseVersion++; artCache.clear(); }
  draft.removed = [...removed];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
  updateStatus();
}

function snapshot() {
  return JSON.stringify({ blocks: [...blocks], spikes: [...spikes], vines: [...vines], tiles: [...tiles], moss: [...mossCells], placed, arrows, removed: [...removed], removedVines: [...removedVines], removedObjects: [...removedObjects], removedScene: [...removedScene], courses: courses(), spawn: draft.spawn });
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  const o = JSON.parse(s);
  blocks = new Map(o.blocks);
  spikes = new Map(o.spikes);
  vines = new Map(o.vines);
  tiles = new Map(o.tiles || []);
  mossCells = new Map(o.moss || []);
  placed = o.placed || [];
  arrows = o.arrows || [];
  removedVines = new Set(o.removedVines);
  removedObjects = new Set(o.removedObjects);
  removedScene = new Set(o.removedScene || []);
  removed = new Set(o.removed);
  draft.courses = o.courses || [];
  if (o.start || o.end) { draft.start = o.start; draft.end = o.end; migrateGates(); }
  draft.spawn = o.spawn;
  saveDraft();
  requestDraw();
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
const SPIKE_LAYER = { spike: 'Spikes', blue: 'blueSpikes', orange: 'orangeSpikes' };
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
  const layer = SPIKE_LAYER[c];
  const uses = defUses();
  const spikes = base.defs.map((d, i) => [d, uses.get(i) || 0]).filter(([d]) => d.layer === layer && d.kind === 'spike');
  const best = (want) => spikes.filter(([d]) => d.base === want).sort((a, b) => b[1] - a[1])[0]?.[0];
  const d = (q === 1 && best(3)) || best(q) || best(0) || spikes[0][0];
  return { layer, tile: d.tile, matrix: rotMatrix(q - d.base) };
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
const catalogItem = (o) => base?.catalog?.[o.cat]?.[o.i];

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
function colouredTile(kind, cx, cy) {
  if (!base?.art) return null;
  const set = kind === 'blue' ? blueSet : orangeSet;
  const has = (x, y) => { const k = key(x, y); return blocks.get(k) === kind || (baseOn() && !!set?.has(k) && !removed.has(k)); };
  return plateTile(kind === 'blue' ? 'blueBlocks' : 'orangeBlocks', kind + '_ground_tileset_', PANEL, has, cx, cy);
}

let mossCells = new Map();
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
  if (!base) return cat === 'gates' ? gateItems() : cat === 'blocks' ? blockItems() : [];
  switch (cat) {
    case 'blocks': return blockItems();
    case 'hazards': return [
      { tool: 'spike', label: 'Spike', group: 'Spikes', thumb: { art: spikeTile('spike', 0).tile } },
      { tool: 'blueSpike', label: 'Blue spike', group: 'Spikes', thumb: { art: spikeTile('blue', 0).tile } },
      { tool: 'orangeSpike', label: 'Orange spike', group: 'Spikes', thumb: { art: spikeTile('orange', 0).tile } },
      ...vineSprites().filter((v) => base.catalog?.vineNames?.[v] !== null).map((v) => ({ tool: 'vine', vine: v, group: 'Thorn vines', label: base.catalog?.vineNames?.[v] || prettySprite(v), thumb: { img: '/maps/vines/' + encodeURIComponent(v) + '.png' } })),
    ];
    case 'objects':
      return (base.catalog?.objects || []).map((o, i) => ({ tool: 'object', i, label: o.name, group: 'Gameplay', thumb: { scene: mainSprite(o) } }))
        .filter((it) => !/checkpoint/i.test(it.label));
    case 'decor':
      return [
        { tool: 'arrow', label: 'Guide arrow', group: 'Paths', thumb: { arrow: true } },
        ...(base.catalog?.decor || []).map((o, i) => ({ tool: 'decor', i, label: o.name, group: 'Props', thumb: { scene: mainSprite(o) } })),
        ...(base.art.stamps || []).map((st, si) => ({ tool: 'stamp', si, label: st.name, group: 'Tile pieces', thumb: { stamp: si } }))
          .filter((it) => !/^Guide arrow /.test(it.label)),
      ];
    default: return gateItems();
  }
}
function blockItems() {
  return [
    { tool: 'block', label: 'Ground', group: 'Solid', thumb: { art: 'ground1_tileset_64' } },
    { tool: 'dark', label: 'Dark ground', group: 'Solid', thumb: { art: 'dark_ground_tileset_64' } },
    { tool: 'blue', label: 'Blue block', group: 'Colour swap', thumb: { art: 'blue_ground_tileset_10', color: COLORS.blue } },
    { tool: 'orange', label: 'Orange block', group: 'Colour swap', thumb: { art: 'orange_ground_tileset_10', color: COLORS.orange } },
    { tool: 'moss', label: 'Moss', group: 'Overgrowth', thumb: { sprite: base?.art?.autotiles?.moss?.['255']?.[0], color: COLORS.moss } },
  ];
}
function gateItems() {
  const obj = (name) => base?.catalog?.objects?.findIndex((o) => o.name === name) ?? -1;
  const cp = obj('Checkpoint'), ccp = obj('Course checkpoint');
  return [
    { tool: 'spawn', label: 'Spawn', group: 'Player', thumb: { color: COLORS.spawn } },
    { tool: 'start', label: 'Start gate', group: 'Course', thumb: { color: COLORS.start } },
    { tool: 'end', label: 'End gate', group: 'Course', thumb: { color: COLORS.end } },
    ...(ccp >= 0 ? [{ tool: 'object', i: ccp, label: 'Course checkpoint', group: 'Course', thumb: { color: COLORS.checkpoint } }] : []),
    ...(cp >= 0 ? [{ tool: 'object', i: cp, label: 'Checkpoint', group: 'Checkpoints', thumb: { color: COLORS.checkpoint } }] : []),
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
  else if (th.arrow && base) { const url = arrowThumb(); if (url) inner = `<img src="${url}" alt="" style="max-width:${size}px;max-height:${size}px;image-rendering:pixelated">`; }
  else if (th.stamp != null && base) { const url = stampThumb(th.stamp); if (url) inner = `<img src="${url}" alt="" style="max-width:${size}px;max-height:${size}px;image-rendering:pixelated">`; }
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
  const cur = currentIndex(cat), active = draft.cat === cat && !['erase', 'select', 'paste'].includes(tool);
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
  pop.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { selectItem(cat, Number(b.dataset.i)); closePopover(); }));
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
  return { end, time: c.time ?? z.time, backTime: c.backTime ?? z.backTime, span, size: across ? [base.thick, span] : [span, base.thick] };
}
function zipPlatform(item) {
  const part = item.parts.find((p) => p.n === 'ZipMoverMovingPart');
  const [w, h] = part?.sz || [96, 384];
  return Math.abs(item.zip.end[1]) < Math.abs(item.zip.end[0]) ? { thick: w, span: h } : { thick: h, span: w };
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
  const T = mul2(rot2(((cfg.rot || 0) * Math.PI) / 180), [(cfg.scale || 1) * (cfg.fx ? -1 : 1), 0, 0, (cfg.scale || 1) * (cfg.fy ? -1 : 1)]);
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
  const r = objectReach(item) + (zip ? Math.hypot(...zip.end) : 0);
  const tl = toWorld(0, 0), br = toWorld(canvas.width, canvas.height);
  if (o.x + r < tl.x || o.x - r > br.x || o.y + r < br.y || o.y - r > tl.y) return;
  const parts = objectParts(o, item).filter((p) => !HIDDEN_PART(p)).sort((a, b) => a.o - b.o);
  const now = performance.now() / 1000;
  let animated = false;
  ctx.save();
  for (const p of parts) {
    let sprite = p.s;
    if (p.frames) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; animated = true; }
    blitScene(sprite, p.m, o.x + p.x, o.y + p.y, alpha, p.dm, p.sz, p.c);
  }
  if (zip) {
    for (const p of parts) if (ZIP_MOVING.test(p.n || '')) blitScene(p.s, p.m, o.x + p.x + zip.end[0], o.y + p.y + zip.end[1], 0.35 * alpha, p.dm, p.sz, p.c);
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
  if (item.upgradeBox) drawUpgradeLabel(o);
  if (animated && !animTimer) animTimer = setTimeout(() => { animTimer = 0; requestDraw(); }, 60);
  if (!parts.length) {
    const b = item.box || [-50, -50, 50, 50];
    const a = toScreen(o.x + b[0], o.y + b[3]), z = toScreen(o.x + b[2], o.y + b[1]);
    const col = o.course && courseById(o.course) ? courseColor(o.course) : COLORS.checkpoint;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(a.x, a.y, z.x - a.x, z.y - a.y);
    ctx.fillStyle = col;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(item.name.toUpperCase() + (o.course && courseById(o.course) ? ' ' + courseNumber(o.course) : ''), (a.x + z.x) / 2, a.y - 4);
    ctx.restore();
  }
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
  const w = cellWorld(cx, cy), at = { x: w.x + CELL / 2, y: w.y + CELL / 2 };
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
  if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); if (undoStack.length > 200) undoStack.shift(); }
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
function stampThumb(si) {
  stampThumb.cache ||= new Map();
  if (stampThumb.cache.has(si)) return stampThumb.cache.get(si);
  const st = base.art.stamps[si], g = layerGrid(st.layer);
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
  if (item.box && wx >= o.x + item.box[0] && wx <= o.x + item.box[2] && wy >= o.y + item.box[1] && wy <= o.y + item.box[3]) return true;
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

let placeRot = 0;
let placeFlip = false;
let selection = null;
let brush = null;

function worldAt(e) {
  const r = canvas.getBoundingClientRect();
  return toWorld(e.clientX - r.left, e.clientY - r.top);
}

function itemAt(wx, wy) {
  const oi = placed.findLastIndex((o) => objectHit(o, wx, wy));
  if (oi >= 0) return { kind: 'object', index: oi };
  const m = markerAt(wx, wy);
  if (m) return { kind: 'gate', ...m };
  const c = cellOf(wx, wy), k = key(c.cx, c.cy);
  if (spikes.has(k) || blocks.has(k)) return { kind: 'cell', k };
  const t = tileAt(wx, wy);
  if (t) return { kind: 'tile', key: t[0] };
  const v = vineAt(wx, wy);
  if (v?.own) return { kind: 'cell', k: v.k, vine: true };
  return null;
}

function zipHandle(o) {
  const z = zipConfig(o);
  return z ? { x: o.x + z.end[0], y: o.y + z.end[1] } : null;
}

function selectDown(e) {
  const w = worldAt(e);
  const sel = selection?.kind === 'object' ? placed[selection.index] : null;
  const h = sel && zipHandle(sel);
  if (h && Math.hypot(w.x - h.x, w.y - h.y) * cam.scale < 12) {
    drag = { pan: false, zip: true, before: snapshot(), changed: false };
    return;
  }
  const hit = itemAt(w.x, w.y);
  if (hit) {
    selection = hit;
    if (hit.kind === 'gate' && hit.course) draft.activeCourse = hit.course;
    drag = { pan: false, move: hit.kind === 'object', gate: hit.kind === 'gate' ? hit : null, start: w, orig: hit.kind === 'object' ? { x: placed[hit.index].x, y: placed[hit.index].y } : null, before: snapshot(), changed: false };
  } else {
    const c = cellOf(w.x, w.y);
    selection = { kind: 'region', x0: c.cx, y0: c.cy, x1: c.cx, y1: c.cy };
    drag = { pan: false, region: c };
  }
  renderConfig();
  requestDraw();
}

function selectMove(e) {
  const w = worldAt(e);
  if (drag.region) {
    const c = cellOf(w.x, w.y);
    selection = { kind: 'region', x0: Math.min(drag.region.cx, c.cx), y0: Math.min(drag.region.cy, c.cy), x1: Math.max(drag.region.cx, c.cx), y1: Math.max(drag.region.cy, c.cy) };
    renderConfig();
  } else if (drag.gate) {
    const c = cellOf(w.x, w.y), which = drag.gate.which, g = gateAt(c.cx, c.cy, which);
    const cur = which === 'spawn' ? draft.spawn : courseById(drag.gate.course)?.[which];
    if (cur && (cur.x !== g.x || cur.y !== g.y)) changed(() => { if (which === 'spawn') draft.spawn = g; else courseById(drag.gate.course)[which] = g; });
  } else if (drag.move) {
    const o = placed[selection.index];
    let mx = w.x - drag.start.x, my = w.y - drag.start.y;
    if (!e.shiftKey) { mx = Math.round(mx / CELL) * CELL; my = Math.round(my / CELL) * CELL; }
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
  if (!drag.changed) { drag.changed = true; undoStack.push(drag.before); if (undoStack.length > 200) undoStack.shift(); }
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

function nudgeSelection(dx, dy, fine) {
  const sel = selection;
  if (!sel) return false;
  pushUndo();
  const shiftKey = (k) => { const [x, y] = unkey(k); return key(x + dx, y + dy); };
  const moveArrow = (id) => { const a = arrows.find((x) => x.id === id); if (a) a.cells = a.cells.map(([x, y]) => [x + dx, y + dy]); };
  if (sel.kind === 'object') {
    const o = placed[sel.index], step = fine ? 1 : CELL;
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
  } else if (sel.kind === 'gate') {
    const g = sel.which === 'spawn' ? draft.spawn : courseById(sel.course)?.[sel.which];
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
    for (const o of placed) { const c = cellOf(o.x, o.y); if (inR(c.cx, c.cy)) { o.x += dx * CELL; o.y += dy * CELL; } }
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
    draft.spawn = shiftG(draft.spawn);
    for (const c of courses()) { c.start = shiftG(c.start); c.end = shiftG(c.end); }
    Object.assign(sel, { x0: sel.x0 + dx, x1: sel.x1 + dx, y0: sel.y0 + dy, y1: sel.y1 + dy });
  }
  saveDraft();
  renderConfig();
  requestDraw();
  return true;
}

function deleteSelection() {
  if (!selection) return;
  pushUndo();
  if (selection.kind === 'object') placed.splice(selection.index, 1);
  else if (selection.kind === 'gate') clearMarker(selection);
  else if (selection.kind === 'tile') { const id = tiles.get(selection.key)?.arrow; if (id) removeArrow(id); else tiles.delete(selection.key); }
  else if (selection.kind === 'cell') { if (selection.vine) vines.delete(selection.k); else { blocks.delete(selection.k); spikes.delete(selection.k); } }
  else if (selection.kind === 'region') {
    const saveTool = tool;
    tool = 'erase';
    const inRegion = (cx, cy) => cx >= selection.x0 && cx <= selection.x1 && cy >= selection.y0 && cy <= selection.y1;
    placed = placed.filter((o) => { const c = cellOf(o.x, o.y); return !inRegion(c.cx, c.cy); });
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
  selection = null;
  saveDraft();
  renderConfig();
  requestDraw();
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

function copySelection() {
  if (selection?.kind !== 'region') { flash('Drag out a region with Select (Q) first.', true); return; }
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
  { id: 'zipMovers', label: 'Zip movers' },
  { id: 'refreshers', label: 'Refreshers' },
  { id: 'clones', label: 'Clones', multi: true, local: true },
  { id: 'baseReward', label: 'Base reward', multi: true, local: true },
  { id: 'cloneMult', label: 'Clone reward multiplier', multi: true, local: true },
  { id: 'fastClone', label: 'Fast clone chance', multi: true, local: true },
  { id: 'bigClone', label: 'Big clone chance', multi: true, local: true },
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
  const linked = !!courseById(o.course);
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
  ['zipMovers', 'Zip movers work'], ['refreshers', 'Refreshers work'],
];
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
  el.innerHTML = html;
  const set = (id, v) => { pushUndo(); draft.player = { ...draft.player, [id]: v }; saveDraft(); renderPlayerPanel(); };
  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => set(b.dataset.step, Math.max(0, Math.min(99, (draft.player[b.dataset.step] || 0) + Number(b.dataset.d))))));
  el.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const id = inp.dataset.pl;
      if (id === 'own') { pushUndo(); draft.ownProgress = inp.checked; saveDraft(); renderPlayerPanel(); }
      else if (inp.type === 'checkbox') set(id, inp.checked);
      else set(id, Math.max(0, Math.round(Number(inp.value) || 0)));
    });
  });
}

function renderConfig() {
  const el = root?.querySelector('#mm-config');
  if (!el) return;
  if (!selection) { el.hidden = true; return; }
  const num = (id, label, value, step = 1) => `<label>${label}<input class="mm-input" type="number" data-cfg="${id}" value="${Math.round(value * 1000) / 1000}" step="${step}"></label>`;
  const chk = (id, label, on) => `<label class="mm-check"><input type="checkbox" data-cfg="${id}"${on ? ' checked' : ''}> ${label}</label>`;
  let html = '';
  if (selection.kind === 'object') {
    const o = placed[selection.index], item = catalogItem(o);
    if (!o || !item) { selection = null; el.hidden = true; return; }
    const cfg = o.cfg || {};
    html += `<div class="mm-config-title">${item.name}<span>${o.cat === 'objects' ? 'object' : 'decoration'}</span></div>`;
    html += `<div class="mm-config-row">${num('x', 'X', o.x)}${num('y', 'Y', o.y)}</div>`;
    if (LINKABLE(item)) html += `<div class="mm-config-row"><label>Course<select class="mm-input" data-cfg="link"><option value="">None</option>${courses().map((c) => `<option value="${c.id}"${o.course === c.id ? ' selected' : ''}>Course ${courseNumber(c.id)}</option>`).join('')}</select></label></div>`;
    const zip = zipConfig(o, item);
    if (item.upgradeBox) html += upgradeConfigHtml(o, num);
    else if (zip) {
      const len = Math.hypot(...zip.end), ang = (Math.atan2(zip.end[1], zip.end[0]) * 180) / Math.PI;
      html += `<div class="mm-config-sub">Track - drag the end node (8 directions, whole cells)</div>`;
      html += `<div class="mm-config-row">${num('zipLen', 'Length', len, CELL)}${num('zipAng', 'Direction (°)', ang, 45)}</div>`;
      html += `<div class="mm-config-row">${num('zipTime', 'Travel time (s)', zip.time, 0.1)}${num('zipBack', 'Return time (s)', zip.backTime, 0.1)}</div>`;
      html += `<div class="mm-config-row">${num('zipSpan', 'Platform length', zip.span, CELL)}</div>`;
    } else {
      html += `<div class="mm-config-row">${num('rot', 'Rotation (°) R', cfg.rot || 0, 90)}${o.cat === 'decor' ? num('scale', 'Scale', cfg.scale || 1, 0.1) : ''}</div>`;
      if (item.stretch) html += `<div class="mm-config-row">${num('width', 'Width (tiles the sprite)', cfg.width || item.stretch.width, 16)}</div>`;
      html += `<div class="mm-config-row">${chk('fx', 'Flip X (F)', cfg.fx)}${chk('fy', 'Flip Y', cfg.fy)}</div>`;
    }
    for (const [f, def] of Object.entries(item.fields || {})) html += `<div class="mm-config-row">${num('field:' + f, FIELD_LABELS[f] || f, cfg.fields?.[f] ?? def, 0.1)}</div>`;
  } else if (selection.kind === 'gate') {
    const c = courseById(selection.course);
    if (selection.which === 'spawn') {
      if (!draft.spawn) { selection = null; el.hidden = true; return; }
      html += `<div class="mm-config-title">Spawn<span>where the player starts</span></div>`;
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
    html += `<div class="mm-config-row"><button class="mm-tool" data-act="rotL">⟲ Rotate</button><button class="mm-tool" data-act="rotR">Rotate ⟳</button></div>`;
    html += `<div class="mm-config-row">${chk('fx', 'Flip X', t.fx)}${chk('fy', 'Flip Y', t.fy)}</div>`;
  } else if (selection.kind === 'cell') {
    const sp = spikes.get(selection.k), kind = selection.vine ? 'Vine' : sp ? { spike: 'Spike', blue: 'Blue spike', orange: 'Orange spike' }[sp.c] : { ground: 'Ground', dark: 'Dark ground', blue: 'Blue block', orange: 'Orange block' }[blocks.get(selection.k)];
    html += `<div class="mm-config-title">${kind}<span>cell ${selection.k}</span></div>`;
    if (sp || selection.vine) html += `<div class="mm-config-row"><button class="mm-tool" data-act="rotCell">Rotate ⟳ (R)</button></div>`;
  } else {
    const { x0, y0, x1, y1 } = selection;
    html += `<div class="mm-config-title">Region<span>${x1 - x0 + 1} x ${y1 - y0 + 1} cells</span></div>`;
    html += `<div class="mm-config-row"><button class="mm-tool" data-act="copy">Copy (Ctrl+C)</button><button class="mm-tool" data-act="delete">Delete</button></div>`;
    html += `<div class="mm-config-sub">Copying takes the level's own tiles too - paste them anywhere.</div>`;
  }
  if (selection.kind !== 'region') html += `<div class="mm-config-row"><button class="mm-tool" data-act="delete">Delete (Del)</button></div>`;
  el.innerHTML = html;
  el.hidden = false;
  el.querySelectorAll('[data-cfg]').forEach((inp) => inp.addEventListener('change', () => applyConfig(inp)));
  el.querySelectorAll('input').forEach((inp) => inp.addEventListener('keydown', (e) => e.stopPropagation()));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => configAction(b.dataset.act)));
}

function applyConfig(inp) {
  const id = inp.dataset.cfg;
  if (id.startsWith('up:')) return applyUpgradeConfig(id.slice(3), inp.value);
  if (id === 'link' || id === 'gatecourse' || id.startsWith('reward:')) return applyCourseConfig(id, inp.value);
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
    else if (id.startsWith('zip')) {
      const cur = zipConfig(o), z = { ...cfg.zip };
      const len = Math.hypot(...cur.end), ang = Math.atan2(cur.end[1], cur.end[0]);
      if (id === 'zipLen') z.end = snapZipEnd(Math.cos(ang) * v, Math.sin(ang) * v);
      if (id === 'zipAng') z.end = snapZipEnd(Math.cos((v * Math.PI) / 180) * len, Math.sin((v * Math.PI) / 180) * len);
      if (z.end && !z.end[0] && !z.end[1]) delete z.end;
      if (id === 'zipTime') z.time = v;
      if (id === 'zipBack') z.backTime = v;
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
  if (act === 'copy') return copySelection();
  if (act === 'rotCell') { hover = cellOf(...(() => { const [cx, cy] = unkey(selection.k); const w = cellWorld(cx, cy); return [w.x + 1, w.y + 1]; })()); return rotateSpikeAtHover(); }
  if (selection?.kind !== 'tile') return;
  const t = tiles.get(selection.key);
  pushUndo();
  tiles.set(selection.key, { ...t, m: undefined, q: (((t.q || 0) + (act === 'rotR' ? 1 : 3)) % 4) });
  saveDraft();
  renderConfig();
  requestDraw();
}

function drawSelection() {
  if (!selection) return;
  ctx.save();
  ctx.strokeStyle = COLORS.start;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  if (selection.kind === 'gate') {
    const g = selection.which === 'spawn' ? draft.spawn : courseById(selection.course)?.[selection.which];
    const b = { spawn: SPAWN_BOX, start: START_BOX, end: END_BOX }[selection.which];
    if (g) { const c = toScreen(g.x + b.dx, g.y + b.dy), w = Math.max(10, b.w * cam.scale) + 8, h = Math.max(10, b.h * cam.scale) + 8; ctx.strokeRect(c.x - w / 2, c.y - h / 2, w, h); }
  } else if (selection.kind === 'region') {
    const a = cellRect(selection.x0, selection.y1), b = cellRect(selection.x1, selection.y0);
    ctx.fillStyle = 'rgba(65, 248, 141, 0.08)';
    ctx.fillRect(a.x, a.y, b.x + b.w - a.x, b.y + b.h - a.y);
    ctx.strokeRect(a.x, a.y, b.x + b.w - a.x, b.y + b.h - a.y);
  } else if (selection.kind === 'tile') {
    const t = tiles.get(selection.key);
    if (t) { const g = layerGrid(t.layer), c = tileCenter(t.layer, selection.key), a = toScreen(c.x - g.size / 2, c.y + g.size / 2); ctx.strokeRect(a.x, a.y, g.size * cam.scale, g.size * cam.scale); }
  } else if (selection.kind === 'cell') {
    const [cx, cy] = unkey(selection.k), r = cellRect(cx, cy);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  } else if (selection.kind === 'object') {
    const o = placed[selection.index];
    if (o) {
      const c = toScreen(o.x, o.y);
      ctx.beginPath(); ctx.arc(c.x, c.y, 10, 0, Math.PI * 2); ctx.stroke();
      const h = zipHandle(o);
      if (h) {
        const hc = toScreen(h.x, h.y);
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(hc.x, hc.y); ctx.stroke();
        ctx.fillStyle = COLORS.start;
        ctx.beginPath(); ctx.arc(hc.x, hc.y, 7, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  ctx.restore();
}

function editorState() {
  saveDraft();
  const { name, description, useBase, baseState, blocks: b, spikes: sp, vines: v, tiles: t, moss: mo, arrows: ar, placed: pl, removed: r, removedVines: rv, removedObjects: ro, removedScene: rs, courses: cs, spawn, player, ownProgress } = draft;
  return { version: 1, name, description, useBase, baseState, blocks: b, spikes: sp, vines: v, tiles: t, moss: mo, arrows: ar, placed: pl, removed: r, removedVines: rv, removedObjects: ro, removedScene: rs, courses: cs, spawn, player, ownProgress };
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
  const st = map.editor;
  if (!st) { flash('That map wasn\'t made in this editor (no editor data in it).', true); return; }
  pushUndo();
  Object.assign(draft, { blocks: {}, spikes: {}, vines: {}, tiles: {}, moss: {}, arrows: [], placed: [], courses: [], start: null, end: null, player: { ...DEFAULT_PLAYER }, ownProgress: false, removed: [], removedVines: [], removedObjects: [], removedScene: [] }, st);
  if (draft.useBase && !base) { try { await loadBase(true); } catch { draft.useBase = false; } }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  loadDraft();
  applyBaseState();
  selection = null;
  saveDraft();
  syncBaseUi();
  root.querySelector('#mm-name').value = draft.name || '';
  root.querySelector('#mm-desc').value = draft.description || '';
  renderConfig();
  requestDraw();
  flash(`Loaded ${draft.name || file.name}`);
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
  const options = seats(cx, cy);
  if (!options.length) return 0;
  for (const q of options) {
    const along = q % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    if (along.some(([dx, dy]) => neighbourTurn(cx + dx, cy + dy) === q)) return q;
  }
  return options[0];
}

const PLATE = { TL: 56, T: 57, TR: 58, L: 63, C: 64, R: 65, BL: 70, B: 71, BR: 72 };
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

function cloneConfig(o, item) {
  const cfg = o.cfg || {}, out = {};
  if (item.upgradeBox) {
    const u = upgradeConfig(o);
    const local = UPGRADE_KINDS.find((k) => k.id === u.kind)?.local;
    return { ...(courseById(o.course) ? { course: o.course } : {}), upgrade: { id: o.uid || 'box' + Math.round(o.x) + '_' + Math.round(o.y), kind: u.kind, label: local ? u.label : upgradeLabel(u), currency: u.currency, prices: upgradePrices(u), scale: u.scale, add: u.add, power: u.power, max: u.max } };
  }
  if (item.worldScale) {
    const S = item.worldScale * (cfg.scale || 1);
    return { absolute: true, rotation: cfg.rot || 0, scale: [S * (cfg.fx ? -1 : 1), S * (cfg.fy ? -1 : 1)], tint: [1, 1, 1] };
  }
  if (item.stretch && cfg.width && cfg.width !== item.stretch.width) out.width = cfg.width;
  if (cfg.rot) out.rotation = cfg.rot;
  if ((cfg.scale && cfg.scale !== 1) || cfg.fx || cfg.fy) out.scale = [(cfg.scale || 1) * (cfg.fx ? -1 : 1), (cfg.scale || 1) * (cfg.fy ? -1 : 1)];
  if (cfg.fields && Object.keys(cfg.fields).length) out.fields = cfg.fields;
  const zip = item.zip && cfg.zip ? zipConfig(o, item) : null;
  if (zip) out.zip = { end: zip.end, time: zip.time, backTime: zip.backTime, size: zip.size };
  if (courseById(o.course)) out.course = o.course;
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

function buildOverlay() {
  const at = (k) => { const [cx, cy] = unkey(k); const w = cellWorld(cx, cy); return { x: w.x + CELL / 2, y: w.y + CELL / 2 }; };
  const objects = [];
  removed.forEach((k) => objects.push({ type: 'erase', ...at(k) }));
  removedVines.forEach((k) => {
    const h = baseHaz.get(k);
    if (h) objects.push({ type: 'erase', tilemap: base.defs[h.d].layer, ...at(k) });
  });
  for (const o of baseObjects) if (removedObjects.has(o.id)) objects.push({ type: 'hide', path: o.path, srcX: o.x, srcY: o.y });
  for (const p of sceneList?.items || []) if (p.id && removedScene.has(p.id)) objects.push({ type: 'hide', path: p.p, srcX: p.x, srcY: p.y, rendererOnly: true });
  blocks.forEach((kind, k) => {
    const [cx, cy] = unkey(k);
    const art = isGround(kind) && groundTile(cx, cy, kind === 'dark');
    if (art) objects.push({ type: 'tile', tilemap: art.layer, tileName: art.tile, ...at(k), matrix: art.matrix, ...(art.spriteFrom ? { spriteFrom: art.spriteFrom } : {}) });
    else if (isGround(kind)) objects.push({ type: 'ground', ...at(k) });
    else {
      const t = colouredTile(kind, cx, cy);
      objects.push(t ? { type: 'tile', tilemap: t.layer, tileName: t.tile, ...at(k), matrix: t.matrix, ...(t.spriteFrom ? { spriteFrom: t.spriteFrom } : {}) } : { type: 'coloredGround', color: kind, ...at(k) });
    }
  });
  mossCells.forEach((_, k) => { const c = mossCenter(k); objects.push({ type: 'tile', tilemap: 'moss', tileName: 'Moss', x: c.x, y: c.y, matrix: [1, 0, 0, 1] }); });
  spikes.forEach((sp, k) => {
    const [cx, cy] = unkey(k);
    const t = spikeTile(sp.c, spikeTurn(sp, cx, cy));
    objects.push({ type: 'tile', tilemap: t.layer, tileName: t.tile, ...at(k), matrix: t.matrix });
  });
  vines.forEach((v, k) => {
    const t = vineTile(v.s, v.q);
    objects.push({ type: 'tile', tilemap: t.layer, tileName: t.tile, ...at(k), matrix: t.matrix });
  });
  tiles.forEach((t, k) => {
    const c = tileCenter(t.layer, k);
    objects.push({ type: 'tile', tilemap: tilemapName(t.layer), tileName: t.tile, x: c.x, y: c.y, matrix: tileMatrix(t) });
  });
  for (const o of placed) {
    const item = catalogItem(o);
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, x: Math.round(o.x), y: Math.round(o.y), ...cloneConfig(o, item) });
  }

  const full = completeCourses(), first = full[0], hasGates = !!first;
  const spawn = draft.spawn || first?.start || viewSpawn();
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
    editor: editorState(),
    groups: [{
      startX: r((hasGates ? first.start : spawn).x), startY: r((hasGates ? first.start : spawn).y),
      endX: r((hasGates ? first.end : spawn).x), endY: r((hasGates ? first.end : spawn).y),
      spawnX: r(spawn.x), spawnY: r(spawn.y),
      gates: hasGates,
      reward: first?.reward || { currency: 'Cash', amount: 0 },
      courses: full.map((c) => courseJson(c)),
      objects,
    }],
  };
}

function buildMap() {
  if (baseOn()) return buildOverlay();
  const area = exportArea();
  if (!area) throw new Error('Place something first, or import the base map.');
  const gates = effectiveGates(area);
  const hasGates = !!(gates.start && gates.end);
  const spawn = draft.spawn || gates.start || viewSpawn();

  const inArea = (cx, cy) => cx >= area.x0 && cx <= area.x1 && cy >= area.y0 && cy <= area.y1;
  const cells = new Map();
  if (baseOn()) importBaseCells(cells, inArea);
  blocks.forEach((kind, k) => cells.set(k, { t: kind }));
  spikes.forEach((sp, k) => { const [cx, cy] = unkey(k); cells.set(k, { t: 'tile', ...spikeTile(sp.c, spikeTurn(sp, cx, cy)) }); });
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
    const art = isGround(v.t) && groundTile(cx, cy, v.t === 'dark');
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
    objects.push({ type: 'clone', path: o.path, srcX: o.x, srcY: o.y, x: Math.round(o.x - origin.x), y: Math.round(o.y - origin.y) });
  }
  for (const [k, v] of vineCells) {
    const [cx, cy] = unkey(k);
    objects.push({ type: 'tile', tilemap: v.layer, tileName: v.tile, cellX: cx, cellY: cy, matrix: v.matrix });
  }
  tiles.forEach((t, k) => {
    const c = tileCenter(t.layer, k), cc = cellOf(c.x, c.y);
    objects.push({ type: 'tile', tilemap: tilemapName(t.layer), tileName: t.tile, cellX: cc.cx, cellY: cc.cy, matrix: tileMatrix(t) });
  });
  mossCells.forEach((_, k) => { const c = mossCenter(k), cc = cellOf(c.x, c.y); objects.push({ type: 'tile', tilemap: 'moss', tileName: 'Moss', cellX: cc.cx, cellY: cc.cy, matrix: [1, 0, 0, 1] }); });
  for (const o of placed) {
    const item = catalogItem(o);
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, x: Math.round(o.x - origin.x), y: Math.round(o.y - origin.y), ...cloneConfig(o, item) });
  }

  return {
    formatVersion: 1,
    name: draft.name.trim() || 'Untitled map',
    description: draft.description.trim(),
    images: [],
    customImages: [],
    ...(!draft.ownProgress ? { player: draft.player } : {}),
    editor: editorState(),
    groups: [{
      startX: Math.round((hasGates ? gates.start : spawn).x - origin.x), startY: Math.round((hasGates ? gates.start : spawn).y - origin.y),
      endX: Math.round((hasGates ? gates.end : spawn).x - origin.x), endY: Math.round((hasGates ? gates.end : spawn).y - origin.y),
      spawnX: Math.round(spawn.x - origin.x), spawnY: Math.round(spawn.y - origin.y),
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

function requestDraw() {
  if (IN_WORKER || frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; draw(); });
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
  spriteOrders = [...new Set([...pick(sc?.placements).map((p) => p.o), ...(sc?.groups || []).map((g) => g.o)])].sort((a, b) => a - b);
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
  const drawItemsBelow = (limit) => {
    const from = next;
    while (next < items.length && items[next].o < limit) next++;
    if (next > from) drawSceneItems(W, H, items, from, next);
  };
  for (const band of [...artIndex.keys()].sort((a, b) => a - b)) {
    drawItemsBelow(band < spriteOrders.length ? spriteOrders[band] : Infinity);
    if (staticRender) drawBandDirect(W, H, band);
    else pending = drawArtBand(W, H, band, lod) || pending;
  }
  drawItemsBelow(Infinity);
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

function drawBackground(W, H) {
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
    ctx.globalAlpha = b.a ?? 1;
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
    return { ...p, reach, live: !!(p.frames || p.sc), id: p.p ? p.p + '@' + p.x + ',' + p.y : null };
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
    if (p.x + p.reach < tl.x || p.x - p.reach > br.x || p.y + p.reach < br.y || p.y - p.reach > tl.y) continue;
    if (p.live && staticRender && cam.scale >= LIVE_MIN_SCALE) continue;
    let sprite = p.s;
    if (p.frames && !staticRender) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; animated = true; }
    if (p.sc && !staticRender) animated = true;
    blitScene(sprite, p.m, p.x, p.y, p.a, p.dm, p.sz, p.c, p.sc && !staticRender ? p.sc : null, now);
  }
  ctx.restore();
  if (animated && !animTimer) animTimer = setTimeout(() => { animTimer = 0; requestDraw(); }, 40);
}

const LIVE_MIN_SCALE = 0.25;

function drawLiveItems(W, H) {
  if (!sceneReady() || !sceneList || cam.scale < LIVE_MIN_SCALE) return;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const visible = sceneList.items.filter((p) => p.live && !(p.id && removedScene.has(p.id)) && !(p.x + p.reach < tl.x || p.x - p.reach > br.x || p.y + p.reach < br.y || p.y - p.reach > tl.y));
  if (!visible.length) return;
  const orderOf = (name, fallback) => base.art.layers.find((l) => l.name === name)?.order ?? fallback;
  const covers = [[groundSet, orderOf('new awesome nikki ground', 5)], [mossSet, orderOf('moss', 7)], [blueSet, orderOf('blueBlocks', 4)], [orangeSet, orderOf('orangeBlocks', 4)]];
  const layerCv = scratchCanvas('live');
  const g = layerCv.getContext('2d');
  const saved = ctx;
  for (let i = 0; i < visible.length;) {
    const o = visible[i].o;
    let j = i;
    while (j < visible.length && visible[j].o === o) j++;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, layerCv.width, layerCv.height);
    ctx = g;
    drawSceneItems(W, H, visible, i, j);
    ctx = saved;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let n = i; n < j; n++) { const p = visible[n]; x0 = Math.min(x0, p.x - p.reach); x1 = Math.max(x1, p.x + p.reach); y0 = Math.min(y0, p.y - p.reach); y1 = Math.max(y1, p.y + p.reach); }
    const a = cellOf(Math.max(x0, tl.x), Math.max(y0, br.y)), b = cellOf(Math.min(x1, br.x), Math.min(y1, tl.y));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    for (let cy = a.cy; cy <= b.cy; cy++) for (let cx = a.cx; cx <= b.cx; cx++) {
      const k = key(cx, cy);
      if (removed.has(k) || !covers.some(([set, order]) => order >= o && set?.has(k))) continue;
      const r = cellRect(cx, cy);
      g.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.w) + 1, Math.ceil(r.h) + 1);
    }
    g.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layerCv, 0, 0);
    ctx.restore();
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

function drawSceneText(tl, br) {
  const fonts = base.scene.fonts || [];
  if (!fonts.length || !fonts.every((f, i) => !f || fontImage(i).complete)) return;
  ctx.save();
  for (const t of sceneList.texts) {
    const reach = Math.max(t.w, t.h) + t.size * t.k * 4;
    if (t.x + reach < tl.x || t.x - reach > br.x || t.y + reach < br.y || t.y - reach > tl.y) continue;
    if (!sizeCache.has(t)) sizeCache.set(t, textSize(t));
    if (sizeCache.get(t) * t.k * cam.scale < 2.5) continue;
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
  if (cam.scale < 0.2) return;
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, c.x, c.y - h / 2 - 4);
}

const TILE_PX = 128;
const TILE_BUDGET_MS = 6;
const MAX_TILES = 2000;
const tileCache = new Map();
let baseVersion = 0;
let staticRender = false;
let lastVineSig = '';

function invalidateBase() { baseVersion++; requestDraw(); }

function lodFor(scale) { return Math.max(-8, Math.min(1, Math.ceil(Math.log2(scale)))); }
function tileKey(z, tx, ty) { return baseVersion + '|' + draft.baseState + '|' + z + '|' + tx + '|' + ty; }

function cachedTile(key) {
  const c = tileCache.get(key);
  if (c) { tileCache.delete(key); tileCache.set(key, c); }
  return c;
}

function renderBaseLayer(W, H, useArt) {
  const tl = cellOf(toWorld(0, 0).x, toWorld(0, 0).y);
  const br = cellOf(toWorld(W, H).x, toWorld(W, H).y);
  const minCx = tl.cx - 1, maxCx = br.cx + 1, minCy = br.cy - 1, maxCy = tl.cy + 1;
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

function renderRegion(cv, x, y, scale) {
  const saved = [canvas, ctx, cam];
  canvas = cv;
  ctx = cv.getContext('2d');
  cam = { x, y, scale };
  staticRender = true;
  try {
    renderBaseLayer(cv.width, cv.height, artReady());
  } finally {
    staticRender = false;
    [canvas, ctx, cam] = saved;
  }
}

function renderTile(z, tx, ty) {
  const s = Math.pow(2, z), T = TILE_PX / s;
  const cv = makeCanvas();
  cv.width = cv.height = TILE_PX;
  renderRegion(cv, (tx + 0.5) * T, (ty + 0.5) * T, s);
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

function stepTileJob(job, z, tx, ty) {
  const s = Math.pow(2, z), T = TILE_PX / s, size = TILE_PX / job.n;
  const px = job.next % job.n, py = Math.floor(job.next / job.n);
  if (!pieceCanvas) pieceCanvas = makeCanvas();
  pieceCanvas.width = pieceCanvas.height = size;
  renderRegion(pieceCanvas, tx * T + ((px + 0.5) * T) / job.n, (ty + 1) * T - ((py + 0.5) * T) / job.n, s);
  job.g.drawImage(pieceCanvas, px * size, py * size);
  return ++job.next >= job.n * job.n;
}

function coarserTile(z, tx, ty) {
  const T = TILE_PX / Math.pow(2, z);
  for (let z2 = z - 1; z2 >= z - 4; z2--) {
    const s2 = Math.pow(2, z2), T2 = TILE_PX / s2;
    const tx2 = Math.floor((tx * T) / T2), ty2 = Math.floor((ty * T) / T2);
    const c = tileCache.get(tileKey(z2, tx2, ty2));
    if (c) return [c, (tx * T - tx2 * T2) * s2, (T2 * (ty2 + 1) - (ty + 1) * T) * s2, T * s2, T * s2];
  }
  return null;
}

function drawFromFiner(z, tx, ty, x0, y0, w, h) {
  let any = false;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const c = tileCache.get(tileKey(z + 1, tx * 2 + dx, ty * 2 + dy));
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

function drawBaseTiles(W, H, useArt) {
  if (useArt) drawBackground(W, H);
  const z = lodFor(cam.scale), s = Math.pow(2, z), T = TILE_PX / s;
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
    const key = tileKey(z, tx, ty);
    let c = cachedTile(key);
    let job = null;
    if (!c) {
      if (workers) requestTile(key, z, tx, ty);
      else if (visible) {
        job = tileJob(key, z);
        while (performance.now() < deadline) {
          if (stepTileJob(job, z, tx, ty)) { c = job.cv; storeTile(key, c); tileJobs.delete(key); job = null; break; }
        }
      }
    }
    if (!visible) continue;
    inView++;
    const a = toScreen(tx * T, (ty + 1) * T), b = toScreen((tx + 1) * T, ty * T);
    const x0 = Math.round(a.x), y0 = Math.round(a.y), w = Math.round(b.x) - x0, h = Math.round(b.y) - y0;
    if (c) { ctx.drawImage(c, x0, y0, w, h); shown++; continue; }
    missing = true;
    const coarse = coarserTile(z, tx, ty);
    if (coarse) ctx.drawImage(coarse[0], coarse[1], coarse[2], coarse[3], coarse[4], x0, y0, w, h);
    else drawFromFiner(z, tx, ty, x0, y0, w, h);
    if (job?.next) ctx.drawImage(job.cv, x0, y0, w, h);
  }
  if (tileJobs.size > 256) {
    const current = baseVersion + '|' + draft.baseState + '|' + z + '|';
    for (const k of tileJobs.keys()) if (!k.startsWith(current)) tileJobs.delete(k);
  }
  if (loading?.render) {
    setLoading(0.7 + (0.3 * shown) / Math.max(1, inView), `Drawing the view ${shown} / ${inView}`);
    if (!missing) hideLoading();
  }
  if (missing && !workers) requestDraw();
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
  return { baseState: draft.baseState, removed: [...removed], removedVines: [...removedVines], removedScene: [...removedScene], version: baseVersion };
}

function onWorkerMessage(worker, m) {
  if (m.type === 'ready') { worker.ready = true; pool.ready++; requestDraw(); return; }
  if (m.type === 'unsupported') { failWorkers(); return; }
  if (m.type !== 'tile') return;
  worker.jobs--;
  pool.inflight.delete(m.key);
  if (m.bitmap && m.key.startsWith(baseVersion + '|')) { storeTile(m.key, m.bitmap); requestDraw(); }
  else m.bitmap?.close?.();
}

function tileWorkersReady() {
  if (!pool.ready) return false;
  if (pool.version !== baseVersion) {
    pool.version = baseVersion;
    pool.inflight.clear();
    const state = workerState();
    for (const w of pool.workers) w.postMessage({ type: 'state', state });
  }
  return true;
}

function requestTile(key, z, tx, ty) {
  if (pool.inflight.has(key)) return;
  const free = pool.workers.filter((w) => w.ready).sort((a, b) => a.jobs - b.jobs)[0];
  if (!free || free.jobs >= 3) return;
  free.jobs++;
  pool.inflight.set(key, free);
  free.postMessage({ type: 'tile', key, z, tx, ty });
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
  if (!layer || draft.baseState !== state.baseState) {
    draft.baseState = state.baseState;
    applyBaseState();
  }
  baseVersion = state.version;
}

export function workerRenderTile(z, tx, ty) {
  return renderTile(z, tx, ty).transferToImageBitmap();
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

  if (cellPx >= 10) {
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
  if (baseOn()) {
    drawBaseTiles(W, H, useArt);
    if (useArt) drawLiveItems(W, H);
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

  if (useArt) drawPlacedTiles(false);
  blocks.forEach((kind, k) => {
    const [cx, cy] = unkey(k);
    if (useArt) {
      const art = isGround(kind) ? groundTile(cx, cy, kind === 'dark') : colouredTile(kind, cx, cy);
      if (art && drawGroundArt(cx, cy, art)) return;
    }
    const r = cellRect(cx, cy);
    ctx.fillStyle = COLORS[kind];
    ctx.fillRect(r.x, r.y, r.w + pad, r.h + pad);
  });
  spikes.forEach((sp, k) => {
    const [cx, cy] = unkey(k);
    const q = spikeTurn(sp, cx, cy);
    if (useArt && base) { const t = spikeTile(sp.c, q); if (drawTileArt(cx, cy, t.tile, t.matrix)) return; }
    drawSpike(cx, cy, q, COLORS[sp.c]);
  });

  const near = (cx, cy) => cx >= minCx - 6 && cx <= maxCx + 6 && cy >= minCy - 6 && cy <= maxCy + 6;
  vines.forEach((v, k) => { const [cx, cy] = unkey(k); if (near(cx, cy)) drawVine(cx, cy, v.s, rotMatrix(v.q)); });
  mossCells.forEach((_, k) => { if (!useArt || !drawMoss(k)) { const c = mossCenter(k), g = layerGrid('moss'), a = toScreen(c.x - g.size / 2, c.y + g.size / 2); ctx.fillStyle = COLORS.moss; ctx.fillRect(a.x, a.y, g.size * cam.scale, g.size * cam.scale); } });
  if (useArt) drawPlacedTiles(true);
  for (const o of placed) drawPlacedObject(o);
  drawSelection();
  if (draft.hitboxes) drawHitboxes(minCx, maxCx, minCy, maxCy);

  if (baseOn()) for (const o of baseObjects) {
    const c = toScreen(o.x, o.y);
    if (removedObjects.has(o.id)) {
      const w = o.w * cam.scale / 2, h = o.h * cam.scale / 2;
      ctx.save(); ctx.strokeStyle = COLORS.end; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(c.x - w, c.y - h); ctx.lineTo(c.x + w, c.y + h); ctx.moveTo(c.x + w, c.y - h); ctx.lineTo(c.x - w, c.y + h);
      ctx.stroke(); ctx.restore();
      continue;
    }
    if (useArt && sceneReady() && o.kind === 'upgrade') continue;
    if (o.kind === 'trigger' && cam.scale < 0.15) continue;
    if (cam.scale < 0.1) {
      ctx.fillStyle = COLORS.upgrade;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    const w = Math.max(4, o.w * cam.scale), h = Math.max(4, o.h * cam.scale);
    if (c.x + w < 0 || c.x - w > W || c.y + h < 0 || c.y - h > H) continue;
    const color = o.kind === 'upgrade' ? COLORS.upgrade : COLORS.trigger;
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
  if (baseOn() && base.scene && cam.scale >= 0.15) drawMarkers();
  drawCourses();

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
    else if (SPIKE_KIND[tool]) drawSpike(cx, cy, autoSpikeTurn(cx, cy), COLORS[SPIKE_KIND[tool]]);
    else if (tool === 'vine' && base) drawVine(cx, cy, draft.vineSprite, rotMatrix(placeRot));
    else if (tool === 'moss' && base) { const w = cellWorld(cx, cy), c = mossCenter(mossKeyAt(w.x + CELL / 2, w.y + CELL / 2)), g = layerGrid('moss'), a = toScreen(c.x - g.size / 2, c.y + g.size / 2); ctx.fillStyle = COLORS.moss; ctx.fillRect(a.x, a.y, g.size * cam.scale, g.size * cam.scale); }
    else if (tool === 'tile' && base && draft.pick.tile) { const w = cellWorld(cx, cy); const tk = tileKeyAt(draft.pick.tileLayer, w.x + CELL / 2, w.y + CELL / 2); ctx.globalAlpha = 1; drawPlacedTile({ layer: draft.pick.tileLayer, tile: draft.pick.tile, q: 0 }, tk, 0.6); }
    else if ((tool === 'object' || tool === 'decor') && base) { const w = cellWorld(cx, cy); const cat = tool === 'object' ? 'objects' : 'decor'; ctx.globalAlpha = 1; (() => { const i = tool === 'object' ? draft.pick.obj ?? 0 : draft.pick.decorObj ?? 0; drawPlacedObject({ cat, i, ...placementFor(catalogItem({ cat, i }), cx, cy) }, 0.6); })(); }
    else if (tool === 'stamp' && base?.art?.stamps?.[draft.pick.stamp]) { const w = cellWorld(cx, cy); ctx.globalAlpha = 1; for (const [tk, t] of stampTiles(base.art.stamps[draft.pick.stamp], w.x + CELL / 2, w.y + CELL / 2, placeRot, placeFlip)) drawPlacedTile(t, tk, 0.6); }
    else if (tool === 'arrow' && base) { ctx.globalAlpha = 1; drawArrowNodes(cx, cy); }
    else if (tool === 'paste' && brush) { ctx.globalAlpha = 1; drawBrush(cx, cy); }
    else if (tool === 'select' || tool === 'pick') { }
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
    drawGate({ x: cp.at[0], y: cp.at[1] }, cp.box, COLORS.checkpoint, cp.course ? 'COURSE CHECKPOINT' : 'CHECKPOINT');
  }
  for (const r of sc.respawns || []) drawGate({ x: r.at[0], y: r.at[1] }, SPAWN_BOX, COLORS.respawn, 'C' + r.course + ' RESPAWN');
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = COLORS.spawn;
  ctx.lineWidth = 2;
  for (const tp of sc.teleporters || []) {
    if (!inState(tp)) continue;
    for (const side of ['up', 'down']) {
      const a = tp[side];
      if (!a) continue;
      const c = toScreen(a.arrow[0], a.arrow[1]);
      const hot = hoverArrow === a;
      ctx.globalAlpha = hot ? 1 : 0.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(6, TP_RADIUS * cam.scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

const TP_RADIUS = 22;
let hoverArrow = null;
function teleportArrowAt(wx, wy) {
  if (!baseOn() || !base.scene) return null;
  const r = Math.max(TP_RADIUS, 6 / cam.scale);
  for (const tp of base.scene.teleporters || []) {
    if (tp.state !== 'always' && tp.state !== draft.baseState) continue;
    for (const side of ['up', 'down']) {
      const a = tp[side];
      if (a && Math.hypot(wx - a.arrow[0], wy - a.arrow[1]) <= r) return a;
    }
  }
  return null;
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

const BLOCK_KIND = { block: 'ground', dark: 'dark', blue: 'blue', orange: 'orange' };
const SPIKE_KIND = { spike: 'spike', blueSpike: 'blue', orangeSpike: 'orange' };

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

const COURSE_COLORS = ['#41f88d', '#4fc3ff', '#ffb347', '#ff6fd8', '#c792ea', '#f5e663', '#7ee0c3', '#ff8a80'];
const courses = () => (draft.courses ||= []);
const courseById = (id) => courses().find((c) => c.id === id);
const courseNumber = (id) => courses().findIndex((c) => c.id === id) + 1;
const courseColor = (id) => COURSE_COLORS[Math.max(0, courseNumber(id) - 1) % COURSE_COLORS.length];
const completeCourses = () => courses().filter((c) => c.start && c.end);
const LINKABLE = (item) => !!(item?.upgradeBox || item?.name === 'Course checkpoint');
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
  for (const o of placed) if (o.course && !courseById(o.course)) delete o.course;
  if (!courseById(draft.activeCourse)) draft.activeCourse = courses().at(-1)?.id || null;
}
function courseJson(c, ox = 0, oy = 0) {
  const r = Math.round;
  return { id: c.id, startX: r(c.start.x - ox), startY: r(c.start.y - oy), endX: r(c.end.x - ox), endY: r(c.end.y - oy), reward: c.reward || { currency: 'Cash', amount: 0 } };
}
function clearMarker(m) {
  if (m.which === 'spawn') { draft.spawn = null; return; }
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
    const c = o.course && courseById(o.course), g = c && (c.start || c.end);
    if (!g) continue;
    const a = toScreen(o.x, o.y), b = centre(g, c.start ? START_BOX : END_BOX);
    ctx.strokeStyle = courseColor(c.id); ctx.globalAlpha = 0.4; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
  if (draft.spawn) drawGate(draft.spawn, SPAWN_BOX, COLORS.spawn, 'SPAWN');
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

function markerAt(wx, wy) {
  const hit = (g, b) => g && Math.abs(wx - (g.x + b.dx)) <= Math.max(b.w / 2, CELL / 2) && Math.abs(wy - (g.y + b.dy)) <= Math.max(b.h / 2, CELL / 2);
  if (hit(draft.spawn, SPAWN_BOX)) return { which: 'spawn' };
  for (const c of courses()) {
    if (hit(c.start, START_BOX)) return { which: 'start', course: c.id };
    if (hit(c.end, END_BOX)) return { which: 'end', course: c.id };
  }
  return null;
}

function applyTool(cx, cy) {
  const k = key(cx, cy);
  if (BLOCK_KIND[tool]) {
    if (blocks.get(k) === BLOCK_KIND[tool]) return false;
    spikes.delete(k);
    blocks.set(k, BLOCK_KIND[tool]);
  } else if (SPIKE_KIND[tool]) {
    if (spikes.get(k)?.c === SPIKE_KIND[tool]) return false;
    blocks.delete(k);
    spikes.set(k, { c: SPIKE_KIND[tool] });
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
    placed.push({ cat, i, n: item.name, ...placementFor(item, cx, cy), ...(item.upgradeBox ? { uid: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) } : {}), ...(item.name === 'Course checkpoint' && courseById(draft.activeCourse) ? { course: draft.activeCourse } : {}) });
    if (drag) { drag.placedObject = true; if (item.zip) drag.zipPlace = placed.length - 1; }
  } else if (tool === 'stamp') {
    if (drag?.placedObject || !base?.art?.stamps?.[draft.pick.stamp]) return false;
    const w = cellWorld(cx, cy);
    for (const [tk, t] of stampTiles(base.art.stamps[draft.pick.stamp], w.x + CELL / 2, w.y + CELL / 2, placeRot, placeFlip)) tiles.set(tk, t);
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
      const sp = baseOn() && sceneSpriteAt(w.x + CELL / 2, w.y + CELL / 2);
      if (!sp) return false;
      removedScene.add(sp.id);
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
  if (!drag.changed) {
    drag.changed = true;
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
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
  const gone = removed.size + removedVines.size + removedObjects.size + removedScene.size;
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
  const empty = !blocks.size && !spikes.size && !vines.size && !courses().length && !draft.spawn && !baseOn();
  root.querySelector('#mm-empty').hidden = !empty;
}

function syncBaseUi() {
  const on = baseOn();
  const btn = root.querySelector('#mm-base');
  btn.textContent = on ? 'Remove base map' : 'Import base map';
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
    btn.textContent = 'Loading…';
    try {
      await loadBase(true);
    } catch (e) {
      flash("Couldn't load the base game map: " + e, true);
      return;
    } finally {
      btn.disabled = false;
    }
    draft.useBase = true;
    fillJumpList();
    if (!blocks.size && !spikes.size && !courses().length && base.courses[0]) jumpTo(base.courses[0].start.x, base.courses[0].start.y);
  }
  saveDraft();
  syncBaseUi();
  requestDraw();
}

function setBaseState(state) {
  if (draft.baseState === state) return;
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
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.hidden = true; }, 3500);
}

function exportZip() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
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

async function testInGame() {
  let map;
  try { map = buildMap(); } catch (e) { flash(e.message, true); return; }
  const btn = root.querySelector('#mm-test');
  btn.disabled = true;
  btn.textContent = 'Launching…';
  try {
    await window.__TAURI__.core.invoke('test_launch_map', { mapJson: JSON.stringify(map, null, 2) });
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
  arrows = [];
  removed.clear();
  removedVines.clear();
  removedObjects.clear();
  removedScene.clear();
  selection = null;
  renderConfig();
  draft.courses = [];
  draft.spawn = null;
  saveDraft();
  requestDraw();
}

function jumpTo(x, y) {
  cam.x = x;
  cam.y = y;
  cam.scale = Math.max(cam.scale, 0.5);
  requestDraw();
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
    if (e.altKey) { pickAt(wp.x, wp.y); return; }
    if (tool === 'select') { selectDown(e); return; }
    const arrow = teleportArrowAt(wp.x, wp.y);
    if (arrow) { jumpTo(arrow.to[0], arrow.to[1]); flash('Teleported'); return; }
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
    if (drag && (drag.region || drag.move || drag.zip || drag.gate)) { selectMove(e); return; }
    if (drag?.zipPlace != null) { zipPlaceMove(e); return; }
    if (e.target !== canvas && !drag) {
      if (hover) { hover = null; updateStatus(); requestDraw(); }
      return;
    }
    if (!drag) {
      const rect = canvas.getBoundingClientRect();
      const wp = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      const arrow = teleportArrowAt(wp.x, wp.y);
      if (arrow !== hoverArrow) { hoverArrow = arrow; canvas.style.cursor = arrow ? 'pointer' : ''; requestDraw(); }
    }
    const c = eventCell(e);
    if (hover && hover.cx === c.cx && hover.cy === c.cy) return;
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
  const before = toWorld(sx, sy);
  cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * Math.exp(-e.deltaY * 0.0015)));
  const after = toWorld(sx, sy);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
  requestDraw();
}

function onKeyDown(e) {
  if (!mounted || !canvas.isConnected || canvas.offsetParent === null) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); if (brush) setTool('paste'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Escape') { if (popCat) closePopover(); else { selection = null; renderConfig(); if (tool === 'paste') setTool('select'); requestDraw(); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selection) { e.preventDefault(); deleteSelection(); } return; }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!nudgeSelection(d[0], d[1], e.shiftKey)) { cam.x += (d[0] * 96) / cam.scale; cam.y += (d[1] * 96) / cam.scale; requestDraw(); }
    return;
  }
  if (!e.shiftKey && k === 'h') { toggleHitboxes(); return; }
  if (k === 'e') { setTool('erase'); return; }
  if (k === 'a') { const i = categoryItems('decor').findIndex((it) => it.tool === 'arrow'); if (i >= 0) { selectItem('decor', i); updatePopover(); } return; }
  if (k === 'q') { setTool('select'); return; }
  if (k === 'v') { if (brush) setTool('paste'); else flash('Copy a region first: Select (Q), drag, Ctrl+C.', true); return; }
  if (k === 'i') { if (hover) { const w = cellWorld(hover.cx, hover.cy); pickAt(w.x + CELL / 2, w.y + CELL / 2); } return; }
  if (k === 'r') { turnSomething(e.shiftKey ? -1 : 1); return; }
  if (k === 'f') { turnSomething(0, true); return; }
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
      <div class="mm-cats">
        ${CATEGORIES.map((c) => `<button class="mm-cat" data-cat="${c.id}" title="${c.label} - ${c.key.toUpperCase()} to pick, again to step through (Shift back), [ ] step, 1-9 pick"><span class="mm-cat-thumb"></span><span class="mm-cat-text"><span class="mm-cat-label">${c.label}</span><span class="mm-cat-item"></span></span><kbd>${c.key.toUpperCase()}</kbd><span class="mm-caret">▾</span></button>`).join('')}
        <button class="mm-cat" data-tool="select" title="Select: click something to configure or move it, drag a region to copy (Ctrl+C) or delete it (Q)"><span class="mm-cat-text"><span class="mm-cat-label">Select</span></span><kbd>Q</kbd></button>
        <button class="mm-cat mm-erase" data-tool="erase" title="Erase your edits and base-game tiles and objects (E)"><span class="mm-cat-text"><span class="mm-cat-label">Erase</span></span><kbd>E</kbd></button>
      </div>
      <div class="mm-pop" id="mm-pop" hidden></div>
      <div class="mm-bar-right">
        <div class="mm-tools" id="mm-state" hidden>
          <button class="mm-tool" data-state="start" title="Area 1 as it is at the start of the game">Start of game</button>
          <button class="mm-tool" data-state="overgrown" title="Area 1 after the breaker is tripped">Overgrown</button>
        </div>
        <select class="mm-input mm-jump" id="mm-jump" hidden><option value="">Jump to course…</option></select>
        <button class="mm-tool" id="mm-base" title="Show the real Overworld under your map; the area around your edits is exported with it"></button>
        <button class="mm-tool" id="mm-player-btn" title="What the player starts the level with: dashes, double jumps, abilities, unlocks and cash">Level settings</button>
        <span class="mm-sep"></span>
        <button class="mm-tool" id="mm-undo" title="Undo (Ctrl+Z)">Undo</button>
        <button class="mm-tool" id="mm-clear" title="Clear the whole draft">Clear</button>
      </div>
    </div>
    <div class="mm-canvas-wrap">
      <canvas id="mm-canvas"></canvas>
      <div class="mm-empty" id="mm-empty" hidden>
        <div>Paint blocks and spikes, then set a spawn - gates are optional.</div>
        <div class="mm-empty-sub">Want to build on the real level? Use <b>Import base map</b>.</div>
      </div>
      <div class="mm-views">
        <button class="mm-tool mm-view" id="mm-hitbox" title="Show collision: solid blocks green, deadly shapes red (H)">View hitboxes</button>
      </div>
      <div class="mm-config" id="mm-config" hidden></div>
      <div class="mm-config mm-player" id="mm-player" hidden></div>
      <div class="mm-hint">Left-click paint · Right-drag / Space-drag pan · Wheel zoom</div>
      <div class="mm-flash" id="mm-flash" hidden></div>
    </div>
    <div class="mm-status" id="mm-status"></div>
    <div class="mm-bar mm-footer">
      <input class="mm-input mm-name" id="mm-name" type="text" placeholder="Map name" />
      <input class="mm-input mm-desc" id="mm-desc" type="text" placeholder="Description (optional)" />
      <div class="mm-bar-right">
        <button class="mm-tool" id="mm-open" title="Open a map exported from this editor (.zip or map.json) to keep editing it">Open…</button>
        <input type="file" id="mm-open-file" accept=".zip,.json,application/json,application/zip" hidden>
        <button class="mm-tool" id="mm-test" title="Install this map and launch the game straight into it">Test in game</button>
        <button class="mm-tool" id="mm-copy" title="Copy map.json to the clipboard">Copy JSON</button>
        <button class="mm-tool mm-primary" id="mm-export">Export .zip</button>
      </div>
    </div>`;

  canvas = root.querySelector('#mm-canvas');
  ctx = canvas.getContext('2d');
  root.querySelector('[data-tool="erase"]').addEventListener('click', () => { closePopover(); setTool('erase'); });
  root.querySelector('[data-tool="select"]').addEventListener('click', () => { closePopover(); setTool('select'); });
  root.querySelector('#mm-player-btn').addEventListener('click', () => {
    const el = root.querySelector('#mm-player'), btn = root.querySelector('#mm-player-btn');
    el.hidden = !el.hidden;
    btn.classList.toggle('active', !el.hidden);
    renderPlayerPanel();
  });
  root.querySelector('#mm-open').addEventListener('click', () => root.querySelector('#mm-open-file').click());
  root.querySelector('#mm-open-file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadMapFile(f); });
  root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    if (draft.cat !== b.dataset.cat || tool === 'erase') selectItem(b.dataset.cat, currentIndex(b.dataset.cat));
    openPopover(b.dataset.cat, b);
  }));
  root.addEventListener('mousedown', (e) => { if (popCat && !e.target.closest('#mm-pop, [data-cat]')) closePopover(); });
  root.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => setBaseState(b.dataset.state)));

  loadDraft();
  if (!draft.useBase) loadBase().then(() => { fillJumpList(); requestDraw(); }).catch(() => {});
  if (draft.useBase) {
    try { await loadBase(true); } catch { draft.useBase = false; }
  }
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
  root.querySelector('#mm-clear').addEventListener('click', clearAll);
  root.querySelector('#mm-test').addEventListener('click', testInGame);
  root.querySelector('#mm-copy').addEventListener('click', copyJson);
  root.querySelector('#mm-export').addEventListener('click', exportZip);

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

