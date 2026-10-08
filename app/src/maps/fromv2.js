// A map made by the v2 editor opened in the v1 editor.
//
// A v2 map file is already the format the game reads, and most of it is the same
// v1 writes - but two parts differ, and both are converted here:
//
//  - Tiles. v2 keeps them as `tileLayers` (compact runs, with the layer's grid
//    size baked into the runs). v1 has no tileLayers at all: every tile is an
//    entry in its `tiles` map, keyed by its cell in that layer's own grid.
//  - Editor state. v2 stores its own document (meta, entities, courses) where v1
//    keeps a flat draft.
//
// Everything else - objects, courses, spawns, settings - is already shared and is
// left untouched, so a converted map still plays exactly as it did.
//
// What v2 held that v1 has no field for is dropped - the game's own markers and
// group triggers, the v2 entity ids, and the original entity list. Saving from
// here writes v1's format, so a converted map is a v1 map from then on.
const CELL = 32, OFFSET_Y = 9;
const GROUND = 'new awesome nikki ground';
const layerOf = (tilemap) => tilemap.replace(/^ground(?=#|$)/, GROUND);
const TILE_SPRITE = /^(.*)@(-?\d+)$/;
// v2 writes a tile as "Name@index" when the atlas has several sprites for that
// name and only the index says which - the moss autotile is 34,000 cells of it.
// The index is kept on the tile, because the name alone would collapse every
// variant onto one sprite and the moss would stop tiling.
const tileAsset = (n) => TILE_SPRITE.exec(n)?.[1] ?? n;
const tileVariant = (n) => { const m = TILE_SPRITE.exec(n); return m && { sprite: +m[2] }; };

// Thorn vines aren't atlas sprites at all - each is its own picture, drawn by
// the editor's vine code. A v2 map keeps them as ordinary tiles (on the
// overgrowth's spike layer, the spike layers, or as background decoration), so
// they're matched by sprite name and handed to v1's vines map, which is per-cell
// and already draws them.
const isVineSprite = (names) => { const v = new Set(names); return (n) => v.has(n); };
// v1's vines are rotated in quarter turns, not given a matrix.
const rotationOf = (m) => {
  if (!m) return 0;
  const a = [1, 0, 0, 1], b = [0, -1, 1, 0], c = [-1, 0, 0, -1], d = [0, 1, -1, 0];
  const same = (p, q) => p.every((v, i) => v === q[i]);
  return same(m, a) ? 0 : same(m, b) ? 1 : same(m, c) ? 2 : same(m, d) ? 3 : 0;
};

export function isV2(map) {
  return !!map?.editor && map.editor.v === 2;
}

// v2 tiles -> v1's tiles map (plus its vines and moss), with the cell worked out
// in that layer's own grid (most are 32px, but some are 64px with their own
// origin - the run coordinates are already in that grid).
//
// Anything the editor already has a live path for goes there rather than into
// `tiles`: vines to `vines`, moss to `mossCells`. That way a converted map is
// drawn, autotiled and edited by exactly the same code as a map built here - a
// moss cell keeps re-autotiling as its neighbours change instead of being a
// frozen sprite per cell.
function convertTiles(map, gridOf, vine) {
  const out = {}, vines = {}, moss = {};
  for (const l of map.tileLayers || []) {
    const layer = layerOf(l.tilemap);
    const g = gridOf(layer);
    const names = l.editorNames || l.names || [];
    const runs = l.runs || [];
    for (let i = 0; i < runs.length; i += 5) {
      const cy = runs[i], cx = runs[i + 1], n = runs[i + 2];
      const name = runs[i + 3] != null && runs[i + 3] !== 0 ? names[runs[i + 3]] : names[0];
      const m = g.mats?.[runs[i + 4]];
      // Thorn vines go to v1's vines, drawn from their own pictures.
      if (vine(tileAsset(name))) {
        const cell = { s: tileAsset(name), q: rotationOf(m) };
        for (let k = 0; k < n; k++) vines[`${cx + k},${cy}`] = cell;
        continue;
      }
      // Moss goes to the moss cells, autotiled from the cells themselves. Both
      // moss layers share one grid, so they merge into the same set.
      if (layer === 'moss' || layer === 'OvergrowthMoss') {
        for (let k = 0; k < n; k++) moss[`${cx + k},${cy}`] = true;
        continue;
      }
      // The matrix is left off when it's the identity: v1's tileMatrix already
      // works that out, and 99.5% of a big map's tiles are.
      const cell = { layer, tile: tileAsset(name), ...(tileVariant(name) || {}),
        ...(m && (m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) ? { m } : {}) };
      for (let k = 0; k < n; k++) out[`${layer}|${cx + k},${cy}`] = cell;
    }
  }
  return { tiles: out, vines, moss };
}

// v2 entities -> v1's placed objects / free spikes / signs / triggers / sprites.
function convertEntities(entities) {
  const placed = [], freeSpikes = [], signs = [], triggers = [], csprites = [], xspawns = [];
  for (const e of entities || []) {
    if (e.kind === 'spawn') { xspawns.push({ x: e.x, y: e.y, area: e.area || undefined }); continue; }
    if (e.kind === 'object' || e.kind === 'unit') {
      if (!e.path) continue;
      placed.push({
        path: e.path, x: Math.round(e.x), y: Math.round(e.y),
        ...(e.group ? { group: e.group } : {}),
        ...(e.course ? { course: e.course } : {}),
      });
    } else if (e.kind === 'spike') {
      if (e.grid) freeSpikes.push({ x: e.x, y: e.y, c: 'true', q: e.q || 0 });
      else freeSpikes.push({ x: e.x, y: e.y, c: e.c || 'spike', q: e.q || 0, ...(e.r ? { r: e.r } : {}) });
    } else if (e.kind === 'text') {
      signs.push({ x: e.x, y: e.y, t: e.t || '', w: e.w, h: e.h, c: e.c, r: e.r || 0 });
    } else if (e.kind === 'trigger') {
      triggers.push({ x: e.x, y: e.y, w: e.w, h: e.h, kind: e.t || 'media', ...(e.music ? { music: e.music } : {}), ...(e.zone ? { zone: e.zone } : {}) });
    } else if (e.kind === 'sprite') {
      csprites.push({ x: e.x, y: e.y, image: e.image, scale: e.scale ?? 1, ...(e.r ? { r: e.r } : {}), ...(e.fx ? { fx: true } : {}), ...(e.fy ? { fy: true } : {}) });
    }
  }
  return { placed, freeSpikes, signs, triggers, csprites, xspawns };
}

// gridOf(layerName) -> { mats } - the level data, for the matrix each run cell uses.
export function toV1State(map, gridOf, vineSprites) {
  const ed = map.editor || {};
  const meta = ed.meta || {};
  const g = map.groups?.[0] || { objects: [] };
  const lo = map.levelOrigin || [0, OFFSET_Y];
  const ox = lo[0], oy = lo[1];
  const back = (p) => ({ x: (p?.x ?? 0) + ox, y: (p?.y ?? 0) + oy });

  const { placed, freeSpikes, signs, triggers, csprites, xspawns } = convertEntities(ed.entities);
  const courses = (g.courses || []).map((c) => ({
    id: c.id,
    start: { x: c.startX + ox, y: c.startY + oy },
    end: { x: c.endX + ox, y: c.endY + oy },
    screen: { x: c.screenX + ox, y: c.screenY + oy },
    reward: c.reward || { currency: 'Cash', amount: 0 },
    ...(c.resets?.length ? { resets: c.resets.map((r) => ({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h, dx: r.dx, dy: r.dy })) } : {}),
  }));

  const converted = convertTiles(map, gridOf, isVineSprite(vineSprites || []));
  const state = {
    version: 1,
    name: map.name || meta.name || '',
    description: map.description || meta.description || '',
    // A v2 map always carries its own tiles, so there is no "edits the base map" mode.
    useBase: false,
    baseState: map.areaState || meta.levelState || 'start',
    blocks: {}, spikes: {}, moss: converted.moss, ...converted, arrows: [],
    placed, freeSpikes, signs, triggers, csprites, xspawns,
    cellGroups: ed.cellGroups || {}, hiddenGroups: meta.hiddenGroups || [], assets: meta.assets || [],
    removed: [], removedVines: [], removedObjects: [], removedScene: [], removedDeco: [],
    movedScene: {}, movedObjects: {}, levelOrder: {}, levelTf: {}, levelGroups: {},
    courses, baseEdits: {},
    spawn: meta.spawn ? back(meta.spawn) : (g.spawnX != null ? { x: g.spawnX + ox, y: g.spawnY + oy } : null),
    player: map.player || meta.player || { dashes: 1, airJumps: 1, wallJump: true, blockSwap: false, omniDash: false, zipMovers: true, refreshers: true, teleporters: true, cash: 0 },
    ownProgress: !!meta.ownProgress,
    music: map.music || 'level',
    background: map.background,
  };
  return state;
}