/**
 * Moss: the level's own overgrowth, an autotiled overlay on the game's 64-unit moss grid (the original editor's moss tool). One 64x64 cell of
 * moss covers about 2x2 editor cells, is solid like ground, and is drawn over blocks and spikes. The sprite of a cell comes from its eight
 * neighbours through a rule table (autotilePick, as the game's own moss rule tile does it); the game does that itself, so a saved map only
 * lists where the moss is.
 *
 * A moss cell is stored under the editor cell its centre falls in (so every layer, bounds and cache routine that works in editor cells
 * keeps working); `mossCell` finds that cell from any editor cell the moss covers.
 */
import type { AmpMap } from '../core/map.js';
import { eachLayer, dataLayer } from '../core/layers.js';
import { CELL, cellKey, parseKey, type Cell, type Json } from '../core/types.js';
import { MOSS_SIZE, MOSS_TABLE, drawMossSprite } from '../moss-art.js';
import { autotilePick } from '../tiling.js';
import type { JsonSink } from './sink.js';
import { ampLayer, type Brush, type ContentType, type DrawEnv } from './types.js';

export const MOSS = 'moss';

/** The game's moss grid in level units (the original's layerGrid('moss')): origin of cell (0, 0) and cell size. */
export const MOSS_GRID = { ox: -16184, oy: -3376, size: MOSS_SIZE };
/** The editor's level origin: a map cell row sits this far above the level's y (EditorOffsetY). */
export const LEVEL_OFFSET_Y = 9;

export interface MossGridCell { gx: number; gy: number }

/** The moss grid cell that covers the middle of editor cell (x, y) (original mossKeyAt). */
export function mossGridOf(x: number, y: number): MossGridCell {
  const g = MOSS_GRID;
  return { gx: Math.floor((x * CELL + CELL / 2 - g.ox) / g.size), gy: Math.floor((y * CELL + CELL / 2 + LEVEL_OFFSET_Y - g.oy) / g.size) };
}

/** The middle of a moss grid cell in the map's own units (y up), as the file stores it (original mossCenter, minus the level origin). */
export function mossCentre(gx: number, gy: number): { x: number; y: number } {
  const g = MOSS_GRID;
  return { x: Math.round(g.ox + (gx + 0.5) * g.size), y: Math.round(g.oy + (gy + 0.5) * g.size - LEVEL_OFFSET_Y) };
}

/** The editor cell a moss grid cell is stored under: the one its centre is in. */
export function mossStoreCell(gx: number, gy: number): Cell {
  const c = mossCentre(gx, gy);
  return { x: Math.floor(c.x / CELL), y: Math.floor(c.y / CELL) };
}

/** The editor cell that moss covering editor cell (x, y) is stored under. */
export function mossCell(x: number, y: number): Cell {
  const g = mossGridOf(x, y);
  return mossStoreCell(g.gx, g.gy);
}

/** The moss grid cell of a stored key. */
export function mossGridOfKey(key: string): MossGridCell {
  const c = parseKey(key);
  return mossGridOf(c.x, c.y);
}

/** The moss rectangle of a grid cell in map units, y up: where the hover and selection outline go (original mossRect). */
export function mossRect(gx: number, gy: number): { x0: number; y0: number; x1: number; y1: number } {
  const g = MOSS_GRID, x0 = g.ox + gx * g.size, y0 = g.oy + gy * g.size - LEVEL_OFFSET_Y;
  return { x0, y0, x1: x0 + g.size, y1: y0 + g.size };
}

const hasMoss = (map: AmpMap, dl: string, gx: number, gy: number): boolean => {
  const c = mossStoreCell(gx, gy);
  return map.has(dl, cellKey(c.x, c.y));
};

/** The sprite (number in art/moss.png) of a moss cell, from its neighbours in the same layer (original mossSprite). */
export function mossSprite(map: AmpMap, dl: string, gx: number, gy: number): number | null {
  return autotilePick(MOSS_TABLE, (x, y) => hasMoss(map, dl, x, y), gx, gy);
}

/** Whether moss covers editor cell (x, y), in a layer that is part of the playfield (original mossCovers): moss is solid. */
export function mossCovers(map: AmpMap, x: number, y: number): boolean {
  const c = mossCell(x, y), key = cellKey(c.x, c.y);
  for (const { layer, data } of eachLayer(map, MOSS)) if (layer.role === 'main' && data.has(key)) return true;
  return false;
}

/**
 * Whether the moss under editor cell (x, y) is gone: the original used it for the level's own moss, which a map can erase cell by cell.
 * A map here has no level moss, so moss is only ever there or not.
 */
export function mossErased(map: AmpMap, x: number, y: number): boolean {
  return !mossCovers(map, x, y);
}

const brush: Brush = { id: 'moss', label: 'Moss', group: 'Overgrowth', thumb: { moss: true, color: '#3f5a3a' } };

export const moss: ContentType = {
  id: 'moss',
  label: 'Moss',
  layer: MOSS,
  roles: ['main', 'front'],
  exclusive: false,
  live: true,
  brushes: [brush],
  place: () => true,
  brushOf: (value) => (value === true ? { brush } : null),
  options: () => [],
  cellOf: (x, y) => mossCell(x, y),
  outline: (x, y) => { const g = mossGridOf(x, y); return mossRect(g.gx, g.gy); },
  draw(env: DrawEnv, map: AmpMap, x, y, _value, sx, sy, size, dl) {
    const g = mossGridOfKey(cellKey(x, y)), c = mossCentre(g.gx, g.gy), k = size / CELL, side = MOSS_SIZE * k;
    // the centre in map units -> pixels relative to the stored cell's own corner (y up -> y down)
    const px = sx + (c.x - x * CELL) * k - side / 2, py = sy + size - (c.y - y * CELL) * k - side / 2;
    const n = mossSprite(map, dl, g.gx, g.gy);
    if (n === null || !drawMossSprite(env.ctx, n, Math.round(px), Math.round(py), Math.round(side))) {
      env.ctx.fillStyle = '#3f5a3a';
      env.ctx.fillRect(px, py, side, side);
    }
  },
  toJson(map, sink: JsonSink) {
    for (const { data } of eachLayer(map, MOSS)) {
      for (const key of [...data.keys()].sort()) {
        const g = mossGridOfKey(key), c = mossCentre(g.gx, g.gy);
        // the game's moss tilemap is a rule tile: it only needs to know which of its cells are filled
        sink.objects.push({ type: 'tile', tilemap: 'moss', tileName: 'Moss', x: c.x, y: c.y, matrix: [1, 0, 0, 1], amp: true });
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, MOSS);
    if (pairs) { for (const [k, v] of pairs) if (v === true) map.layer(MOSS).set(k, true); return; }
    // a map made elsewhere: its moss tiles, by position
    const group = (Array.isArray(json.groups) ? json.groups[0] : null) as { objects?: Array<Record<string, unknown>> } | null;
    const g = MOSS_GRID;
    for (const o of group?.objects || []) {
      if (!o || o.type !== 'tile' || o.tilemap !== 'moss' || typeof o.x !== 'number' || typeof o.y !== 'number') continue;
      const c = mossStoreCell(Math.floor((o.x - g.ox) / g.size), Math.floor((o.y + LEVEL_OFFSET_Y - g.oy) / g.size));
      map.layer(MOSS).set(cellKey(c.x, c.y), true);
    }
  },
};

export const mossLayerId = (layerId: string): string => dataLayer(MOSS, layerId);
