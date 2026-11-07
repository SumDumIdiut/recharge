/**
 * Guide arrows: the old Amplifier's arrow tool. Drag across cells and an arrow follows the path - a circle where it starts, straight and
 * corner pieces along it, a head where you let go. The pieces are the game's own `line_tileset_N` tiles on the environmentalObjects_front
 * tilemap (old rebuildArrowTiles / arrowTiles, ported rule for rule), turned by quarter turns; they save as plain tiles of that tilemap.
 *
 * An arrow is one value stored on its first cell: the cells it passes, relative to that cell (so moving the arrow moves its key only).
 * Not ported: reading arrows back out of a file made elsewhere (a file made by this editor keeps them in its amp layers), and the
 * base-level requirement (the old editor needed the imported level's art; the tiles are in the new atlas).
 */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, cellKey, parseKey, type Cell } from '../core/types.js';
import { rotMatrix, type JsonSink } from './sink.js';
import { ampLayer, groupOption, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const ARROWS = 'arrows';
export const ARROW_TILEMAP = 'environmentalObjects_front';
export type Step = [number, number];
export interface Arrow { cells: Step[]; group?: string }
export interface ArrowTile { tile: string; q: number }

const ARROW_CORNER: Record<string, number> = { '1,0|0,-1': 16, '-1,0|0,-1': 19, '-1,0|0,1': 58, '1,0|0,1': 55 };
const ARROW_CIRCLE: Array<[number, number, number]> = [[-1, 1, 49], [0, 1, 50], [1, 1, 51], [-1, 0, 62], [0, 0, 63], [1, 0, 64], [-1, -1, 74], [0, -1, 75], [1, -1, 76]];
const ARROW_HEAD_UP: Array<[number, number, number]> = [[-1, 0, 26], [0, 0, 27], [1, 0, 28], [-1, 1, 7], [0, 1, 8], [1, 1, 9]];
const ARROW_HEAD_DOWN: Array<[number, number, number]> = [[-1, 0, 65], [0, 0, 66], [1, 0, 67], [-1, -1, 77], [0, -1, 78], [1, -1, 79]];
const TURN_FROM_RIGHT: Record<string, number> = { '1,0': 0, '0,1': 1, '-1,0': 2, '0,-1': 3 };
const TURN_FROM_UP: Record<string, number> = { '0,1': 0, '-1,0': 1, '0,-1': 2, '1,0': 3 };
const turnOffset = (dx: number, dy: number, q: number): Step => { for (let i = 0; i < q; i++) [dx, dy] = [-dy, dx]; return [dx, dy]; };

/** The tile pieces of an arrow through these cells (absolute, y up): cell key -> tile and quarter turns. */
export function arrowTiles(c: ReadonlyArray<Readonly<Step>>): Map<string, ArrowTile> {
  const out = new Map<string, ArrowTile>(), n = c.length;
  if (n < 2) return out;
  const put = (gx: number, gy: number, tile: number, q = 0): void => { out.set(cellKey(gx, gy), { tile: 'line_tileset_' + tile, q }); };
  const step = (i: number, j: number): Step => [Math.sign(c[j][0] - c[i][0]), Math.sign(c[j][1] - c[i][1])];
  for (let i = 1; i < n - 1; i++) {
    const back = step(i, i - 1), on = step(i, i + 1);
    if (!back[0] === !on[0]) put(c[i][0], c[i][1], on[0] ? 18 : 34);
    else {
      const h = back[0] ? back : on, v = back[0] ? on : back;
      put(c[i][0], c[i][1], ARROW_CORNER[h.join(',') + '|' + v.join(',')]);
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

const isArrow = (v: unknown): v is Arrow => !!v && typeof v === 'object' && Array.isArray((v as Arrow).cells) && (v as Arrow).cells.length >= 2;

/** The cells of an arrow in the map (absolute), from its key. */
export const arrowCells = (key: string, a: Arrow): Step[] => { const o = parseKey(key); return a.cells.map(([x, y]) => [o.x + x, o.y + y] as Step); };

/** The arrow whose path passes through a cell, in one data layer: its key and value. */
export function arrowAt(map: AmpMap, dl: string, x: number, y: number): { key: string; value: Arrow } | null {
  const data = map.layers[dl];
  if (!data) return null;
  for (const [key, v] of data) {
    if (!isArrow(v)) continue;
    const o = parseKey(key);
    if (v.cells.some(([dx, dy]) => o.x + dx === x && o.y + dy === y)) return { key, value: v };
  }
  return null;
}

/** The path cells in the shape of the picker's thumbnail (a 7 x 7 grid, y up). */
export const THUMB_PATH: Step[] = [[1, 1], [2, 1], [3, 1], [4, 1], [4, 2], [4, 3], [4, 4]];

const brush: Brush = { id: 'arrow', label: 'Guide arrow', group: 'Paths', thumb: { arrow: true } };

/** Extend a path towards a target cell, one axis step at a time (the old arrowMove): stepping back onto the previous cell shortens it. Mutates `cells`. */
export function extendPath(cells: Step[], target: Cell): boolean {
  let changed = false;
  for (let guard = 0; guard < 500; guard++) {
    const last = cells[cells.length - 1], dx = target.x - last[0], dy = target.y - last[1];
    if (!dx && !dy) break;
    const next: Step = Math.abs(dx) >= Math.abs(dy) ? [last[0] + Math.sign(dx), last[1]] : [last[0], last[1] + Math.sign(dy)];
    const prev = cells[cells.length - 2];
    if (prev && prev[0] === next[0] && prev[1] === next[1]) cells.pop();
    else cells.push(next);
    changed = true;
  }
  return changed;
}

export const arrows: ContentType = {
  id: 'arrows',
  label: 'Guide arrows',
  layer: ARROWS,
  roles: ['main', 'front'],
  exclusive: false,
  live: true,
  brushes: [brush],
  place: () => ({ cells: [[0, 0], [1, 0]] }),
  brushOf: (value) => (isArrow(value) ? { brush } : null),
  cellOf(x, y, map, dl) { const hit = map && dl ? arrowAt(map, dl, x, y) : null; return hit ? parseKey(hit.key) : { x, y }; },
  options: (): OptionDef[] => [groupOption()],
  draw(env: DrawEnv, _map, x, y, value, sx, sy, size) {
    if (!isArrow(value)) return;
    const k = size / CELL;
    for (const [key, t] of arrowTiles(value.cells.map(([dx, dy]) => [dx, dy] as Step))) {
      const c = parseKey(key), m = rotMatrix(t.q);
      env.atlas.draw(env.ctx, t.tile, sx + c.x * CELL * k, sy - c.y * CELL * k, size, { matrix: [m[0], m[1], m[2], m[3]] });
    }
    void x; void y;
  },
  toJson(map, sink: JsonSink) {
    const seen = new Set<string>();
    for (const { data } of eachLayer(map, ARROWS)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (!isArrow(value)) continue;
        const o = parseKey(key);
        for (const [tk, t] of arrowTiles(value.cells)) {
          const c = parseKey(tk), at = cellKey(o.x + c.x, o.y + c.y);
          if (seen.has(at)) continue;
          seen.add(at);
          if (value.group) sink.objects.push({ type: 'tile', tilemap: ARROW_TILEMAP, tileName: t.tile, cellX: o.x + c.x, cellY: o.y + c.y, matrix: rotMatrix(t.q), group: value.group, amp: true });
          else sink.tile(ARROW_TILEMAP, t.tile, o.x + c.x, o.y + c.y, rotMatrix(t.q));
        }
      }
    }
  },
  fromJson(json, map) {
    const pairs = ampLayer(json, ARROWS);
    if (pairs) for (const [k, v] of pairs) if (isArrow(v)) map.layer(ARROWS).set(k, v);
  },
};
