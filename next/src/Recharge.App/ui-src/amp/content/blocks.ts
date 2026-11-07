/** Ground and coloured blocks: autotiled from their neighbours with the game's own tiles (see tiling.ts). */
import type { AmpMap } from '../core/map.js';
import { eachLayer, dataLayer } from '../core/layers.js';
import { cellKey, parseKey, type Cell, type Json } from '../core/types.js';
import { TILESETS, quarterTileName, resolveCell, tileSet, type Resolved } from '../tiling.js';
import { drawResolved } from '../tileart.js';
import { mossCovers } from './moss.js';
import { IDENTITY, type JsonSink } from './sink.js';
import { ampLayer, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const BLOCKS = 'blocks';

const GROUPS: Record<string, string> = { ground: 'Ground', blueBlocks: 'Colour swap', orangeBlocks: 'Colour swap', Ilusorywalls: 'Walk-through', OvergrowthDestroyedGround: 'Special' };
/** Walk-through tilemaps: the player passes them. */
const WALK_THROUGH = new Set(['Ilusorywalls']);

/** The game tilemap a set paints on in a layer of this role: the background layer's blocks go on the walk-through Background tilemap. */
export const tilemapFor = (setId: string, role: string): string => (role === 'back' ? 'Background' : tileSet(setId).tilemap);

/** The art of one painted cell: neighbours count when they are blocks of the same tilemap in the same layer. */
export function resolveAt(map: AmpMap, x: number, y: number, dl: string = BLOCKS): Resolved | null {
  const id = map.get(dl, cellKey(x, y)) as string | undefined;
  if (id === undefined) return null;
  const set = tileSet(id);
  return resolveCell(
    set,
    (dx, dy) => {
      const n = map.get(dl, cellKey(x + dx, y + dy)) as string | undefined;
      return n !== undefined && tileSet(n).tilemap === set.tilemap;
    },
    (dx, dy) => {
      const n = map.get(dl, cellKey(x + dx, y + dy)) as string | undefined;
      return n === undefined ? null : tileSet(n).plate.style || null;
    },
  );
}

/** Whether a cell is solid for the simulation: a block of a main layer that is not walk-through. */
export function solidAt(map: AmpMap, x: number, y: number): boolean {
  const key = cellKey(x, y);
  for (const { layer, data } of eachLayer(map, BLOCKS)) {
    if (layer.role !== 'main') continue;
    const id = data.get(key) as string | undefined;
    if (id !== undefined && !WALK_THROUGH.has(tileSet(id).tilemap)) return true;
  }
  return mossCovers(map, x, y);
}

const setChoices = TILESETS.map((t) => ({ value: t.id, label: t.label }));
const setOption: OptionDef = {
  key: 'set', label: 'Tile set', type: 'select', choices: setChoices,
  hint: 'Blue and orange blocks swap solidity; illusory walls can be walked through; breakable ground breaks.',
  get: (v) => v,
  set: (_v, x) => String(x),
};

export const blocks: ContentType = {
  id: 'blocks',
  label: 'Blocks',
  layer: BLOCKS,
  roles: ['main', 'back'],
  exclusive: true,
  brushes: TILESETS.map((t): Brush => ({ id: t.id, label: t.label, group: GROUPS[t.tilemap] || t.tilemap, thumb: { set: t.id } })),
  place: (brush) => brush.id,
  brushOf: (value) => {
    const b = blocks.brushes.find((x) => x.id === value);
    return b ? { brush: b } : null;
  },
  options: () => [setOption],
  draw(env: DrawEnv, map, x, y, _value, sx, sy, size, dl) {
    const r = resolveAt(map, x, y, dl);
    if (!r) return;
    const px = Math.round(sx), py = Math.round(sy), s = Math.round(sx + size) - px;
    if (!drawResolved(env.atlas, env.ctx, r, px, py, s)) fallback(env, px, py, s);
  },
  toJson(map, sink: JsonSink) {
    for (const { layer, data, id: dl } of eachLayer(map, BLOCKS)) {
      const keys = [...data.keys()].map((k) => ({ ...parseKey(k), key: k }));
      keys.sort((a, b) => a.y - b.y || a.x - b.x);
      for (const c of keys) {
        const set = tileSet(data.get(c.key) as string);
        const tilemap = tilemapFor(set.id, layer.role);
        const r = resolveAt(map, c.x, c.y, dl) as Resolved;
        if ('parts' in r) {
          // an inside corner on an edge / centre cell: the tile with pixels of its two neighbouring edge tiles copied in (MapTiles.cs WithPixels)
          sink.objects.push({
            type: 'tile', tilemap, tileName: r.tile, cellX: c.x, cellY: c.y, matrix: [...IDENTITY],
            spriteFrom: { ref: r.base, base: r.base, pixels: r.parts }, amp: true,
          });
        } else if ('tile' in r) sink.tile(tilemap, r.tile, c.x, c.y);
        else {
          // a name alone cannot say "four quarters of other tiles", so these go as tile objects
          sink.objects.push({
            type: 'tile', tilemap, tileName: quarterTileName(set.family, r.quarters), cellX: c.x, cellY: c.y, matrix: [...IDENTITY],
            spriteFrom: { ref: r.ref, quarters: r.quarters }, amp: true,
          });
        }
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, BLOCKS);
    if (pairs) { for (const [k, v] of pairs) if (TILESETS.some((t) => t.id === v)) map.layer(BLOCKS).set(k, v); return; }
    // version 1 files: sets of [y, x, ...] pairs
    const amp = json.amp as { sets?: Record<string, number[]> } | undefined;
    if (amp?.sets) {
      for (const [set, p] of Object.entries(amp.sets)) {
        if (!TILESETS.some((t) => t.id === set)) continue;
        for (let i = 0; i + 1 < p.length; i += 2) map.layer(BLOCKS).set(cellKey(p[i + 1], p[i]), set);
      }
      return;
    }
    // a map made elsewhere: whatever ground tiles it names, drawn as plate
    for (const c of groundCells(json)) map.layer(BLOCKS).set(cellKey(c.x, c.y), 'plate');
  },
};

export const blockLayerId = (layerId: string): string => dataLayer(BLOCKS, layerId);

function fallback(env: DrawEnv, x: number, y: number, s: number): void {
  env.ctx.fillStyle = '#55584f';
  env.ctx.fillRect(x, y, s, s);
}

/** Cells of ground tiles named in a game map file (tileLayers, and `tile` objects), for maps that carry no `amp` block. */
export function groundCells(json: Json): Cell[] {
  const out: Cell[] = [];
  const isGround = (n: unknown): boolean => typeof n === 'string' && n.startsWith('ground1_tileset_');
  for (const layer of (Array.isArray(json.tileLayers) ? json.tileLayers : []) as Array<{ tilemap?: string; names?: string[]; runs?: number[] }>) {
    const names = layer.names || [];
    const r = layer.runs || [];
    for (let i = 0; i + 4 < r.length; i += 5) {
      if (!isGround(names[r[i + 3]])) continue;
      for (let n = 0; n < r[i + 2]; n++) out.push({ x: r[i + 1] + n, y: r[i] });
    }
  }
  const group = (Array.isArray(json.groups) ? json.groups[0] : null) as { objects?: Array<Record<string, unknown>> } | null;
  for (const o of group?.objects || []) {
    if (o && o.type === 'tile' && isGround(o.tileName) && typeof o.cellX === 'number' && typeof o.cellY === 'number') out.push({ x: o.cellX as number, y: o.cellY as number });
  }
  return out;
}
