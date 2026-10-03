// Maps made by the old editor (installed map.json files, exported zips) as v2
// documents. Tiles come from the map's export (its tile runs and tile objects,
// already worked out by the old editor); things, courses and settings from its
// `editor` state, kept field for field under v2's entity kinds.
import { layerInfo } from './base.js';

const CELL = 32, OFFSET_Y = 9;
const GROUND = 'new awesome nikki ground';
const layerOf = (tilemap) => tilemap.replace(/^ground(?=#|$)/, GROUND);
const FALLBACK = { ground: [GROUND, 'ground1_tileset_10'], blue: ['blueBlocks', 'blue_ground_tileset_10'], orange: ['orangeBlocks', 'orange_ground_tileset_10'] };

export function canConvert(map) {
  if (!map?.editor) return 'That map wasn\'t made in the map editor (no editor data in it).';
  if (map.editor.v !== 2 && map.editor.useBase && !map.tileLayers) return 'This map still uses the old "edits on the base map" format. Open it in the old editor once and save it - that converts it - then open it here.';
  return null;
}

const PICTURED = /^(Moss|)$/;
function restorePictures(t, b, layers) {
  for (const layer of layers) {
    const st = t.layers.get(layer);
    if (!st) continue;
    let need = false;
    for (const n of t.names) if (PICTURED.test(n)) need = true;
    if (!need) continue;
    for (const L of b.art.levelTiles || []) {
      if (L.name !== layer) continue;
      for (let i = 0; i < L.runs.length; i += 5) {
        const full = L.names[L.runs[i + 3]], at = full.lastIndexOf('@'), asset = at >= 0 ? full.slice(0, at) : full;
        if (at < 0 || !PICTURED.test(asset)) continue;
        for (let k = 0; k < L.runs[i + 2]; k++) {
          const x = L.runs[i + 1] + k, y = L.runs[i], v = t.cell(layer, x, y);
          if (v && t.tileName(v) === asset) t.setAt(layer, x, y, full, t.matrix(v));
        }
      }
    }
  }
}

export function fromMap(doc, map, savedId = null) {
  const st = map.editor, b = doc.base;
  doc.clear();
  Object.assign(doc.meta, {
    name: map.name || st.name || '', description: map.description || st.description || '',
    uid: map.uid || st.uid || doc.meta.uid, levelState: map.areaState || (map.tileLayers ? st.baseState || 'start' : null),
    player: st.player || doc.meta.player, ownProgress: !!st.ownProgress, music: st.music, background: st.background, spawn: st.spawn || null,
    hiddenGroups: st.hiddenGroups || [], assets: st.assets || [], savedId,
  });
  const lo = map.levelOrigin || [0, OFFSET_Y], ox = lo[0], oy = lo[1];
  const t = doc.tiles;
  t.journal = null;
  const mats = map.mats || b.mats || [[1, 0, 0, 1]];
  for (const l of map.tileLayers || []) t.addRuns(layerOf(l.tilemap), l.editorNames || l.names, l.runs, mats);
  // Older maps lost the picture of rule tiles (moss) and unnamed tiles: the level's tile at
  // the same cell gives it back where it's the same tile.
  restorePictures(t, b, (map.tileLayers || []).filter((l) => !l.editorNames).map((l) => layerOf(l.tilemap)));
  const g = map.groups?.[0] || { objects: [] };
  const cellGroups = new Map();
  for (const o of g.objects || []) {
    if (o.type !== 'tile' && o.type !== 'ground' && o.type !== 'coloredGround') continue;
    let layer, name, m = o.matrix || [1, 0, 0, 1];
    if (o.type === 'tile') { layer = layerOf(o.tilemap); name = o.tileName; }
    else [layer, name] = FALLBACK[o.type === 'ground' ? 'ground' : o.color] || FALLBACK.ground;
    const wx = o.cellX != null ? o.cellX * CELL + CELL / 2 : o.x + ox, wy = o.cellY != null ? o.cellY * CELL + OFFSET_Y + CELL / 2 : o.y + oy;
    const li = layerInfo(b, layer), x = Math.floor((wx - li.ox) / li.size), y = Math.floor((wy - li.oy) / li.size);
    t.setAt(layer, x, y, name, m, o.spriteFrom ? { spriteFrom: o.spriteFrom } : undefined);
    if (o.group) cellGroups.set(layer + '|' + x + ',' + y, o.group);
  }
  t.journal = [];

  const ents = doc.entities;
  // Saved by this editor: its own state, as it was.
  if (st.v === 2) {
    Object.assign(doc.meta, st.meta || {}, { savedId });
    doc.entities = (st.entities || []).map((e) => ({ ...e }));
    doc.courses = (st.courses || []).map((c) => ({ ...c }));
    doc.cellGroups = st.cellGroups || {};
    doc.seq = doc.entities.length;
    doc.reindex();
    doc.changed({ tiles: true, all: true, meta: true });
    return;
  }
  for (const o of st.placed || []) ents.push({ ...o, id: doc.newId(o.lv != null ? 'u' : 'o'), kind: o.lv != null ? 'unit' : 'object' });
  for (const f of st.freeSpikes || []) ents.push({ ...f, id: doc.newId('s'), kind: 'spike' });
  for (const s of st.signs || []) ents.push({ ...s, id: doc.newId('t'), kind: 'text' });
  for (const c of st.csprites || []) ents.push({ ...c, id: doc.newId('i'), kind: 'sprite' });
  for (const tg of st.triggers || []) { const { kind, ...rest } = tg; ents.push({ ...rest, t: kind, id: doc.newId('g'), kind: 'trigger' }); }
  for (const s of st.xspawns || []) ents.push({ ...s, id: doc.newId('p'), kind: 'spawn' });
  for (const a of st.arrows || []) ents.push({ ...a, id: a.id || doc.newId('a'), kind: 'arrow' });
  // Kill-on-touch ("true") spikes stay things; the rest of the grid spikes are tiles already.
  for (const [k, sp] of Object.entries(st.spikes || {})) {
    if (sp.c !== 'true') continue;
    const [cx, cy] = k.split(',').map(Number);
    ents.push({ ...sp, id: doc.newId('s'), kind: 'spike', grid: true, x: cx * CELL + CELL / 2, y: cy * CELL + OFFSET_Y + CELL / 2 });
  }
  doc.courses = (st.courses || []).map((c) => ({ ...c }));
  doc.cellGroups = Object.fromEntries(cellGroups);
  doc.reindex();
  doc.changed({ tiles: true, all: true, meta: true });
}
