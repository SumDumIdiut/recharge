const GRID = 32;
const RESERVED_IDS = new Set(['_BaseGameEdits', '_BSideEdits']);
const PLACEABLE_TYPES = new Set(['block', 'blueBlock', 'orangeBlock', 'spike', 'modifyObject']);
const RENDER_TYPE = { modifyObject: 'upgradeBox' };

const UPGRADE_ALLOWED = new Set(['dashunlock', 'double jump', 'wall jump', 'air jump', 'end demo']);

const SNAPSHOT_SCENE = { _BaseGameEdits: 'Overworld', _BSideEdits: 'OverworldHard' };

const SPRITE_SOURCES = {
  block: { tilemap: 'ground', index: 0 },
  blueBlock: { tilemap: 'blueBlocks', index: 0 },
  orangeBlock: { tilemap: 'orangeBlocks', index: 0 },
  spike: { tilemap: 'spike', index: 0 },
  startGate: { tilemap: 'startGate', index: 0 },
  endGate: { tilemap: 'endGate', index: 0 },
  upgradeBox: { tilemap: 'upgradeBox', index: 0 },
};
const spriteImages = {};

let invoke;
let currentId = null;
let mapDef = null;
let snapshot = null;
let selectedTool = 'block';
let selectedUpgradeName = '';
let dirty = false;
let view = { x: 0, y: 0, scale: 2 };
let panning = false;
let panLast = null;

let canvas, ctx, wrap;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emptyGroup() {
  return { startX: 0, startY: 0, endX: 0, endY: 0, reward: { currency: 'Cash', amount: 0 }, objects: [] };
}

function emptyMapDef(id) {
  return {
    formatVersion: 1,
    isOverlay: RESERVED_IDS.has(id),
    name: id,
    description: '',
    images: [],
    groups: [emptyGroup()],
    customImages: [],
  };
}

function currentGroup() {
  if (!mapDef.groups || !mapDef.groups.length) mapDef.groups = [emptyGroup()];
  return mapDef.groups[0];
}

function targetLabel(id) {
  if (id === '_BaseGameEdits') return 'Base Game';
  if (id === '_BSideEdits') return 'B-Side';
  return id;
}

function setActiveTargetButtons(id) {
  document.getElementById('editor-target-basegame').classList.toggle('active', id === '_BaseGameEdits');
  document.getElementById('editor-target-bside').classList.toggle('active', id === '_BSideEdits');
  document.getElementById('editor-custom-select').value = RESERVED_IDS.has(id) ? '' : id;
}

function updateStatus() {
  document.getElementById('editor-status').textContent = (dirty ? '● ' : '') + 'Editing: ' + targetLabel(currentId);
  const count = currentGroup().objects.filter((o) => PLACEABLE_TYPES.has(o.type)).length;
  let text = count + ' object' + (count === 1 ? '' : 's') + ' placed';
  if (SNAPSHOT_SCENE[currentId] && !snapshot) {
    text += ' — no real course data yet. Launch the game and enter ' + targetLabel(currentId) + ' once to see it here.';
  }
  document.getElementById('editor-count').textContent = text;
}

function markDirty() {
  dirty = true;
  updateStatus();
}

function resetView() {
  view = { x: 0, y: 0, scale: 2 };
  const center = snapshot && computeSnapshotCenter(snapshot);
  if (center) { view.x = center.x; view.y = center.y; }
}

function computeSnapshotCenter(snap) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, found = false;
  const consider = (x, y) => { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const arr of [snap.groundCells, snap.blueCells, snap.orangeCells]) {
    if (!arr) continue;
    for (const [x, y] of arr) consider(x, y);
  }
  if (snap.spikes) for (const s of snap.spikes) consider(s.x, s.y);
  return found ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

async function loadMap(id) {
  if (dirty && !window.confirm('Discard unsaved changes to ' + targetLabel(currentId) + '?')) return;

  currentId = id;
  setActiveTargetButtons(id);
  try {
    const text = await invoke('get_map', { id });
    mapDef = JSON.parse(text);
    if (!mapDef.groups || !mapDef.groups.length) mapDef.groups = [emptyGroup()];
    if (!mapDef.customImages) mapDef.customImages = [];
  } catch (e) {
    mapDef = emptyMapDef(id);
  }
  dirty = false;

  snapshot = null;
  const sceneName = SNAPSHOT_SCENE[id];
  if (sceneName) {
    try {
      snapshot = JSON.parse(await invoke('get_course_snapshot', { scene: sceneName }));
    } catch (e) {}
  }

  document.getElementById('editor-body').hidden = false;
  document.getElementById('editor-empty-hint').hidden = true;
  document.getElementById('editor-save-btn').disabled = false;
  populateUpgradeNames();
  updateStatus();
  resetView();
  resizeCanvas();
}

function getPlaceholderPngBytes() {
  return new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    const pctx = c.getContext('2d');
    pctx.fillStyle = '#5a5a5a';
    pctx.fillRect(0, 0, 8, 8);
    pctx.fillStyle = '#9a9a9a';
    pctx.fillRect(1, 1, 6, 6);
    c.toBlob((blob) => {
      if (!blob) { reject(new Error('toBlob failed')); return; }
      blob.arrayBuffer().then((buf) => resolve(Array.from(new Uint8Array(buf))));
    }, 'image/png');
  });
}

async function ensurePlaceholderAsset() {
  const hasBlocks = currentGroup().objects.some((o) => o.type === 'block');
  if (!hasBlocks) return;
  if (mapDef.customImages.some((c) => c.assetId === 'editor_block')) return;
  const bytes = await getPlaceholderPngBytes();
  await invoke('save_map_image', { id: currentId, filename: 'editor_block.png', bytes });
  mapDef.customImages.push({ assetId: 'editor_block', path: 'gallery/editor_block.png', pixelsPerUnit: 8 / GRID });
}

async function loadSpriteImages() {
  await Promise.all(Object.entries(SPRITE_SOURCES).map(async ([key, { tilemap, index }]) => {
    try {
      const bytes = await invoke('read_tile_texture', { tilemap, index });
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      spriteImages[key] = img;
      draw();
    } catch (e) {
      spriteImages[key] = null;
    }
  }));
}

function populateUpgradeNames() {
  const sel = document.getElementById('editor-upgrade-select');
  const btn = document.querySelector('.editor-tool-btn[data-tool="modifyObject"]');
  if (!sel) return;

  const names = [];
  const seen = new Set();
  if (snapshot && snapshot.upgradeBoxes) {
    for (const u of snapshot.upgradeBoxes) {
      const lower = (u.name || '').toLowerCase();
      if (!UPGRADE_ALLOWED.has(lower) || seen.has(u.name)) continue;
      seen.add(u.name);
      names.push(u.name);
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  const available = names.length > 0;
  sel.disabled = !available;
  if (btn) btn.disabled = !available;
  selectedUpgradeName = available ? names[0] : '';
}

async function populateCustomMaps() {
  const sel = document.getElementById('editor-custom-select');
  try {
    const maps = await invoke('list_maps');
    const custom = maps.filter((m) => !RESERVED_IDS.has(m.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    sel.innerHTML = '<option value="">Custom map…</option>' + custom.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
  } catch (e) {}
}

function worldToScreen(wx, wy) {
  const cw = canvas._cssWidth, ch = canvas._cssHeight;
  return { x: cw / 2 + (wx - view.x) * view.scale, y: ch / 2 - (wy - view.y) * view.scale };
}

function screenToWorld(sx, sy) {
  const cw = canvas._cssWidth, ch = canvas._cssHeight;
  return { x: (sx - cw / 2) / view.scale + view.x, y: -(sy - ch / 2) / view.scale + view.y };
}

function resizeCanvas() {
  if (!wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas._cssWidth = rect.width;
  canvas._cssHeight = rect.height;
  draw();
}

function drawFallbackGlyph(type, p, size) {
  const colors = {
    blueBlock: '#5a8cdc',
    orangeBlock: '#dc9646',
    startGate: '#41f88d',
    endGate: '#c63ed8',
    upgradeBox: '#f9ff64',
  };
  if (type === 'spike') {
    ctx.fillStyle = '#e04b4b';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - size / 2);
    ctx.lineTo(p.x + size / 2, p.y + size / 2);
    ctx.lineTo(p.x - size / 2, p.y + size / 2);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.fillStyle = colors[type] || '#9a9a9a';
  ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
  if (!colors[type]) {
    ctx.strokeStyle = '#5a5a5a';
    ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
  }
}

function drawGlyph(type, wx, wy, size, alpha) {
  const cw = canvas._cssWidth, ch = canvas._cssHeight;
  const p = worldToScreen(wx, wy);
  if (p.x < -size || p.x > cw + size || p.y < -size || p.y > ch + size) return;
  const renderType = RENDER_TYPE[type] || type;
  const img = spriteImages[renderType];
  ctx.save();
  ctx.globalAlpha = alpha;
  if (img) ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
  else drawFallbackGlyph(renderType, p, size);
  ctx.restore();
}

function drawCellLayer(cells, size, type, alpha) {
  if (!cells || !cells.length) return;
  for (const [wx, wy] of cells) drawGlyph(type, wx, wy, size, alpha);
}

function draw() {
  if (!canvas._cssWidth) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = canvas._cssWidth, ch = canvas._cssHeight;
  ctx.clearRect(0, 0, cw, ch);
  if (!mapDef) return;

  const gridPx = GRID * view.scale;
  if (gridPx >= 6) {
    const origin = worldToScreen(0, 0);
    let startX = origin.x % gridPx; if (startX < 0) startX += gridPx;
    let startY = origin.y % gridPx; if (startY < 0) startY += gridPx;
    ctx.strokeStyle = 'rgba(249,255,228,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < cw; x += gridPx) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ch); }
    for (let y = startY; y < ch; y += gridPx) { ctx.moveTo(0, y + 0.5); ctx.lineTo(cw, y + 0.5); }
    ctx.stroke();
  }

  const origin = worldToScreen(0, 0);
  ctx.strokeStyle = 'rgba(249,255,228,0.22)';
  ctx.beginPath();
  ctx.moveTo(origin.x + 0.5, 0); ctx.lineTo(origin.x + 0.5, ch);
  ctx.moveTo(0, origin.y + 0.5); ctx.lineTo(cw, origin.y + 0.5);
  ctx.stroke();

  const size = Math.max(GRID * view.scale, 4);
  const markerSize = size * 1.4;

  if (snapshot) {
    drawCellLayer(snapshot.groundCells, size, 'block', 0.35);
    drawCellLayer(snapshot.blueCells, size, 'blueBlock', 0.4);
    drawCellLayer(snapshot.orangeCells, size, 'orangeBlock', 0.4);
    if (snapshot.spikes) for (const s of snapshot.spikes) drawGlyph('spike', s.x, s.y, size, 0.4);
    if (snapshot.upgradeBoxes) for (const u of snapshot.upgradeBoxes) drawGlyph('upgradeBox', u.x, u.y, size, 0.55);
    if (snapshot.startGates) for (const g of snapshot.startGates) drawGlyph('startGate', g.x, g.y, markerSize, 0.65);
    if (snapshot.endGates) for (const g of snapshot.endGates) drawGlyph('endGate', g.x, g.y, markerSize, 0.65);
  }

  for (const o of currentGroup().objects) {
    if (!PLACEABLE_TYPES.has(o.type)) continue;
    drawGlyph(o.type, o.x, o.y, size, 1);
  }
}

function handleLeftClick(world) {
  const objs = currentGroup().objects;
  const HIT = GRID / 2;
  let hitIdx = -1, hitDist = Infinity;
  objs.forEach((o, i) => {
    if (!PLACEABLE_TYPES.has(o.type)) return;
    const d = Math.hypot(o.x - world.x, o.y - world.y);
    if (d < HIT && d < hitDist) { hitDist = d; hitIdx = i; }
  });
  if (hitIdx !== -1) {
    objs.splice(hitIdx, 1);
  } else {
    if (selectedTool === 'modifyObject' && !selectedUpgradeName) return;
    const snapX = Math.round(world.x / GRID) * GRID;
    const snapY = Math.round(world.y / GRID) * GRID;
    const obj = { type: selectedTool, x: snapX, y: snapY, rotation: 0 };
    if (selectedTool === 'block') { obj.assetId = 'editor_block'; obj.scaleX = 1; obj.scaleY = 1; }
    if (selectedTool === 'modifyObject') { obj.objectName = selectedUpgradeName; }
    objs.push(obj);
  }
  markDirty();
  draw();
}

function wireCanvasEvents() {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    if (!mapDef) return;
    if (e.button === 0) {
      const rect = canvas.getBoundingClientRect();
      handleLeftClick(screenToWorld(e.clientX - rect.left, e.clientY - rect.top));
    } else if (e.button === 1 || e.button === 2) {
      panning = true;
      panLast = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    const dx = e.clientX - panLast.x;
    const dy = e.clientY - panLast.y;
    panLast = { x: e.clientX, y: e.clientY };
    view.x -= dx / view.scale;
    view.y += dy / view.scale;
    draw();
  });

  window.addEventListener('mouseup', () => { panning = false; });

  canvas.addEventListener('wheel', (e) => {
    if (!mapDef) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.scale = Math.min(40, Math.max(0.2, view.scale * factor));
    const after = screenToWorld(sx, sy);
    view.x += before.x - after.x;
    view.y += before.y - after.y;
    draw();
  }, { passive: false });
}

window.__editorLoad = (id) => { loadMap(id); };
window.__editorLoadFromSelect = (sel) => { if (sel.value) loadMap(sel.value); };

window.__editorSelectTool = (tool) => {
  selectedTool = tool;
  document.querySelectorAll('.editor-tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
};

window.__editorResetView = () => { resetView(); draw(); };
window.__editorUpgradeChange = (sel) => { selectedUpgradeName = sel.value; };

window.__editorSave = async () => {
  if (!mapDef || !currentId) return;
  const btn = document.getElementById('editor-save-btn');
  btn.disabled = true;
  try {
    await ensurePlaceholderAsset();
    await invoke('save_map', { id: currentId, content: JSON.stringify(mapDef, null, 2) });
    dirty = false;
    updateStatus();
    if (!RESERVED_IDS.has(currentId)) await populateCustomMaps();
  } catch (e) {
    window.alert('Save failed: ' + e);
  } finally {
    btn.disabled = false;
  }
};

export async function init() {
  invoke = window.__TAURI__.core.invoke;
  canvas = document.getElementById('editor-canvas');
  ctx = canvas.getContext('2d');
  wrap = document.querySelector('#view-editor .editor-canvas-wrap');

  wireCanvasEvents();
  window.addEventListener('resize', resizeCanvas);
  new ResizeObserver(resizeCanvas).observe(wrap);

  loadSpriteImages();
  await populateCustomMaps();
}
