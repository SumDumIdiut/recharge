/** Spikes: one tile per cell on a game spike tilemap, in one of four directions. Value "kind:turn" (turn = quarter turns counter-clockwise from standing on the floor). */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import type { Json } from '../core/types.js';
import { cellKey, parseKey } from '../core/types.js';
import { solidAt } from './blocks.js';
import { mossCovers } from './moss.js';
import { rotMatrix, type JsonSink } from './sink.js';
import { ampLayer, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const SPIKES = 'spikes';

interface Kind { tilemap: string; label: string; color: string }

export const KINDS: Record<string, Kind> = {
  spike: { tilemap: 'Spikes', label: 'Spike', color: '#e5e5e5' },
  dark: { tilemap: 'Spikes', label: 'Dark spike', color: '#6a6d72' },
  blue: { tilemap: 'blueSpikes', label: 'Blue spike', color: '#5fa8ff' },
  orange: { tilemap: 'orangeSpikes', label: 'Orange spike', color: '#ffa04a' },
};

/**
 * The level's spike tiles: [tile, the direction it is drawn for (quarter turns counter-clockwise from standing on the floor), uses in the level].
 * The original editor read these from the level's tile definitions (base.defs) and how often the level uses each; a spike is drawn with the
 * most used tile of its direction. The dark spikes are the Spikes tilemap's own darker tiles.
 */
const DEFS: Record<string, Array<[string, number, number]>> = {
  spike: [['spike_tileset_0', 0, 1828], ['spike_tileset_6', 1, 1211], ['spike_tileset_5', 2, 200], ['spike_tileset_3', 3, 772], ['Spikes Tileset_4', 0, 21], ['Asset_Sheet_91', 0, 1]],
  dark: [['spike_tileset_8', 0, 22], ['spike_tileset_14', 1, 113], ['spike_tileset_13', 2, 12], ['spike_tileset_11', 3, 204]],
  blue: [['spike_tileset_16', 0, 39], ['spike_tileset_22', 1, 71], ['spike_tileset_21', 2, 3], ['spike_tileset_19', 3, 44]],
  orange: [['spike_tileset_24', 0, 32], ['spike_tileset_30', 1, 73], ['spike_tileset_27', 3, 38]],
};

/** A spike's direction: 0 up (on the floor), 1 left (on a right wall), 2 down (on the ceiling), 3 right (on a left wall); or 'a': it sits on whatever it touches. */
export type SpikeTurn = number | 'a';

export function parseSpike(value: unknown): { kind: string; turn: SpikeTurn } | null {
  if (typeof value !== 'string') return null;
  const c = value.indexOf(':');
  const kind = value.slice(0, c), t = value.slice(c + 1);
  if (!KINDS[kind]) return null;
  if (t === 'a') return { kind, turn: 'a' };
  const turn = +t;
  return turn >= 0 && turn <= 3 && Number.isInteger(turn) ? { kind, turn } : null;
}

/**
 * The tile and matrix that draw a spike of this kind facing this way (port of the original spikeTile): the most used tile drawn for that
 * direction, turned to fit; the facing-left spike uses the right-facing tile turned half a circle; a direction with no tile of its own
 * turns the floor spike.
 */
export function spikeTile(kind: string, turn: number): { tilemap: string; name: string; matrix: number[] } {
  const defs = DEFS[kind] || DEFS.spike;
  const best = (want: number): [string, number, number] | undefined => defs.filter((d) => d[1] === want).sort((a, b) => b[2] - a[2])[0];
  const d = (turn === 1 && best(3)) || best(turn) || best(0) || defs[0];
  return { tilemap: (KINDS[kind] || KINDS.spike).tilemap, name: d[0], matrix: rotMatrix(turn - d[1]) };
}

// ---- seating: which way an automatic spike points ----
const SEAT_DIR: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Whether a cell holds something a spike can sit on: a block or moss (original isSolid). */
const isSolid = (map: AmpMap, x: number, y: number): boolean => solidAt(map, x, y) || mossCovers(map, x, y);

/** The directions a spike at (x, y) can sit in: those with something solid behind it, floor first (original seats). */
export function seats(map: AmpMap, x: number, y: number): number[] {
  return [0, 2, 1, 3].filter((q) => isSolid(map, x + SEAT_DIR[q][0], y + SEAT_DIR[q][1]));
}

function neighbourTurn(map: AmpMap, dl: string, x: number, y: number): number | null {
  const s = parseSpike(map.get(dl, cellKey(x, y)));
  if (!s) return null;
  return typeof s.turn === 'number' ? s.turn : seats(map, x, y)[0] ?? 0;
}

/** The direction an automatic spike takes (original autoSpikeTurn): along a row of spikes that already sit one way, else on the floor-first surface it touches. */
export function autoSpikeTurn(map: AmpMap, dl: string, x: number, y: number): number {
  for (const [dx, dy] of [[1, 0], [-1, 0]]) { const n = neighbourTurn(map, dl, x + dx, y + dy); if (n === 0 || n === 2) return n; }
  for (const [dx, dy] of [[0, 1], [0, -1]]) { const n = neighbourTurn(map, dl, x + dx, y + dy); if (n === 1 || n === 3) return n; }
  const options = seats(map, x, y);
  if (!options.length) return 0;
  for (const q of options) {
    const along = q % 2 === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    if (along.some(([dx, dy]) => neighbourTurn(map, dl, x + dx, y + dy) === q)) return q;
  }
  return options[0];
}

/** The direction a spike really faces (original spikeTurn): its own, or the one it sits in. */
export const spikeTurn = (map: AmpMap, dl: string, x: number, y: number, s: { turn: SpikeTurn }): number => (typeof s.turn === 'number' ? s.turn : autoSpikeTurn(map, dl, x, y));

/** The deadly box of a spike in its cell, in cell-local units from the cell's middle (y up): the floor spike's box turned. From the game's spike tile shapes. */
export function spikeBox(turn: number): { x0: number; y0: number; x1: number; y1: number } {
  let b = { x0: -13, y0: -16, x1: 13, y1: 3 };
  for (let i = 0; i < turn; i++) b = { x0: -b.y1, y0: b.x0, x1: -b.y0, y1: b.x1 };
  return b;
}

const DIRECTIONS = [{ value: 'a', label: 'Auto (sits on what it touches)' }, { value: '0', label: 'Up (on the floor)' }, { value: '1', label: 'Left (on a right wall)' }, { value: '2', label: 'Down (on the ceiling)' }, { value: '3', label: 'Right (on a left wall)' }];

export const spikes: ContentType = {
  id: 'spikes',
  label: 'Spikes',
  layer: SPIKES,
  roles: ['main'],
  exclusive: true,
  brushes: Object.entries(KINDS).map(([id, k]): Brush => ({ id, label: k.label, group: 'Spikes', thumb: { tile: spikeTile(id, 0).name, color: k.color } })),
  place: (brush) => brush.id + ':a',
  brushOf: (value) => {
    const s = parseSpike(value);
    const b = s && spikes.brushes.find((x) => x.id === s.kind);
    return b ? { brush: b } : null;
  },
  options: (): OptionDef[] => [
    {
      key: 'kind', label: 'Variant', type: 'select', choices: Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label })),
      hint: 'Blue and orange spikes switch with the colour-swap blocks.',
      get: (v) => parseSpike(v)?.kind ?? 'spike',
      set: (v, x) => String(x) + ':' + (parseSpike(v)?.turn ?? 'a'),
    },
    {
      key: 'turn', label: 'Direction', type: 'select', choices: DIRECTIONS, hint: 'Which way the spike points (, and . turn it). Auto sits it on the floor, wall or ceiling it touches.',
      get: (v) => String(parseSpike(v)?.turn ?? 'a'),
      set: (v, x) => (parseSpike(v)?.kind ?? 'spike') + ':' + (x === 'a' ? 'a' : Number(x)),
    },
  ],
  rotate(value, by) {
    const s = parseSpike(value);
    return s ? s.kind + ':' + ((((s.turn === 'a' ? by : s.turn + by) % 4) + 4) % 4) : value;
  },
  draw(env: DrawEnv, map, x, y, value, sx, sy, size, dl) {
    const s = parseSpike(value);
    if (!s) return;
    const t = spikeTile(s.kind, spikeTurn(map, dl, x, y, s));
    if (!env.atlas.draw(env.ctx, t.name, sx, sy, size, { matrix: t.matrix as [number, number, number, number] })) {
      env.ctx.fillStyle = KINDS[s.kind].color;
      env.ctx.fillRect(sx + size * 0.25, sy + size * 0.25, size * 0.5, size * 0.5);
    }
  },
  toJson(map, sink: JsonSink) {
    for (const { data, id: dl } of eachLayer(map, SPIKES)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const s = parseSpike(value);
        if (!s) continue;
        const c = parseKey(key);
        const t = spikeTile(s.kind, spikeTurn(map, dl, c.x, c.y, s));
        sink.tile(t.tilemap, t.name, c.x, c.y, t.matrix);
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, SPIKES);
    if (pairs) for (const [k, v] of pairs) if (parseSpike(v)) map.layer(SPIKES).set(k, v);
  },
};
