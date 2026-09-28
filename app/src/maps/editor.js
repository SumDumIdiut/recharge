// Navigator map maker: paints blocks and spikes, optionally over the base
// game's real geometry (basemap.json, packed from the extracted Overworld, only
// loaded once the author imports it), and exports a Navigator map.json zipped
// the same way the Recharge Library serves maps (map.json at the archive root).

const DRAFT_KEY = 'rechargeMapMakerDraft';
// Trigger boxes of the real gates (from the Overworld scene): a start gate is
// a tall 60x250 box centred on its transform, standing on the ground; a
// course's finish ("RealEnd") is a thin pad a little below its transform.
const START_BOX = { dx: 0, dy: 0, w: 60, h: 250 };
const END_BOX = { dx: 0, dy: -26, w: 240, h: 13 };
const START_LIFT = 125; // start gate centre above the floor of the clicked cell
// Where the player appears: a player-sized marker standing on the clicked floor.
const SPAWN_BOX = { dx: 0, dy: 0, w: 32, h: 64 };
const SPAWN_LIFT = 40;
const END_LIFT = 32; // finish pad transform above the floor of the clicked cell
const CELL = 32;
const OFFSET_Y = 9; // the base game's tilemap grid sits 9 units above y=0; kept so imports line up
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
let groundSet = null; // "cx,cy" -> true, for solidity checks and export
let mossSet = null;
let blueSet = null;
let orangeSet = null;
// Base deadly tiles by anchor cell: { d: def index, m: matrix index, q: quarter
// turns a spike points, kind: 'spike' | 'block' | 'vine', c: spike colour }.
let baseHaz = null;

let canvas, ctx, root;
let cam = { x: 0, y: 0, scale: 0.75 };
let tool = 'block';
let hover = null;
let drag = null;
let spaceDown = false;
let undoStack = [];
let draft = emptyDraft();
let mounted = false;
let frameQueued = false;

function emptyDraft() {
  return { name: '', description: '', pad: 12, useBase: false, baseState: 'start', blocks: {}, spikes: {}, vines: {}, tiles: {}, placed: [], removed: [], removedVines: [], removedObjects: [], vineSprite: 'smallArc', start: null, end: null, spawn: null, cat: 'blocks', pick: {} };
}

// Draft stores arrays/objects for JSON; these live views are rebuilt from it.
let blocks = new Map(); // "cx,cy" -> 'ground' | 'dark' | 'blue' | 'orange'
let spikes = new Map(); // "cx,cy" -> { q, c: 'spike' | 'blue' | 'orange' }
let vines = new Map(); // anchor "cx,cy" -> { s: sprite name, q: quarter turns }
let tiles = new Map(); // "layer|gx,gy" (that layer's own grid) -> { layer, tile, q }
let placed = []; // objects / decor: { cat: 'objects' | 'decor', i, x, y }
let removed = new Set(); // base cells cleared by Erase
let removedVines = new Set(); // anchors of base vines cleared by Erase
let removedObjects = new Set(); // ids of base upgrade boxes / triggers cleared by Erase
let baseObjects = []; // upgrade boxes and cutscene triggers in the current state

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
  // Older drafts stored plain ground cells as an array.
  blocks = new Map(Array.isArray(draft.blocks) ? draft.blocks.map((k) => [k, 'ground']) : Object.entries(draft.blocks));
  // Older drafts stored bare quarter turns for plain spikes.
  spikes = new Map(Object.entries(draft.spikes).map(([k, v]) => [k, typeof v === 'number' ? { q: v, c: 'spike' } : v]));
  vines = new Map(Object.entries(draft.vines));
  tiles = new Map(Object.entries(draft.tiles || {}));
  placed = [...(draft.placed || [])];
  for (const [k, v] of spikes) if (v.c === 'vine') { spikes.delete(k); vines.set(k, { s: 'smallArc', q: v.q }); }
  removedVines = new Set(draft.removedVines);
  removedObjects = new Set(draft.removedObjects);
  removed = new Set(draft.removed);
}

function saveDraft() {
  draft.blocks = Object.fromEntries(blocks);
  draft.spikes = Object.fromEntries(spikes);
  draft.vines = Object.fromEntries(vines);
  draft.tiles = Object.fromEntries(tiles);
  draft.placed = placed;
  draft.removedVines = [...removedVines];
  draft.removedObjects = [...removedObjects];
  // Erased base vines and tiles are part of the cached tiles: redraw them.
  const vineSig = [...removedVines].sort().join(';') + '|' + [...removed].sort().join(';');
  if (vineSig !== lastVineSig) { lastVineSig = vineSig; baseVersion++; artCache.clear(); }
  draft.removed = [...removed];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
  updateStatus();
}

function snapshot() {
  return JSON.stringify({ blocks: [...blocks], spikes: [...spikes], vines: [...vines], tiles: [...tiles], placed, removed: [...removed], removedVines: [...removedVines], removedObjects: [...removedObjects], start: draft.start, end: draft.end, spawn: draft.spawn });
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
  placed = o.placed || [];
  removedVines = new Set(o.removedVines);
  removedObjects = new Set(o.removedObjects);
  removed = new Set(o.removed);
  draft.start = o.start;
  draft.end = o.end;
  draft.spawn = o.spawn;
  saveDraft();
  requestDraw();
}

async function loadBase() {
  if (base) return;
  const res = await fetch('/maps/basemap.json');
  base = await res.json();
  applyBaseState();
  startTileWorkers();
}

// The base map is the always-present layers plus whichever area-1 state is
// picked: the start of the game, or overgrown once the breaker is tripped.
let layer = null; // run arrays to draw for the current state
function applyBaseState() {
  if (!base) return;
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

// A quarter turn counter-clockwise, as a 2x2 tile matrix [m00, m01, m10, m11].
function rotMatrix(k) {
  const a = (((k % 4) + 4) % 4) * Math.PI / 2;
  const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [c, -s, s, c];
}

// Real tile to paint for an author-placed spike or vine: the base game's own
// tile of that colour / sprite, turned from its authored facing to ours.
// How often the level uses each tile def - several spike tiles face the same
// way (edge / corner variants with different shading), and the common one is
// the plain spike.
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
  // The game has separately drawn tiles for each direction, so use the most
  // common one already facing q; only rotate when there isn't one.
  const layer = SPIKE_LAYER[c];
  const uses = defUses();
  const spikes = base.defs.map((d, i) => [d, uses.get(i) || 0]).filter(([d]) => d.layer === layer && d.kind === 'spike');
  const best = (want) => spikes.filter(([d]) => d.base === want).sort((a, b) => b[1] - a[1])[0]?.[0];
  // Left spikes are the right-facing tile turned round: the game's own left
  // tile is shaded differently from the other three directions.
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

// ---- palette: everything placeable, by category ------------------------------
// Blocks, hazards (spikes and vines), any tile of any of the level's tilemaps,
// gameplay objects and decoration (both cloned from the real scene object by
// Navigator), and gates. Each category has a key: pressing it picks the
// category, pressing it again steps through its items (Shift steps back);
// [ and ] step too, 1-9 pick directly.

const CATEGORIES = [
  { id: 'blocks', label: 'Blocks', key: 'b' },
  { id: 'hazards', label: 'Hazards', key: 's' },
  { id: 'tiles', label: 'Tiles', key: 't' },
  { id: 'objects', label: 'Objects', key: 'o' },
  { id: 'decor', label: 'Decor', key: 'd' },
  { id: 'gates', label: 'Gates', key: 'g' },
];
const LAYER_LABELS = { 'new awesome nikki ground': 'Ground' };
const layerLabel = (name) => LAYER_LABELS[name] || prettySprite(name.replace(/_/g, ' '));
const tilemapName = (layer) => (layer === 'new awesome nikki ground' ? 'ground' : layer);
const catalogItem = (o) => base?.catalog?.[o.cat]?.[o.i];

// A tile layer's own grid (moss is 64 units, offset) - placed tiles snap to it.
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

// The tile a coloured block is drawn with: its layer's most used tile.
function colouredTile(kind) {
  colouredTile.cache ||= {};
  if (!(kind in colouredTile.cache)) {
    const layer = base?.art?.layers.find((l) => l.name === (kind === 'blue' ? 'blueBlocks' : 'orangeBlocks'));
    const counts = new Map();
    for (let i = 0; layer && i < layer.runs.length; i += 5) counts.set(layer.runs[i + 3], (counts.get(layer.runs[i + 3]) || 0) + layer.runs[i + 2]);
    const sprite = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const name = Object.keys(base?.art?.tiles || {}).find((n) => base.art.tiles[n] === sprite);
    colouredTile.cache[kind] = name ? { tile: name, matrix: [1, 0, 0, 1] } : null;
  }
  return colouredTile.cache[kind];
}

function categoryItems(cat) {
  if (!base) return cat === 'gates' ? gateItems() : cat === 'blocks' ? blockItems() : [];
  switch (cat) {
    case 'blocks': return blockItems();
    case 'hazards': return [
      { tool: 'spike', label: 'Spike', thumb: { art: spikeTile('spike', 0).tile } },
      { tool: 'blueSpike', label: 'Blue spike', thumb: { art: spikeTile('blue', 0).tile } },
      { tool: 'orangeSpike', label: 'Orange spike', thumb: { art: spikeTile('orange', 0).tile } },
      ...vineSprites().map((v) => ({ tool: 'vine', vine: v, label: 'Vine: ' + prettySprite(v), thumb: { img: '/maps/vines/' + encodeURIComponent(v) + '.png' } })),
    ];
    case 'tiles': {
      const layer = pickedLayer();
      return (base.art.palette?.[layer] || []).map((t) => ({ tool: 'tile', layer, tile: t, label: t, thumb: { art: t } }));
    }
    case 'objects':
    case 'decor':
      return (base.catalog?.[cat] || []).map((o, i) => ({ tool: cat === 'objects' ? 'object' : 'decor', i, label: o.name, thumb: { scene: mainSprite(o) } }));
    default: return gateItems();
  }
}
function blockItems() {
  return [
    { tool: 'block', label: 'Ground', thumb: { art: 'ground1_tileset_64' } },
    { tool: 'dark', label: 'Dark ground', thumb: { art: 'dark_ground_tileset_64' } },
    { tool: 'blue', label: 'Blue block', thumb: { art: base && colouredTile('blue')?.tile, color: COLORS.blue } },
    { tool: 'orange', label: 'Orange block', thumb: { art: base && colouredTile('orange')?.tile, color: COLORS.orange } },
  ];
}
function gateItems() {
  return [
    { tool: 'start', label: 'Start gate', thumb: { color: COLORS.start } },
    { tool: 'end', label: 'End gate', thumb: { color: COLORS.end } },
    { tool: 'spawn', label: 'Spawn', thumb: { color: COLORS.spawn } },
  ];
}
function pickedLayer() {
  const layers = Object.keys(base?.art?.palette || {});
  return layers.includes(draft.pick.tileLayer) ? draft.pick.tileLayer : layers.includes('Environmental objects') ? 'Environmental objects' : layers[0];
}
// An object's biggest sprite, for its thumbnail.
function mainSprite(o) {
  let best = null, area = -1;
  for (const p of o.parts) { const [, , w, h] = base.scene.sprites[p.s]; if (w * h > area) { area = w * h; best = p.s; } }
  return best;
}

function currentIndex(cat) {
  const items = categoryItems(cat);
  if (cat === 'tiles') return Math.max(0, items.findIndex((it) => it.tile === draft.pick.tile));
  return Math.min(items.length - 1, Math.max(0, draft.pick[cat] ?? 0));
}

function selectItem(cat, index) {
  const items = categoryItems(cat);
  if (!items.length) { flash('Import the base map first - this category uses its sprites.', true); return; }
  index = ((index % items.length) + items.length) % items.length;
  const it = items[index];
  draft.cat = cat;
  if (cat === 'tiles') { draft.pick.tile = it.tile; draft.pick.tileLayer = it.layer; }
  else draft.pick[cat] = index;
  if (it.vine) draft.vineSprite = it.vine;
  setTool(it.tool);
  saveDraft();
}

// The item a tool paints with right now.
function currentItem() {
  if (tool === 'erase') return null;
  const items = categoryItems(draft.cat);
  return items[currentIndex(draft.cat)] || null;
}

function stepItem(dir) {
  if (tool === 'erase') return selectItem(draft.cat, currentIndex(draft.cat));
  selectItem(draft.cat, currentIndex(draft.cat) + dir);
}

// Thumbnails straight from the atlases, scaled with CSS.
function thumbHtml(th, size = 32) {
  const sheet = (atlas, img, rect) => {
    if (!img?.naturalWidth || !rect) return null;
    const [x, y, w, h] = rect, k = size / Math.max(w, h, 1);
    return `<span class="mm-thumb-img" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px;background-image:url('/maps/${atlas}');background-size:${img.naturalWidth * k}px ${img.naturalHeight * k}px;background-position:${-x * k}px ${-y * k}px"></span>`;
  };
  let inner = null;
  if (th.art && base?.art?.tiles[th.art] !== undefined) inner = sheet(base.art.atlas, atlasImg, base.art.sprites[base.art.tiles[th.art]]);
  else if (th.scene != null && base?.scene) inner = sheet(base.scene.atlas, sceneImg, base.scene.sprites[th.scene]);
  else if (th.img) inner = `<img src="${th.img}" alt="" style="max-width:${size}px;max-height:${size}px">`;
  if (!inner) inner = `<span class="mm-thumb-swatch" style="background:${th.color || '#666'}"></span>`;
  return `<span class="mm-thumb" style="width:${size}px;height:${size}px">${inner}</span>`;
}

function updateCategoryButtons() {
  if (!root) return;
  root.querySelectorAll('[data-cat]').forEach((b) => {
    const cat = b.dataset.cat;
    const active = tool !== 'erase' && draft.cat === cat;
    b.classList.toggle('active', active);
    const items = categoryItems(cat);
    const it = items[currentIndex(cat)];
    b.querySelector('.mm-cat-item').textContent = it ? it.label : '';
    b.querySelector('.mm-cat-thumb').innerHTML = it ? thumbHtml(it.thumb, 18) : '';
  });
  root.querySelector('[data-tool="erase"]')?.classList.toggle('active', tool === 'erase');
}

// The dropdown: the category's items as a grid, tiles by layer, with search.
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
  const searchable = cat === 'tiles' || cat === 'decor' || cat === 'hazards';
  const layers = Object.keys(base?.art?.palette || {}).sort((a, b) => layerLabel(a).localeCompare(layerLabel(b)));
  const head = [];
  if (cat === 'tiles') head.push(`<select class="mm-input" id="mm-pop-layer">${layers.map((l) => `<option value="${l}"${l === pickedLayer() ? ' selected' : ''}>${layerLabel(l)} (${base.art.palette[l].length})</option>`).join('')}</select>`);
  if (searchable) head.push(`<input class="mm-input" id="mm-pop-search" placeholder="Search…" value="${filter.replace(/"/g, '&quot;')}">`);
  const items = categoryItems(cat).map((it, i) => ({ it, i })).filter(({ it }) => !filter || it.label.toLowerCase().includes(filter.toLowerCase()));
  const LIMIT = 400;
  const cur = currentIndex(cat);
  pop.innerHTML = `<div class="mm-pop-head">${head.join('')}</div><div class="mm-pop-grid">${items.slice(0, LIMIT).map(({ it, i }) =>
    `<button class="mm-item${i === cur && draft.cat === cat && tool !== 'erase' ? ' active' : ''}" data-i="${i}" title="${it.label}">${thumbHtml(it.thumb, 40)}<span class="mm-item-label">${it.label}</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}</button>`).join('')}</div>` +
    (items.length > LIMIT ? `<div class="mm-pop-more">${items.length - LIMIT} more - search to narrow</div>` : '') +
    (!items.length ? `<div class="mm-pop-more">${base ? 'Nothing matches' : 'Import the base map to use these'}</div>` : '');
  pop.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { selectItem(cat, Number(b.dataset.i)); closePopover(); }));
  const layerSel = pop.querySelector('#mm-pop-layer');
  if (layerSel) layerSel.addEventListener('change', () => {
    const first = base.art.palette[layerSel.value][0];
    draft.pick.tileLayer = layerSel.value;
    draft.pick.tile = first;
    selectItem('tiles', 0);
    renderPopover('');
  });
  const search = pop.querySelector('#mm-pop-search');
  if (search) {
    search.addEventListener('input', () => { const v = search.value; renderPopover(v); const s2 = root.querySelector('#mm-pop-search'); s2.focus(); s2.setSelectionRange(v.length, v.length); });
    search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closePopover(); });
  }
}

// Placed tiles and objects on the canvas.
function drawPlacedTile(t, k, alpha = 1) {
  const sprite = base?.art?.tiles[t.tile];
  if (sprite === undefined || !artReady()) return;
  const c = toScreen(tileCenter(t.layer, k).x, tileCenter(t.layer, k).y);
  ctx.save();
  ctx.globalAlpha = alpha;
  blitSprite(ctx, sprite, rotMatrix(t.q || 0), cam.scale, c.x, c.y);
  ctx.restore();
}
function drawPlacedTiles(front) {
  tiles.forEach((t, k) => { if ((layerGrid(t.layer).order >= 5) === front) drawPlacedTile(t, k); });
}
function drawPlacedObject(o, alpha = 1) {
  const item = catalogItem(o);
  if (!item || !sceneReady()) return;
  ctx.save();
  for (const p of [...item.parts].sort((a, b) => a.o - b.o)) {
    blitScene(p.s, p.m, o.x + p.x, o.y + p.y, (p.a ?? 1) * alpha, p.dm, p.sz, p.c);
  }
  ctx.restore();
  if (!item.parts.length) {
    // Invisible objects (checkpoints): their trigger box.
    const b = item.box || [-50, -50, 50, 50];
    const a = toScreen(o.x + b[0], o.y + b[3]), z = toScreen(o.x + b[2], o.y + b[1]);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COLORS.checkpoint;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(a.x, a.y, z.x - a.x, z.y - a.y);
    ctx.fillStyle = COLORS.checkpoint;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(item.name.toUpperCase(), (a.x + z.x) / 2, a.y - 4);
    ctx.restore();
  }
}
// Rough extent of a placed object, for erasing it.
function objectHit(o, wx, wy) {
  const item = catalogItem(o);
  if (!item) return false;
  if (item.box && wx >= o.x + item.box[0] && wx <= o.x + item.box[2] && wy >= o.y + item.box[1] && wy <= o.y + item.box[3]) return true;
  return item.parts.some((p) => {
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

// ---- world queries -------------------------------------------------------

function isSolid(cx, cy) {
  const k = key(cx, cy);
  if (blocks.has(k)) return true;
  return baseOn() && (groundSet.has(k) || mossSet.has(k)) && !removed.has(k);
}

// Offset to a spike's base for each quarter turn (0 up, 1 left, 2 down, 3 right).
const BASE_DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// Directions a spike here could face with a surface behind its base - floors
// and ceilings before walls, so a corner cell joins its row, not the wall.
function seats(cx, cy) {
  return [0, 2, 1, 3].filter((q) => isSolid(cx + BASE_DIR[q][0], cy + BASE_DIR[q][1]));
}

// The direction a neighbouring spike faces, if there is one.
function neighbourTurn(cx, cy) {
  const sp = spikes.get(key(cx, cy));
  if (sp) return sp.q ?? seats(cx, cy)[0] ?? 0;
  const h = baseOn() && baseHaz.get(key(cx, cy));
  return h && h.kind === 'spike' && !removed.has(key(cx, cy)) ? h.q : null;
}

// Seat a spike on a surface, continuing the row it's in when it can: a spike
// under a ledge next to a wall faces down like its neighbours, not sideways.
function autoSpikeTurn(cx, cy) {
  const options = seats(cx, cy);
  if (!options.length) return 0;
  for (const q of options) {
    const along = q % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    if (along.some(([dx, dy]) => neighbourTurn(cx + dx, cy + dy) === q)) return q;
  }
  return options[0];
}

// Real ground art for an author block: the riveted plate set the level
// builds its platforms from (a 3x3 of corners, edges and a plain centre).
// Rows, pillars and lone blocks one cell thick have no tile of their own, so
// they're put together from quarters of those pieces - a lone block is the
// four corners' outer quarters. Navigator builds the same tile in the game.
const PLATE = { TL: 56, T: 57, TR: 58, L: 63, C: 64, R: 65, BL: 70, B: 71, BR: 72 };
// Plain and dark blocks both go on the ground tilemap and join up with each other.
const isGround = (kind) => kind === 'ground' || kind === 'dark';

function groundTile(cx, cy, dark = false) {
  if (!base?.art) return null;
  const solid = (x, y) => { const k = key(x, y); return isGround(blocks.get(k)) || (baseOn() && groundSet.has(k) && !removed.has(k)); };
  const n = solid(cx, cy + 1), e = solid(cx + 1, cy), s = solid(cx, cy - 1), w = solid(cx - 1, cy);
  const family = dark ? 'dark_ground_tileset_' : 'ground1_tileset_';
  const name = (piece) => family + PLATE[piece];
  const id = [1, 0, 0, 1];
  if ((n || s) && (e || w)) {
    const row = !n ? 'T' : !s ? 'B' : '', col = !w ? 'L' : !e ? 'R' : '';
    return { layer: 'ground', tile: name(row + col || 'C'), matrix: id };
  }
  const corner = (v, h, vPiece, hPiece, both) => (!v && !h ? both : !v ? vPiece : !h ? hPiece : 'C');
  const quarters = [
    corner(n, w, 'T', 'L', 'TL'), corner(n, e, 'T', 'R', 'TR'),
    corner(s, w, 'B', 'L', 'BL'), corner(s, e, 'B', 'R', 'BR'),
  ].map(name);
  return {
    layer: 'ground', tile: family + 'q' + quarters.map((q) => q.slice(family.length)).join('_'), matrix: id, quarters,
    spriteFrom: { ref: name('C'), quarters },
  };
}

// An author ground tile: one sprite, or four quarters (top-left, top-right,
// bottom-left, bottom-right) each clipped from its own piece.
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

// Export area in cells: everything the author touched, padded.
function exportArea() {
  const xs = [], ys = [];
  const addKey = (k) => { const [x, y] = unkey(k); xs.push(x); ys.push(y); };
  blocks.forEach((_, k) => addKey(k));
  spikes.forEach((_, k) => addKey(k));
  vines.forEach((_, k) => addKey(k));
  tiles.forEach((t, k) => { const c = tileCenter(t.layer, k); const cc = cellOf(c.x, c.y); xs.push(cc.cx); ys.push(cc.cy); });
  for (const o of placed) { const cc = cellOf(o.x, o.y); xs.push(cc.cx); ys.push(cc.cy); }
  if (baseOn()) removedVines.forEach(addKey);
  if (baseOn()) removed.forEach(addKey);
  for (const g of [draft.start, draft.end, draft.spawn]) {
    if (!g) continue;
    const c = cellOf(g.x, g.y);
    xs.push(c.cx); ys.push(c.cy);
  }
  if (!xs.length) return null;
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// The author's own gates win; otherwise a real course's start/finish pair
// inside the export area is used (the one closest to the area's centre).
function effectiveGates(area = exportArea()) {
  let start = draft.start, end = draft.end;
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

// On top of the imported base map: an overlay - just the author's changes, at
// the world's real coordinates, which Navigator applies to the real level (its
// own art, upgrade boxes and triggers stay as they are).
function buildOverlay() {
  const at = (k) => { const [cx, cy] = unkey(k); const w = cellWorld(cx, cy); return { x: w.x + CELL / 2, y: w.y + CELL / 2 }; };
  const objects = [];
  removed.forEach((k) => objects.push({ type: 'erase', ...at(k) }));
  removedVines.forEach((k) => {
    const h = baseHaz.get(k);
    if (h) objects.push({ type: 'erase', tilemap: base.defs[h.d].layer, ...at(k) });
  });
  for (const o of baseObjects) if (removedObjects.has(o.id)) objects.push({ type: 'hide', path: o.path, srcX: o.x, srcY: o.y });
  blocks.forEach((kind, k) => {
    const [cx, cy] = unkey(k);
    const art = isGround(kind) && groundTile(cx, cy, kind === 'dark');
    if (art) objects.push({ type: 'tile', tilemap: art.layer, tileName: art.tile, ...at(k), matrix: art.matrix, ...(art.spriteFrom ? { spriteFrom: art.spriteFrom } : {}) });
    else objects.push(isGround(kind) ? { type: 'ground', ...at(k) } : { type: 'coloredGround', color: kind, ...at(k) });
  });
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
    objects.push({ type: 'tile', tilemap: tilemapName(t.layer), tileName: t.tile, x: c.x, y: c.y, matrix: rotMatrix(t.q || 0) });
  });
  for (const o of placed) {
    const item = catalogItem(o);
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, x: Math.round(o.x), y: Math.round(o.y) });
  }

  // Only the author's own gates: the real courses keep theirs in the world.
  const hasGates = !!(draft.start && draft.end);
  const spawn = draft.spawn || draft.start || viewSpawn();
  const r = (v) => Math.round(v);
  return {
    formatVersion: 1,
    name: draft.name.trim() || 'Untitled map',
    description: draft.description.trim(),
    images: [],
    customImages: [],
    overlay: true,
    baseState: draft.baseState,
    groups: [{
      startX: r((hasGates ? draft.start : spawn).x), startY: r((hasGates ? draft.start : spawn).y),
      endX: r((hasGates ? draft.end : spawn).x), endY: r((hasGates ? draft.end : spawn).y),
      spawnX: r(spawn.x), spawnY: r(spawn.y),
      gates: hasGates,
      reward: { currency: 'Cash', amount: 0 },
      objects,
    }],
  };
}

function buildMap() {
  if (baseOn()) return buildOverlay();
  const area = exportArea();
  if (!area) throw new Error('Place something first, or import the base map.');
  // Gates are optional: without both, the map is free play (no timing).
  const gates = effectiveGates(area);
  const hasGates = !!(gates.start && gates.end);
  const spawn = draft.spawn || gates.start || viewSpawn();

  const inArea = (cx, cy) => cx >= area.x0 && cx <= area.x1 && cy >= area.y0 && cy <= area.y1;
  // One thing per cell: user edits win over the base game, removals clear it.
  const cells = new Map();
  if (baseOn()) importBaseCells(cells, inArea);
  blocks.forEach((kind, k) => cells.set(k, { t: kind }));
  spikes.forEach((sp, k) => { const [cx, cy] = unkey(k); cells.set(k, { t: 'tile', ...spikeTile(sp.c, spikeTurn(sp, cx, cy)) }); });
  // Vines are big sprites anchored on a cell, so they sit alongside whatever
  // else occupies it rather than replacing it.
  const vineCells = [];
  if (baseOn()) baseHaz.forEach((h, k) => {
    const [cx, cy] = unkey(k);
    if (h.kind === 'vine' && inArea(cx, cy) && !removedVines.has(k) && !vines.has(k)) vineCells.push([k, { layer: base.defs[h.d].layer, tile: base.defs[h.d].tile, matrix: base.mats[h.m] }]);
  });
  vines.forEach((v, k) => vineCells.push([k, vineTile(v.s, v.q)]));

  // Measured from the editor's own (0, 0) cell rather than the map's corner, so
  // a standalone map keeps the positions it was drawn at (Navigator adds its
  // pocket offset on top).
  const origin = cellWorld(0, 0);
  const objects = [];
  const sorted = [...cells].map(([k, v]) => [unkey(k), v]).sort((a, b) => a[0][1] - b[0][1] || a[0][0] - b[0][0]);
  for (const [[cx, cy], v] of sorted) {
    const cellX = cx, cellY = cy;
    const art = isGround(v.t) && groundTile(cx, cy, v.t === 'dark');
    if (art) objects.push({ type: 'tile', tilemap: art.layer, tileName: art.tile, cellX, cellY, matrix: art.matrix, ...(art.spriteFrom ? { spriteFrom: art.spriteFrom } : {}) });
    else if (isGround(v.t)) objects.push({ type: 'ground', cellX, cellY });
    else if (v.t === 'blue' || v.t === 'orange') objects.push({ type: 'coloredGround', color: v.t, cellX, cellY });
    else objects.push({ type: 'tile', tilemap: v.layer, tileName: v.tile, cellX, cellY, matrix: v.matrix });
  }
  // Upgrade boxes and cutscene triggers: Navigator clones the live scene object
  // (found by path, nearest to its original spot) so it behaves as in the game.
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
    objects.push({ type: 'tile', tilemap: tilemapName(t.layer), tileName: t.tile, cellX: cc.cx, cellY: cc.cy, matrix: rotMatrix(t.q || 0) });
  });
  for (const o of placed) {
    const item = catalogItem(o);
    if (item) objects.push({ type: 'clone', path: item.path, srcX: item.x, srcY: item.y, x: Math.round(o.x - origin.x), y: Math.round(o.y - origin.y) });
  }

  return {
    formatVersion: 1,
    name: draft.name.trim() || 'Untitled map',
    description: draft.description.trim(),
    images: [],
    customImages: [],
    groups: [{
      startX: Math.round((hasGates ? gates.start : spawn).x - origin.x), startY: Math.round((hasGates ? gates.start : spawn).y - origin.y),
      endX: Math.round((hasGates ? gates.end : spawn).x - origin.x), endY: Math.round((hasGates ? gates.end : spawn).y - origin.y),
      spawnX: Math.round(spawn.x - origin.x), spawnY: Math.round(spawn.y - origin.y),
      gates: hasGates,
      reward: { currency: 'Cash', amount: 0 },
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

// ---- zip (stored, no compression) ----------------------------------------

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
  local.setUint16(6, 0x0800, true); // UTF-8 names
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

// ---- drawing -------------------------------------------------------------

function toScreen(wx, wy) {
  return { x: (wx - cam.x) * cam.scale + canvas.width / 2, y: canvas.height / 2 - (wy - cam.y) * cam.scale };
}
function toWorld(sx, sy) {
  return { x: (sx - canvas.width / 2) / cam.scale + cam.x, y: (canvas.height / 2 - sy) / cam.scale + cam.y };
}

// The same module also runs in the tile workers (tile-worker.js), which have
// no page: canvases there are OffscreenCanvases and nothing is scheduled.
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
  ctx.rotate(-q * Math.PI / 2); // world CCW is screen CW-inverted
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-r.w / 2, r.h / 2);
  ctx.lineTo(0, -r.h / 2);
  ctx.lineTo(r.w / 2, r.h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// A kill block's real collision rect (x0, y0, x1, y1 around the cell centre),
// turned by its tile matrix - edge strips stay strips instead of full cells.
function drawKillBox(cx, cy, box = [-16, -16, 16, 16], m = [1, 0, 0, 1]) {
  const w = cellWorld(cx, cy);
  const ox = w.x + CELL / 2, oy = w.y + CELL / 2;
  const pts = [[box[0], box[1]], [box[2], box[3]]].map(([x, y]) => [ox + m[0] * x + m[1] * y, oy + m[2] * x + m[3] * y]);
  const a = toScreen(Math.min(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1]));
  const b = toScreen(Math.max(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]));
  ctx.fillStyle = COLORS.kill;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
}

// ---- real tile art (basemap.art + tiles.png) --------------------------------
// The base map is drawn from the game's own tile sprites at every zoom. Each
// layer's tile runs are indexed into 512-unit chunks, and chunks are baked
// into cached canvases at a resolution matched to the zoom.

const ART_CHUNK = 512;
let atlasImg = null;
let artIndex = null; // band -> chunk key -> [[layer, runIndex], ...] in draw order
let spriteOrders = []; // distinct sorting orders of the scene sprites, ascending
const artCache = new Map(); // "lod|state|cx|cy" -> canvas (insertion order = LRU)

function artReady() {
  return !!(base?.art && atlasImg?.complete && atlasImg.naturalWidth);
}

// Fallback order for base maps without renderer sorting: moss, ground, blocks, spikes.
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
  // Tile layers are split into bands between the scene sprites' sorting orders,
  // so a sprite ends up between exactly the tile layers the game sorts it
  // between (e.g. an upgrade box in front of the background walls, behind the ground).
  const sc = base.scene;
  const pick = (byState) => [...(byState?.always || []), ...(byState?.[draft.baseState] || [])];
  spriteOrders = [...new Set([...pick(sc?.placements).map((p) => p.o), ...(sc?.groups || []).map((g) => g.o)])].sort((a, b) => a - b);
  // A tile layer draws after every sprite at or below its order: in the game
  // the tilemap draws over sprites it ties with (the course 2 diagonal
  // platform tucks under the walls it meets).
  const bandOf = (order) => spriteOrders.filter((o) => o <= order).length;
  artIndex = new Map();
  for (const l of layers) {
    const band = bandOf(l.order ?? artRank(l.name));
    if (!artIndex.has(band)) artIndex.set(band, new Map());
    const index = artIndex.get(band);
    for (let i = 0; i < l.runs.length; i += 5) {
      // Every chunk the run's sprites can reach: decoration sprites overhang their cells.
      const [, , sw, sh] = base.art.sprites[l.runs[i + 3]];
      const reach = Math.max(0, Math.max(sw, sh) / 2 - l.size / 2);
      const y0 = l.oy + l.runs[i] * l.size - reach, y1 = y0 + l.size + 2 * reach;
      const x0 = l.ox + l.runs[i + 1] * l.size - reach, x1 = l.ox + (l.runs[i + 1] + l.runs[i + 2]) * l.size + reach;
      const entry = [l, i]; // one object per run, shared by every chunk it reaches
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

// Draws one atlas sprite centred on (x, y) through a tile matrix, where
// toPx maps world -> canvas pixels at 'px' pixels per world unit.
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
  // Runs are indexed into every chunk their sprites reach (see buildArtIndex).
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

// Tilemaps an overlay's "erase" clears in the game (Navigator's OverlayErasable):
// their tiles under an erased cell are left out of the drawing too.
const ERASABLE = new Set(['new awesome nikki ground', 'OvergrowthDestroyedGround', 'moss', 'OvergrowthMoss', 'blueBlocks', 'orangeBlocks',
  'Spikes', 'backgroundSpikes1', 'backgroundSpikes2', 'blueSpikes', 'orangeSpikes']);
function erasedArt(l, col, row) {
  if (!removed.size || !ERASABLE.has(l.name)) return false;
  // A tile can span several editor cells (moss is 64 units); erasing any of them clears it.
  const n = Math.max(1, Math.round(l.size / CELL));
  const c = cellOf(l.ox + col * l.size + CELL / 2, l.oy + row * l.size + CELL / 2);
  for (let dx = 0; dx < n; dx++) for (let dy = 0; dy < n; dy++) if (removed.has(key(c.cx + dx, c.cy + dy))) return true;
  return false;
}

// Returns a baked chunk, or null if the per-frame bake budget is spent.
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

// A band's tiles drawn straight onto the canvas (used for a map tile): only
// the cells inside the view, found through the band's chunk index, each run once.
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
          // ~1 px larger so neighbouring cells overlap: no hairline seams between rows.
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
      // Whole-pixel edges shared with the neighbouring chunks: no seams.
      const a = toScreen(ccx * ART_CHUNK, (ccy + 1) * ART_CHUNK), b = toScreen((ccx + 1) * ART_CHUNK, ccy * ART_CHUNK);
      const x0 = Math.round(a.x), y0 = Math.round(a.y);
      ctx.drawImage(c, x0, y0, Math.round(b.x) - x0, Math.round(b.y) - y0);
    }
  }
  return pending;
}

// The level in the game's sorting order: tile bands, with the scene's sprites
// and tree pieces drawn between them.
function drawLayered(W, H, budget = 10) {
  const lod = Math.min(1, Math.pow(2, Math.ceil(Math.log2(cam.scale)))); // chunk resolution
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
  if (pending) requestDraw(); // finish baking over the next frames
}

// An author tile drawn with its real sprite on the main canvas.
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

// ---- looping parallax backgrounds -------------------------------------------
// backgroundScroller sits at camera * parallaxFactor and tiles its sprite over
// a huge area, so it loops endlessly; which one shows depends on the zone.

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
    const ox = cam.x * b.fx - w / 2, oy = cam.y * b.fy - h / 2; // a tile centred on the scroller
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

// ---- scene: sprites, text and zip paths (basemap.scene + scene.png) ----------

let sceneImg = null;
let sceneList = null; // { back: [...], front: [...], texts: [...], paths: [...] } for the current state
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
    // Animated ones (frames, or a scrolling material) are drawn live over the
    // cached level instead of being baked into it.
    return { ...p, reach, live: !!(p.frames || p.sc) };
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

// Draws a scene sprite in its own pixel space (x right, y down from its
// top-left), mapped through its placement matrix. Sliced / tiled renderers
// fill their set size (sz, pixels) instead of drawing the sprite once.
// A scene sprite multiplied by a SpriteRenderer tint, cut out on its own canvas.
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
    // The material samples uv + time * direction, wrapping: the picture slides
    // the other way and comes back round.
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
    // Tiled. With a 9-slice border (e.g. zip-mover blocks) the corners are
    // drawn once and the edges / centre repeat between them, like Unity does;
    // without one the whole sprite repeats.
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
  // Sliced: corners keep their size, edges and centre stretch.
  const srcX = [sx, sx + bl, sx + w - br, sx + w], srcY = [sy, sy + bt, sy + h - bb, sy + h];
  const dstX = [0, bl, W - br, W], dstY = [0, bt, H - bb, H];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const sW = srcX[i + 1] - srcX[i], sH = srcY[j + 1] - srcY[j], dW = dstX[i + 1] - dstX[i], dH = dstY[j + 1] - dstY[j];
    if (sW > 0 && sH > 0 && dW > 0 && dH > 0) ctx.drawImage(img, srcX[i], srcY[j], sW, sH, dstX[i], dstY[j], dW + 0.3, dH + 0.3);
  }
}

// A tree piece: its tiles rendered once in the piece's own grid (so no seams
// between rotated tiles), then drawn through the piece's world transform.
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
    // local (x right, y up) -> world via [a b; c d] -> screen (y down), from canvas pixels.
    // Canvas pixel (u, v) is local (minX + u/px, maxY - v/px).
    const s = cam.scale / b.px, c = toScreen(g.x, g.y), [a, bb, cc, d] = g.m;
    ctx.setTransform(s * a, -s * cc, -s * bb, s * d,
      c.x + cam.scale * (a * b.minX + bb * b.maxY), c.y - cam.scale * (cc * b.minX + d * b.maxY));
    ctx.drawImage(b.canvas, 0, 0);
  }
}

// Sprites and tree pieces items[from..to), already in sorting order.
function drawSceneItems(W, H, items, from, to) {
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const now = performance.now() / 1000;
  let animated = false;
  ctx.save();
  for (let i = from; i < to; i++) {
    const p = items[i];
    if (p.group) { drawGroups([p], tl, br); continue; }
    if (p.x + p.reach < tl.x || p.x - p.reach > br.x || p.y + p.reach < br.y || p.y - p.reach > tl.y) continue;
    if (p.live && staticRender && cam.scale >= LIVE_MIN_SCALE) continue; // drawn live by drawLiveItems
    let sprite = p.s;
    if (p.frames && !staticRender) { sprite = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length]; animated = true; }
    if (p.sc && !staticRender) animated = true;
    blitScene(sprite, p.m, p.x, p.y, p.a, p.dm, p.sz, p.c, p.sc && !staticRender ? p.sc : null, now);
  }
  ctx.restore();
  // Keep animations running (~15 fps) only while one is on screen.
  if (animated && !animTimer) animTimer = setTimeout(() => { animTimer = 0; requestDraw(); }, 40);
}

// Animated scene sprites, drawn every frame over the cached level. In the
// game solid tiles that sort above a sprite hide it, so each sorting order's
// sprites go on a scratch layer that has those tiles' cells cut out first.
// Zoomed out further than this, animated sprites are too small to see move:
// they're baked into the tiles like everything else instead.
const LIVE_MIN_SCALE = 0.25;

function drawLiveItems(W, H) {
  if (!sceneReady() || !sceneList || cam.scale < LIVE_MIN_SCALE) return;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const visible = sceneList.items.filter((p) => p.live && !(p.x + p.reach < tl.x || p.x - p.reach > br.x || p.y + p.reach < br.y || p.y - p.reach > tl.y));
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
    // Cut out the solid cells drawn over this order (ties included), around these sprites.
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

// Canvas UI, text and zip-mover paths go on top of the level.
function drawSceneOverlays(W, H) {
  if (!sceneReady() || !sceneList) return;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  drawSceneImages(tl, br);
  drawSceneText(tl, br);
  drawZipPaths();
}

// UI images on world-space canvases (course screens and the like), 9-sliced
// where the game slices them so their borders keep their size.
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
    // Nine pieces: source columns/rows from the sprite border (pixels), destination from the world border.
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

// ---- TextMeshPro-style text from the game's own glyph atlases ----------------

const fontImages = [];
function fontImage(i) {
  if (!fontImages[i]) {
    if (IN_WORKER) return { complete: false }; // workers preload every font
    const img = new Image();
    img.onload = () => { textCache.clear(); invalidateBase(); };
    img.src = '/maps/' + base.scene.fonts[i].atlas;
    fontImages[i] = img;
  }
  return fontImages[i];
}

// The glyph for a character: the text's own font, else any font that has it
// (the key/button icons live in PromptFont).
function glyphFor(fontIdx, code) {
  const fonts = base.scene.fonts;
  const own = fonts[fontIdx];
  if (own && own.chars[code]) return [fontIdx, own.chars[code]];
  for (let i = 0; i < fonts.length; i++) if (fonts[i] && fonts[i].chars[code]) return [i, fonts[i].chars[code]];
  return null;
}

// Lays a text out at a font size (TMP points), in world units around the rect
// centre: wraps words to the rect, returns glyph quads and the block size.
function layoutText(t, fontSize) {
  const font = base.scene.fonts[t.f] || base.scene.fonts.find(Boolean);
  const unit = fontSize * t.k / font.point * (font.scale || 1); // world units per atlas pixel
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

// Auto-sized texts shrink to the largest size that fits their rect, like TMP.
function textSize(t) {
  if (!t.auto) return t.size;
  let lo = t.auto[0], hi = Math.min(t.auto[1], 600);
  if (fits(t, hi)) return hi;
  for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fits(t, mid)) lo = mid; else hi = mid; }
  return lo;
}

const textCache = new Map(); // text -> { canvas, x0, top, px }
const sizeCache = new Map(); // text -> its (auto-)fitted font size

// Renders a text once, white glyphs tinted to its colour, into a canvas.
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
  const px = Math.min(3, 1024 / Math.max(maxX - minX, maxY - minY, 1)); // canvas pixels per world unit
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
    if (sizeCache.get(t) * t.k * cam.scale < 2.5) continue; // unreadably small at this zoom
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

// Zip movers (and other moving platforms): their waypoints, joined.
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
    if (IN_WORKER) return { complete: false }; // workers preload the level's vines
    const img = new Image();
    img.onload = invalidateBase;
    img.src = '/maps/vines/' + encodeURIComponent(name) + '.png';
    vineImages[name] = img;
  }
  return vineImages[name];
}

// Draws a vine sprite (1 px = 1 world unit, pivot at its centre) on its anchor
// cell's centre, through its tile matrix [m00, m01, m10, m11] (world is y-up).
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
  if (cam.scale < 0.2) return; // labels only when zoomed in enough to read the level
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, c.x, c.y - h / 2 - 4);
}

// ---- the base map: an incrementally rendered tile cache ------------------------
// The level is cut into 256 px tiles at power-of-two zoom levels. Each tile is
// rendered once with every layer in the game's order and cached; a frame only
// copies the visible tiles, renders a few missing ones (~6 ms, nearest the
// centre first) and stretches a coarser level's tile over any still missing,
// so panning and zooming never stall on a full redraw. The parallax background
// follows the view and is drawn live underneath; edits are drawn live on top.

const TILE_PX = 128; // small, so rendering one tile never takes long
const TILE_BUDGET_MS = 6;
const MAX_TILES = 2000; // 64 KB each: ~128 MB at most
const tileCache = new Map(); // key -> canvas, insertion order = LRU
let baseVersion = 0; // bumped when anything the tiles show changes (state, loaded images, erased vines)
let staticRender = false; // true while rendering a tile (animations hold still)
let lastVineSig = '';

function invalidateBase() { baseVersion++; requestDraw(); }

function lodFor(scale) { return Math.max(-8, Math.min(1, Math.ceil(Math.log2(scale)))); }
function tileKey(z, tx, ty) { return baseVersion + '|' + draft.baseState + '|' + z + '|' + tx + '|' + ty; }

function cachedTile(key) {
  const c = tileCache.get(key);
  if (c) { tileCache.delete(key); tileCache.set(key, c); }
  return c;
}

// Draws the base map for the current canvas / ctx / cam (called per tile).
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
        // Whole-pixel rects so neighbouring rows share an edge (no striping).
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

// Renders the base map centred on world (x, y) at 'scale' into cv (its size).
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

// Rendering on this thread (no tile workers): a zoomed-out tile holds
// thousands of sprites, so it's rendered in pieces - one per step, a few
// milliseconds each - and each frame does as many steps as its budget allows.
const tileJobs = new Map(); // key -> { cv, g, n, next }
let pieceCanvas = null;

function tileJob(key, z) {
  let job = tileJobs.get(key);
  if (!job) {
    const n = z >= -1 ? 1 : z >= -3 ? 2 : 4; // pieces per side
    const cv = makeCanvas();
    cv.width = cv.height = TILE_PX;
    job = { cv, g: cv.getContext('2d'), n, next: 0 };
    tileJobs.set(key, job);
  }
  return job;
}

// Renders the job's next piece; true once the tile is complete.
function stepTileJob(job, z, tx, ty) {
  const s = Math.pow(2, z), T = TILE_PX / s, size = TILE_PX / job.n;
  const px = job.next % job.n, py = Math.floor(job.next / job.n); // py counts down from the top
  if (!pieceCanvas) pieceCanvas = makeCanvas();
  pieceCanvas.width = pieceCanvas.height = size; // also clears it
  renderRegion(pieceCanvas, tx * T + ((px + 0.5) * T) / job.n, (ty + 1) * T - ((py + 0.5) * T) / job.n, s);
  job.g.drawImage(pieceCanvas, px * size, py * size);
  return ++job.next >= job.n * job.n;
}

// A coarser level's cached tile, as [canvas, sx, sy, sw, sh] covering tile (z, tx, ty).
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

// A finer level's cached tiles drawn into tile (z, tx, ty)'s screen rect -
// right after zooming out, before the coarser tiles have arrived.
function drawFromFiner(z, tx, ty, x0, y0, w, h) {
  let any = false;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const c = tileCache.get(tileKey(z + 1, tx * 2 + dx, ty * 2 + dy));
      if (!c) continue;
      // Child row 1 is the upper half (world y up, screen y down).
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
    tileCache.get(oldest)?.close?.(); // ImageBitmaps hold GPU memory until closed
    tileCache.delete(oldest);
  }
}

function drawBaseTiles(W, H, useArt) {
  if (useArt) drawBackground(W, H);
  const z = lodFor(cam.scale), s = Math.pow(2, z), T = TILE_PX / s;
  const tl = toWorld(0, 0), br = toWorld(W, H);
  const tiles = [];
  // The view plus a one-tile margin (fetched last) so panning finds them ready.
  for (let ty = Math.floor(br.y / T) - 1; ty <= Math.floor(tl.y / T) + 1; ty++) {
    for (let tx = Math.floor(tl.x / T) - 1; tx <= Math.floor(br.x / T) + 1; tx++) {
      const visible = ty >= Math.floor(br.y / T) && ty <= Math.floor(tl.y / T) && tx >= Math.floor(tl.x / T) && tx <= Math.floor(br.x / T);
      tiles.push([tx, ty, visible]);
    }
  }
  // Missing tiles nearest the centre first, the margin after the view.
  const dist = (t) => (t[2] ? 0 : 1e12) + Math.hypot((t[0] + 0.5) * T - cam.x, (t[1] + 0.5) * T - cam.y);
  tiles.sort((a, b) => dist(a) - dist(b));
  const workers = tileWorkersReady();
  const deadline = performance.now() + TILE_BUDGET_MS;
  let missing = false;
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
    const a = toScreen(tx * T, (ty + 1) * T), b = toScreen((tx + 1) * T, ty * T);
    const x0 = Math.round(a.x), y0 = Math.round(a.y), w = Math.round(b.x) - x0, h = Math.round(b.y) - y0;
    if (c) { ctx.drawImage(c, x0, y0, w, h); continue; }
    missing = true;
    const coarse = coarserTile(z, tx, ty);
    if (coarse) ctx.drawImage(coarse[0], coarse[1], coarse[2], coarse[3], coarse[4], x0, y0, w, h);
    else drawFromFiner(z, tx, ty, x0, y0, w, h);
    if (job?.next) ctx.drawImage(job.cv, x0, y0, w, h); // the pieces done so far
  }
  // Half-done tiles for another zoom level or an older level version aren't needed.
  if (tileJobs.size > 256) {
    const current = baseVersion + '|' + draft.baseState + '|' + z + '|';
    for (const k of tileJobs.keys()) if (!k.startsWith(current)) tileJobs.delete(k);
  }
  // Rendering here: keep filling in over the next frames. With workers, each
  // arriving tile asks for a frame itself.
  if (missing && !workers) requestDraw();
}

// ---- tile workers --------------------------------------------------------------
// Tiles are rendered off the main thread by a few workers running this same
// module (tile-worker.js) on OffscreenCanvases, and come back as ImageBitmaps,
// so zooming right out - thousands of sprites per tile - never blocks the
// editor. Without worker support, tiles render here within a frame budget.

const pool = { workers: [], ready: 0, failed: false, inflight: new Map(), version: -1 };

function startTileWorkers() {
  // localStorage "mapMakerNoWorkers" forces rendering on this thread (for testing).
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
  // Some engines (WebKitGTK here) hang drawing in a worker: no ready in time -> render here.
  setTimeout(() => { if (!pool.ready && pool.workers.length) failWorkers(); }, 5000);
}

function failWorkers() {
  pool.failed = true;
  for (const w of pool.workers) w.terminate();
  pool.workers = [];
  pool.ready = 0;
  pool.inflight.clear();
  requestDraw(); // carry on rendering here
}

function workerState() {
  return { baseState: draft.baseState, removed: [...removed], removedVines: [...removedVines], version: baseVersion };
}

function onWorkerMessage(worker, m) {
  if (m.type === 'ready') { worker.ready = true; pool.ready++; requestDraw(); return; }
  if (m.type === 'unsupported') { failWorkers(); return; }
  if (m.type !== 'tile') return;
  worker.jobs--;
  pool.inflight.delete(m.key);
  // Keys carry the version: a tile rendered before an edit is dropped.
  if (m.bitmap && m.key.startsWith(baseVersion + '|')) { storeTile(m.key, m.bitmap); requestDraw(); }
  else m.bitmap?.close?.();
}

function tileWorkersReady() {
  if (!pool.ready) return false;
  if (pool.version !== baseVersion) {
    // The level changed (state, erased cells): workers render the new one.
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
  if (!free || free.jobs >= 3) return; // a short queue each: later frames ask again, for what's in view then
  free.jobs++;
  pool.inflight.set(key, free);
  free.postMessage({ type: 'tile', key, z, tx, ty });
}

// Worker side (called from tile-worker.js).
export async function workerInit(state) {
  if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('2d')) throw new Error('no OffscreenCanvas 2D');
  const bitmap = async (url) => {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    // Stand in for the <img> elements the renderer checks.
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
  // Prove drawing works here before saying ready (it can hang instead).
  const probe = new OffscreenCanvas(4, 4);
  probe.getContext('2d').drawImage(atlasImg, 0, 0, 4, 4);
  probe.transferToImageBitmap().close();
}

export function workerSetState(state) {
  removed = new Set(state.removed);
  removedVines = new Set(state.removedVines);
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

  const pad = cellPx < 2 ? 0.6 : 0.5; // hides seams between neighbouring runs
  const drawRuns = (runs, color) => {
    ctx.fillStyle = color;
    for (let i = 0; i < runs.length; i += 3) {
      const cy = runs[i], cx = runs[i + 1], len = runs[i + 2];
      if (cy < minCy || cy > maxCy || cx + len < minCx || cx > maxCx) continue;
      // Snapped to whole pixels so neighbouring rows share an edge exactly -
      // fractional rects left hairline gaps that striped the moss when zoomed out.
      const r = cellRect(cx, cy, len);
      const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
      ctx.fillRect(x0, y0, Math.ceil(r.x + r.w) - x0, Math.ceil(r.y + r.h) - y0);
    }
  };
  const useArt = artReady();
  if (baseOn()) {
    drawBaseTiles(W, H, useArt);
    if (useArt) drawLiveItems(W, H);
    // Erased tiles are left out of the base drawing; empty ones get a faint outline.
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
    // Mark the origin so an empty canvas still has a reference point.
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
      const art = isGround(kind) ? groundTile(cx, cy, kind === 'dark') : colouredTile(kind);
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

  // The author's vines (the base map's are in the cached image).
  const near = (cx, cy) => cx >= minCx - 6 && cx <= maxCx + 6 && cy >= minCy - 6 && cy <= maxCy + 6;
  vines.forEach((v, k) => { const [cx, cy] = unkey(k); if (near(cx, cy)) drawVine(cx, cy, v.s, rotMatrix(v.q)); });
  if (useArt) drawPlacedTiles(true);
  for (const o of placed) drawPlacedObject(o);
  if (draft.hitboxes) drawHitboxes(minCx, maxCx, minCy, maxCy);

  // Invisible triggers always get an outline; upgrade boxes only when their
  // real art isn't being drawn (zoomed out). Erased ones are crossed out.
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
      // Zoomed far out: just a dot per upgrade box.
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
    // Real gates; dimmed once the author's own gate overrides them.
    for (const c of base.courses) {
      ctx.globalAlpha = draft.start ? 0.35 : 1;
      if (c.start) drawGate(c.start, c.start.box || START_BOX, COLORS.start, 'START');
      ctx.globalAlpha = draft.end ? 0.35 : 1;
      if (c.end) drawGate(c.end, c.end.box || END_BOX, COLORS.end, 'END');
      // Where the timer resets: crossing these (e.g. running back past the
      // start gate) stops the lap without finishing it.
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.55;
      if (cam.scale >= 0.15) for (const r of c.resets || []) if (r.box) drawGate(r, r.box, COLORS.reset, 'TIMER RESET');
    }
    ctx.globalAlpha = 1;
  }
  if (baseOn() && base.scene && cam.scale >= 0.15) drawMarkers();
  if (draft.start) drawGate(draft.start, START_BOX, COLORS.start, 'START');
  if (draft.end) drawGate(draft.end, END_BOX, COLORS.end, 'END');
  if (draft.spawn) drawGate(draft.spawn, SPAWN_BOX, COLORS.spawn, 'SPAWN');

  // A standalone map's extent; overlays live in the real world, so none.
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
    else if (tool === 'vine' && base) drawVine(cx, cy, draft.vineSprite, rotMatrix(0));
    else if (tool === 'tile' && base && draft.pick.tile) { const w = cellWorld(cx, cy); const tk = tileKeyAt(draft.pick.tileLayer, w.x + CELL / 2, w.y + CELL / 2); ctx.globalAlpha = 1; drawPlacedTile({ layer: draft.pick.tileLayer, tile: draft.pick.tile, q: 0 }, tk, 0.6); }
    else if ((tool === 'object' || tool === 'decor') && base) { const w = cellWorld(cx, cy); const cat = tool === 'object' ? 'objects' : 'decor'; ctx.globalAlpha = 1; drawPlacedObject({ cat, i: draft.pick[cat] ?? 0, x: w.x + CELL / 2, y: w.y + CELL / 2 }, 0.6); }
    else if (tool === 'start') drawGate(gateAt(cx, cy, 'start'), START_BOX, COLORS.start, 'START');
    else if (tool === 'end') drawGate(gateAt(cx, cy, 'end'), END_BOX, COLORS.end, 'END');
    else if (tool === 'spawn') drawGate(gateAt(cx, cy, 'spawn'), SPAWN_BOX, COLORS.spawn, 'SPAWN');
    else { ctx.strokeStyle = COLORS.end; ctx.lineWidth = 2; const r = cellRect(cx, cy); ctx.strokeRect(r.x, r.y, r.w, r.h); }
    ctx.globalAlpha = 1;
  }
}

// Checkpoints (course ones marked), each course's respawn point, and a ring
// on teleporter arrows - clicking one jumps to the teleporter it leads to.
function drawMarkers() {
  const sc = base.scene, inState = (m) => m.state === 'always' || m.state === draft.baseState || !m.state;
  ctx.save();
  ctx.globalAlpha = 0.55; // helpers, not level art: keep them in the background
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

const TP_RADIUS = 22; // world units around a teleporter arrow that count as clicking it
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

// ---- hitbox view ------------------------------------------------------------
// Collision as the game has it: solid cells (ground, moss, the author's
// blocks) outlined green, blue / orange blocks in their colour, and every
// deadly tile's real physics shape - spikes, kill blocks, vines - in red.

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

// One deadly shape: polygons around the cell centre, through a tile matrix.
// Screen-sized scratch canvases for the kill-shape union and its outline.
function scratchCanvas(name) {
  const c = (scratchCanvas[name] ||= makeCanvas());
  if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
  return c;
}
const killMask = () => scratchCanvas('mask');
const killEdge = () => scratchCanvas('edge');

// A hit shape's bounds (units around its cell centre) after its tile matrix.
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
        // Erased cells split a run.
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
  // Kill shapes are filled into one mask and drawn as their union, so shapes
  // that touch read as one hitbox like the game's composite collider.
  const mask = killMask();
  const g = mask.getContext('2d');
  g.clearRect(0, 0, mask.width, mask.height);
  g.fillStyle = '#000';
  const saved = ctx;
  ctx = g;
  const hazards = new Map(); // cell -> { layer, box } for the gap closing below
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
    // The composite collider swells every shape by its offset distance, merges
    // and shrinks back: neighbours closer than twice that join up.
    const merge = base.hazardMerge || {};
    hazards.forEach((a, k) => {
      const reach = 2 * (merge[a.layer] || 0);
      if (!reach) return;
      const [cx, cy] = unkey(k);
      const east = hazards.get(key(cx + 1, cy)), north = hazards.get(key(cx, cy + 1));
      const w = cellWorld(cx, cy), ox = w.x + CELL / 2, oy = w.y + CELL / 2;
      const bridge = (x0, y0, x1, y1, across) => {
        const p = toScreen(ox + x0, oy + y1), q = toScreen(ox + x1, oy + y0);
        // Whole pixels, a pixel into each shape along the gap: no half-covered seam.
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
  // Outline: the mask nudged a pixel each way, minus the mask itself.
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

// ---- editing -------------------------------------------------------------

const BLOCK_KIND = { block: 'ground', dark: 'dark', blue: 'blue', orange: 'orange' };
const SPIKE_KIND = { spike: 'spike', blueSpike: 'blue', orangeSpike: 'orange' };

// Author spikes seat their base on whatever surface they touch (re-checked as
// blocks change) until R pins a rotation.
const spikeTurn = (sp, cx, cy) => sp.q ?? autoSpikeTurn(cx, cy);

// The vine (author's or base, not erased) whose sprite covers a world point.
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

// Gate / spawn transform for a click on cell (cx, cy): stands on that cell's floor.
function gateAt(cx, cy, kind) {
  // A spawn clicked inside ground stands on top of it instead.
  if (kind === 'spawn') for (let n = 0; n < 200 && isSolid(cx, cy); n++) cy++;
  const w = cellWorld(cx, cy);
  return { x: w.x + CELL / 2, y: w.y + { start: START_LIFT, end: END_LIFT, spawn: SPAWN_LIFT }[kind] };
}

// No spawn placed and no start gate: drop the player in the middle of what's
// on screen, standing on the floor of that cell.
function viewSpawn() {
  const c = cellOf(cam.x, cam.y);
  return gateAt(c.cx, c.cy, 'spawn');
}

// Author gate or spawn whose box covers a world point.
function markerAt(wx, wy) {
  const boxes = { start: START_BOX, end: END_BOX, spawn: SPAWN_BOX };
  return Object.keys(boxes).find((k) => {
    const g = draft[k], b = boxes[k];
    return g && Math.abs(wx - (g.x + b.dx)) <= Math.max(b.w / 2, CELL / 2) && Math.abs(wy - (g.y + b.dy)) <= Math.max(b.h / 2, CELL / 2);
  });
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
    vines.set(k, { s: draft.vineSprite, q: 0 });
  } else if (tool === 'tile') {
    const pk = draft.pick;
    if (!base || !pk.tile) return false;
    const w = cellWorld(cx, cy), tk = tileKeyAt(pk.tileLayer, w.x + CELL / 2, w.y + CELL / 2);
    if (tiles.get(tk)?.tile === pk.tile) return false;
    tiles.set(tk, { layer: pk.tileLayer, tile: pk.tile, q: 0 });
  } else if (tool === 'object' || tool === 'decor') {
    if (drag?.placedObject) return false; // one per click
    const cat = tool === 'object' ? 'objects' : 'decor', i = draft.pick[cat] ?? 0;
    if (!catalogItem({ cat, i })) return false;
    const w = cellWorld(cx, cy);
    placed.push({ cat, i, x: w.x + CELL / 2, y: w.y + CELL / 2 });
    if (drag) drag.placedObject = true;
  } else if (tool === 'erase') {
    if (blocks.delete(k) || spikes.delete(k)) return true;
    {
      const w = cellWorld(cx, cy), px = w.x + CELL / 2, py = w.y + CELL / 2;
      const oi = placed.findLastIndex((o) => objectHit(o, px, py));
      if (oi >= 0) { placed.splice(oi, 1); return true; }
      const t = tileAt(px, py);
      if (t) { tiles.delete(t[0]); return true; }
    }
    const isBase = baseOn() && (groundSet.has(k) || mossSet.has(k) || blueSet.has(k) || orangeSet.has(k) || (baseHaz.get(k) && baseHaz.get(k).kind !== 'vine'));
    if (isBase && !removed.has(k)) { removed.add(k); return true; }
    const w = cellWorld(cx, cy);
    const marker = markerAt(w.x + CELL / 2, w.y + CELL / 2);
    if (marker) { draft[marker] = null; return true; }
    const obj = baseOn() && baseObjects.find((o) => !removedObjects.has(o.id) && Math.abs(w.x + CELL / 2 - o.x) <= o.w / 2 && Math.abs(w.y + CELL / 2 - o.y) <= o.h / 2);
    if (obj) { removedObjects.add(obj.id); return true; }
    const hit = vineAt(w.x + CELL / 2, w.y + CELL / 2);
    if (!hit) return false;
    if (hit.own) vines.delete(hit.k);
    else removedVines.add(hit.k);
  } else if (tool === 'start' || tool === 'end' || tool === 'spawn') {
    draft[tool] = gateAt(cx, cy, tool);
  }
  return true;
}

// One undo step per mouse stroke, recorded only once the stroke changes something.
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
    // Cycle through the directions that have a surface behind them (all four
    // if it's floating or only one fits).
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
  if (placed.length) parts.push(`${placed.length} objects`);
  const gone = removed.size + removedVines.size + removedObjects.size;
  if (baseOn() && gone) parts.push(`${gone} removed`);
  let lonely = false;
  if (baseOn()) {
    // Overlay: edits to the real world, whose courses keep their own gates.
    parts.push('edits the real world');
    lonely = !!draft.start !== !!draft.end;
    parts.push(draft.start && draft.end ? 'plus your timed course' : 'real courses keep their gates');
    if (!draft.spawn) parts.push(draft.start ? 'spawn at your start gate' : 'spawn at view centre');
  } else {
    const area = exportArea();
    if (area) parts.push(`${area.x1 - area.x0 + 1}×${area.y1 - area.y0 + 1} cells`);
    const gates = effectiveGates(area);
    lonely = !!gates.start !== !!gates.end;
    parts.push(gates.start && gates.end ? 'timed course' : 'free play');
    if (!draft.spawn) parts.push(gates.start ? 'spawn at start gate' : 'spawn at view centre');
  }
  el.innerHTML = parts.map((p) => `<span>${p}</span>`).join('')
    + (lonely ? `<span class="mm-warn">${draft.start ? 'no end' : 'no start'} gate - gates skipped</span>` : '')
    + (hover ? `<span class="mm-coord">${hover.cx}, ${hover.cy}</span>` : '');
  const empty = !blocks.size && !spikes.size && !vines.size && !draft.start && !draft.end && !draft.spawn && !baseOn();
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
      await loadBase();
    } catch (e) {
      flash("Couldn't load the base game map: " + e, true);
      return;
    } finally {
      btn.disabled = false;
    }
    draft.useBase = true;
    fillJumpList();
    // Nothing placed yet: drop the author at course 1 instead of empty space.
    if (!blocks.size && !spikes.size && !draft.start && base.courses[0]) jumpTo(base.courses[0].start.x, base.courses[0].start.y);
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

// Installs the map as "map-maker-test" and launches the modded game, which
// Navigator starts straight into (needs a Recharge build with test_launch_map).
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
  if (!confirm('Clear every block, spike and gate from this draft?')) return;
  pushUndo();
  blocks.clear();
  spikes.clear();
  removed.clear();
  draft.start = draft.end = draft.spawn = null;
  saveDraft();
  requestDraw();
}

function jumpTo(x, y) {
  cam.x = x;
  cam.y = y;
  cam.scale = Math.max(cam.scale, 0.5);
  requestDraw();
}

// ---- input ---------------------------------------------------------------

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
    const arrow = teleportArrowAt(wp.x, wp.y);
    if (arrow) { jumpTo(arrow.to[0], arrow.to[1]); flash('Teleported'); return; }
    const c = eventCell(e);
    drag = { pan: false, before: snapshot(), changed: false };
    strokeAt(c.cx, c.cy);
    requestDraw();
  });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  new ResizeObserver(resize).observe(canvas.parentElement);
}

// Window-level listeners outlive a re-rendered Navigator view, so bind them once.
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
    if (drag && (BLOCK_KIND[tool] || SPIKE_KIND[tool] || tool === 'erase')) {
      strokeAt(c.cx, c.cy);
    }
    updateStatus();
    requestDraw();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
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
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Escape') { closePopover(); return; }
  if (!e.shiftKey && k === 'h') { toggleHitboxes(); return; }
  if (k === 'e') { setTool('erase'); return; }
  if (k === 'r') { rotateSpikeAtHover(); return; }
  if (e.key === '[' || e.key === ']') { stepItem(e.key === ']' ? 1 : -1); updatePopover(); return; }
  if (/^[1-9]$/.test(e.key)) { selectItem(draft.cat, Number(e.key) - 1); updatePopover(); return; }
  const cat = CATEGORIES.find((c) => c.key === k);
  if (cat) {
    // The category's key: pick it, or step through it when it's already picked.
    if (draft.cat === cat.id && tool !== 'erase') stepItem(e.shiftKey ? -1 : 1);
    else selectItem(cat.id, currentIndex(cat.id));
    updatePopover();
  }
}

function updatePopover() {
  if (popCat) { popCat = draft.cat; renderPopover(''); }
}

// ---- mount ---------------------------------------------------------------


export async function mountEditor(container) {
  if (mounted && root === container) { resize(); return; }
  mounted = false;
  root = container;
  root.innerHTML = `
    <div class="mm-bar">
      <div class="mm-cats">
        ${CATEGORIES.map((c) => `<button class="mm-cat" data-cat="${c.id}" title="${c.label} - ${c.key.toUpperCase()} to pick, again to step through (Shift back), [ ] step, 1-9 pick"><span class="mm-cat-thumb"></span><span class="mm-cat-text"><span class="mm-cat-label">${c.label}</span><span class="mm-cat-item"></span></span><kbd>${c.key.toUpperCase()}</kbd><span class="mm-caret">▾</span></button>`).join('')}
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
      <div class="mm-hint">Left-click paint · Right-drag / Space-drag pan · Wheel zoom</div>
      <div class="mm-flash" id="mm-flash" hidden></div>
    </div>
    <div class="mm-status" id="mm-status"></div>
    <div class="mm-bar mm-footer">
      <input class="mm-input mm-name" id="mm-name" type="text" placeholder="Map name" />
      <input class="mm-input mm-desc" id="mm-desc" type="text" placeholder="Description (optional)" />
      <div class="mm-bar-right">
        <button class="mm-tool" id="mm-test" title="Install this map and launch the game straight into it">Test in game</button>
        <button class="mm-tool" id="mm-copy" title="Copy map.json to the clipboard">Copy JSON</button>
        <button class="mm-tool mm-primary" id="mm-export">Export .zip</button>
      </div>
    </div>`;

  canvas = root.querySelector('#mm-canvas');
  ctx = canvas.getContext('2d');
  root.querySelector('[data-tool="erase"]').addEventListener('click', () => { closePopover(); setTool('erase'); });
  root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    if (draft.cat !== b.dataset.cat || tool === 'erase') selectItem(b.dataset.cat, currentIndex(b.dataset.cat));
    openPopover(b.dataset.cat, b);
  }));
  root.addEventListener('mousedown', (e) => { if (popCat && !e.target.closest('#mm-pop, [data-cat]')) closePopover(); });
  root.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => setBaseState(b.dataset.state)));

  loadDraft();
  // Base data also drives real ground art (autotiling) for maps made without
  // importing it, so fetch it in the background either way.
  if (!draft.useBase) loadBase().then(() => { fillJumpList(); requestDraw(); }).catch(() => {});
  if (draft.useBase) {
    try { await loadBase(); } catch { draft.useBase = false; }
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

  const home = draft.spawn || draft.start;
  if (home) { cam.x = home.x; cam.y = home.y; }
  mounted = true;
  bindCanvas();
  bindWindow();
  syncBaseUi();
  // The category and item picked last time.
  if (!CATEGORIES.some((c) => c.id === draft.cat) || !categoryItems(draft.cat).length) draft.cat = 'blocks';
  selectItem(draft.cat, currentIndex(draft.cat));
  resize();
  updateStatus();
}

