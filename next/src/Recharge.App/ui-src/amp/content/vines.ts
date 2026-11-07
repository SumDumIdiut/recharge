/**
 * Thorn vines: the original editor's vine tool. A vine is one picture (160 or 320 game units square) placed on a cell, centred on it, in one of
 * four quarter-turns; it is deadly inside its outline. It is NOT an autotiled run - the original had no chains, segments or neighbour rule for
 * vines - so it is a plain per-cell value "sprite:turn", drawn live (it spills far over its cell), and saved as one `tile` on the game's
 * OvergrowthSpikes tilemap named after the sprite, turned by the quarter-turn matrix (original vineTile / the tile export).
 */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, parseKey, type Json } from '../core/types.js';
import { VINES, onVineLoaded, vineImage, vineSprite } from '../vine-art.js';
import { rotMatrix, type JsonSink } from './sink.js';
import { ampLayer, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export { onVineLoaded };
export const VINE = 'vines';
/** The game tilemap the original wrote vines to (VINE_LAYER). */
export const VINE_TILEMAP = 'OvergrowthSpikes';
/** The sprite a new vine uses before another is picked (the original's draft.vineSprite default). */
export const DEFAULT_VINE = 'smallArc';

export function parseVine(value: unknown): { sprite: string; turn: number } | null {
  if (typeof value !== 'string') return null;
  const c = value.lastIndexOf(':');
  if (c < 0) return null;
  const sprite = value.slice(0, c), turn = +value.slice(c + 1);
  return vineSprite(sprite) && Number.isInteger(turn) && turn >= 0 && turn <= 3 ? { sprite, turn } : null;
}

export const vineValue = (sprite: string, turn: number): string => sprite + ':' + ((((turn % 4) + 4) % 4));

/** The vines the picker offers (the original hid the ones its catalog names null). */
const PICKABLE = VINES.filter((v) => v.label !== null);

const brushes: Brush[] = PICKABLE.map((v): Brush => ({ id: v.name, label: v.label as string, group: 'Thorn vines', thumb: { vine: v.name } }));

/** The quarter-turn matrix a vine's picture and outline are turned by (counter-clockwise, y up). */
export const vineMatrix = (turn: number): number[] => rotMatrix(turn);

const GRID = 8;
const boxCache = new Map<string, Array<{ x0: number; y0: number; x1: number; y1: number }>>();

function inside(poly: number[][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * The deadly area of a vine as boxes from the cell's middle (y up, game units): its outline turned and filled on an 8-unit grid, merged
 * into row runs. The sim's hazards are boxes; the vines' outlines are curls with open middles, so one bounding box would be unfair.
 */
export function vineBoxes(sprite: string, turn: number): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  const id = sprite + ':' + turn, hit = boxCache.get(id);
  if (hit) return hit;
  const v = vineSprite(sprite), m = vineMatrix(turn), out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  if (v) {
    const polys = v.shape.map((p) => p.map(([x, y]) => [m[0] * x + m[1] * y, m[2] * x + m[3] * y]));
    const r = v.size / 2;
    for (let gy = -r; gy < r; gy += GRID) {
      let start: number | null = null;
      for (let gx = -r; gx <= r; gx += GRID) {
        const on = gx < r && polys.some((p) => inside(p, gx + GRID / 2, gy + GRID / 2));
        if (on && start === null) start = gx;
        if (!on && start !== null) { out.push({ x0: start, y0: gy, x1: gx, y1: gy + GRID }); start = null; }
      }
    }
  }
  boxCache.set(id, out);
  return out;
}

export const vines: ContentType = {
  id: 'vines',
  label: 'Thorn vines',
  layer: VINE,
  roles: ['main', 'front'],
  exclusive: false,
  live: true,
  brushes,
  place: (brush) => vineValue(brush.id, 0),
  brushOf: (value) => {
    const v = parseVine(value);
    const b = v && brushes.find((x) => x.id === v.sprite);
    return b ? { brush: b } : null;
  },
  options: (): OptionDef[] => [
    {
      key: 'sprite', label: 'Vine', type: 'select', choices: VINES.map((v) => ({ value: v.name, label: v.label ?? v.name })),
      get: (v) => parseVine(v)?.sprite ?? DEFAULT_VINE,
      set: (v, x) => vineValue(String(x), parseVine(v)?.turn ?? 0),
    },
    {
      key: 'turn', label: 'Direction', type: 'select', hint: 'Quarter turns counter-clockwise (, and . turn it).',
      choices: [{ value: '0', label: 'Upright' }, { value: '1', label: 'Turned left' }, { value: '2', label: 'Upside down' }, { value: '3', label: 'Turned right' }],
      get: (v) => String(parseVine(v)?.turn ?? 0),
      set: (v, x) => vineValue(parseVine(v)?.sprite ?? DEFAULT_VINE, Number(x)),
    },
  ],
  rotate(value, by) {
    const v = parseVine(value);
    return v ? vineValue(v.sprite, v.turn + by) : value;
  },
  draw(env: DrawEnv, _map: AmpMap, _x, _y, value, sx, sy, size) {
    const v = parseVine(value);
    if (!v) return;
    const ctx = env.ctx, m = vineMatrix(v.turn), k = size / CELL, img = vineImage(v.sprite);
    if (!img) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    ctx.save();
    ctx.translate(sx + size / 2, sy + size / 2);
    ctx.transform(k * m[0], -k * m[2], -k * m[1], k * m[3], 0, 0);
    ctx.drawImage(img, -iw / 2, -ih / 2);
    ctx.restore();
  },
  toJson(map, sink: JsonSink) {
    for (const { data } of eachLayer(map, VINE)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const v = parseVine(value);
        if (!v) continue;
        const c = parseKey(key);
        sink.tile(VINE_TILEMAP, v.sprite, c.x, c.y, vineMatrix(v.turn));
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, VINE);
    if (pairs) { for (const [k, v] of pairs) if (parseVine(v)) map.layer(VINE).set(k, v); return; }
    // a map made elsewhere: vine tiles on the game's overgrowth tilemap (or the plain spike one), turned by their matrix
    const mats = (Array.isArray(json.mats) ? json.mats : []) as number[][];
    const turnOf = (m: number[] | undefined): number => { const t = [0, 1, 2, 3].find((q) => { const r = rotMatrix(q); return !!m && r.every((n, i) => n === m[i]); }); return t ?? 0; };
    for (const layer of (Array.isArray(json.tileLayers) ? json.tileLayers : []) as Array<{ tilemap?: string; names?: string[]; runs?: number[] }>) {
      if (layer.tilemap !== VINE_TILEMAP) continue;
      const names = layer.names || [], r = layer.runs || [];
      for (let i = 0; i + 4 < r.length; i += 5) {
        const name = names[r[i + 3]];
        if (!vineSprite(name)) continue;
        for (let n = 0; n < r[i + 2]; n++) map.layer(VINE).set(r[i + 1] + n + ',' + r[i], vineValue(name, turnOf(mats[r[i + 4]])));
      }
    }
  },
};
