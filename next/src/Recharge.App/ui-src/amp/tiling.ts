/**
 * Amplifier autotiling, pure (no DOM): a faithful port of the original editor's tiling.js (pickPieces, connector) and of
 * its plateTile decisions (editor.js). Which tile of a sheet a cell shows, given which of its eight neighbours are solid:
 * a named tile, four quarters cut from named tiles, or - at an inside corner on an edge or centre cell - the tile with a
 * connector (pixels copied from the two neighbouring edge tiles, band widths from edgeprofiles.ts) so the bevel lines run on.
 *
 * A sheet is a "plate": { TL T TR L C R BL B BR } tile numbers (a 3x3 panel), optionally
 *   single       a lone cell          v: [top, middle, bottom]   a 1-wide column     h: [left, middle, right]   a 1-high row
 *   inner        the sheet's own inside-corner tiles, named for the corner whose diagonal is empty
 */

import { EDGE_PROFILE } from './edgeprofiles.js';

export type Corner = 'NE' | 'SE' | 'SW' | 'NW';
export const CORNERS: Corner[] = ['NE', 'SE', 'SW', 'NW'];

export interface Plate {
  TL: number; T: number; TR: number; L: number; C: number; R: number; BL: number; B: number; BR: number;
  single?: number;
  v?: [number, number, number];
  h?: [number, number, number];
  inner?: Record<Corner, number>;
  /** A rail / bevel sheet (a rail, bevel or bar along the top): its own inside-corner tile fits and a mitred connector is not drawn at a corner piece. */
  rail?: boolean;
  /** The ground sheets' two edge styles; a rail edge beside a plate edge along the same side is drawn as a merge tile (MERGE). */
  style?: 'plate' | 'rail';
}

export interface TileSet {
  id: string;
  label: string;
  /** Tile names are family + number (the game's "ground1_tileset_57"). */
  family: string;
  /** The game tilemap these tiles are painted on. */
  tilemap: string;
  plate: Plate;
}

/** The riveted plate (the game's ground). It has no strip pieces of its own, so a 1-wide run is cut from quarters. */
export const PLATE: Plate = { TL: 56, T: 57, TR: 58, L: 63, C: 64, R: 65, BL: 70, B: 71, BR: 72, inner: { NE: 66, SE: 59, SW: 60, NW: 67 }, style: 'plate' };
/** The bevelled panel: a lone cell, a 1-wide column and a 1-high row each have a tile of their own. */
export const PANEL: Plate = { TL: 1, T: 2, TR: 3, L: 9, C: 10, R: 11, BL: 17, B: 18, BR: 19, single: 0, v: [8, 16, 26], h: [27, 28, 29], inner: { NE: 14, SE: 6, SW: 7, NW: 15 }, rail: true, style: 'rail' };

/** The grate: its own strip pieces; not a rail sheet, so an inside corner gets a connector (as the original does). */
export const GRATE: Plate = { TL: 1, T: 2, TR: 3, L: 9, C: 10, R: 11, BL: 17, B: 18, BR: 19, single: 0, v: [8, 16, 24], h: [25, 26, 27], inner: { NE: 12, SE: 4, SW: 5, NW: 13 } };
/** A plain 3x3 sheet (the V2 plate): no strips, no inside corners; 1-wide runs are cut from quarters. */
export const PLATE3: Plate = { TL: 0, T: 1, TR: 2, L: 3, C: 4, R: 5, BL: 6, B: 7, BR: 8 };
/** FLOOR V2: the same 3x3 with a bar along the top. */
export const PLATE3_RAIL: Plate = { ...PLATE3, rail: true };

/** Every set the Amplifier offers, grouped for the picker. Sets on one tilemap join each other; blue and orange are colour-swap blocks. */
export const TILESETS: TileSet[] = [
  { id: 'plate', label: 'Plate', family: 'ground1_tileset_', tilemap: 'ground', plate: PLATE },
  { id: 'panel', label: 'Panel', family: 'ground1_tileset_', tilemap: 'ground', plate: PANEL },
  { id: 'darkplate', label: 'Dark plate', family: 'dark_ground_tileset_', tilemap: 'ground', plate: PLATE },
  { id: 'darkpanel', label: 'Dark panel', family: 'dark_ground_tileset_', tilemap: 'ground', plate: PANEL },
  { id: 'grate', label: 'Grate', family: 'gril_tileset_', tilemap: 'ground', plate: GRATE },
  { id: 'v2plate', label: 'V2 plate', family: 'TILE V2 Tileset_', tilemap: 'ground', plate: PLATE3 },
  { id: 'floorplate', label: 'Floor plate', family: 'FLOOR V2 Tileset_', tilemap: 'ground', plate: PLATE3_RAIL },
  { id: 'blue', label: 'Blue block', family: 'blue_ground_tileset_', tilemap: 'blueBlocks', plate: PANEL },
  { id: 'orange', label: 'Orange block', family: 'orange_ground_tileset_', tilemap: 'orangeBlocks', plate: PANEL },
  // walk-through ground (the game's illusory walls) and ground that breaks (the overgrowth's destroyed ground)
  { id: 'illusory', label: 'Illusory wall', family: 'ground1_tileset_', tilemap: 'Ilusorywalls', plate: PLATE },
  { id: 'breakable', label: 'Breakable', family: 'ground1_tileset_', tilemap: 'OvergrowthDestroyedGround', plate: PLATE },
];

export function tileSet(id: string): TileSet {
  return TILESETS.find((s) => s.id === id) || TILESETS[0];
}


// ---- the rule (tiling.js) ----

/** What pickPieces says: a whole piece key (optionally with inside-corner holes) or four quarter piece keys. */
export interface Pieces {
  whole?: string;
  holes?: Corner[];
  quarters?: string[];
}

type Has = (dx: number, dy: number) => boolean;

// What each quarter (TL, TR, BL, BR) of a cell shows when only its two touching sides count.
const quarterPiece = (v: boolean, h: boolean, vPiece: string, hPiece: string, both: string): string => (!v && !h ? both : !v ? vPiece : !h ? hPiece : 'C');

/**
 * `has(dx, dy)` says whether the neighbour at that offset (y up) is part of the same tileset.
 *   no neighbour / a 1-wide run  -> the sheet's own single / v / h piece, or the quarters cut from the panel when it has none
 *   one missing side             -> edge, two missing sides -> outer corner (diagonals are ignored there)
 *   all four sides present       -> centre, with an inside corner in each quarter whose diagonal is empty
 * An edge or corner cell that also has an empty diagonal reports the hole too (the connector is added by resolveCell).
 */
export function pickPieces(plate: Pick<Plate, 'single' | 'v' | 'h'>, has: Has): Pieces {
  const n = has(0, 1), e = has(1, 0), s = has(0, -1), w = has(-1, 0);
  const quarters = (): Pieces => ({ quarters: [quarterPiece(n, w, 'T', 'L', 'TL'), quarterPiece(n, e, 'T', 'R', 'TR'), quarterPiece(s, w, 'B', 'L', 'BL'), quarterPiece(s, e, 'B', 'R', 'BR')] });
  if (!n && !e && !s && !w) return plate.single != null ? { whole: 'single' } : quarters();
  if ((n || s) && !e && !w) return plate.v ? { whole: 'v' + (!n ? 0 : !s ? 2 : 1) } : quarters();
  if ((e || w) && !n && !s) return plate.h ? { whole: 'h' + (!w ? 0 : !e ? 2 : 1) } : quarters();
  const row = !n ? 'T' : !s ? 'B' : '', col = !w ? 'L' : !e ? 'R' : '';
  const base = row + col || 'C';
  const holes = CORNERS.filter((d) => (d[0] === 'N' ? n : s) && (d[1] === 'E' ? e : w) && !has(d[1] === 'E' ? 1 : -1, d[0] === 'N' ? 1 : -1));
  return holes.length ? { whole: base, holes } : { whole: base };
}

/** [x, y, tile number, source x, source y] in the cell's own 32px pixels, y down. */
export type ConnectorPixel = [number, number, number, number, number];

/**
 * The pixels of an inside-corner connector at a cell's `hole` ('NE'...). The empty diagonal's two neighbours are edge
 * pieces: the wall beside the gap (R piece for a gap to the east, L for west) and the floor under / over it (T for a gap
 * to the north, B for south). A line d pixels in from the wall's outline runs down the wall, round the corner and on along
 * the floor d pixels in from its outline; so in the cell's corner square a pixel u in from the wall plane and v in from the
 * floor plane is on the line d = max(u, v). Pixels are copied from clean profile lines (no rivets or brick gaps).
 * vProf / hProf: [clean line index, thickness] from edgeprofiles.ts.
 */
export function connector(hole: string, vId: number, hId: number, vProf: readonly [number, number], hProf: readonly [number, number]): ConnectorPixel[] {
  const north = hole[0] === 'N', east = hole[1] === 'E';
  const tV = Math.min(28, vProf[1]), tH = Math.min(28, hProf[1]);
  const out: ConnectorPixel[] = [];
  for (let u = 0; u < 28; u++) {
    for (let v = 0; v < 28; v++) {
      const c = east ? 31 - u : u, r = north ? v : 31 - v;
      if (u >= v) { if (u < tV) out.push([c, r, vId, c, vProf[0]]); } else if (v < tH) out.push([c, r, hId, hProf[0], r]);
    }
  }
  return out;
}
export const connectorRoles = (hole: string): { v: string; h: string } => ({ v: hole[1] === 'E' ? 'R' : 'L', h: hole[0] === 'N' ? 'T' : 'B' });

/** The full table for a sheet, for tests: every blob of the eight neighbours -> its piece. */
export function tableOf(plate: Plate): Record<string, string> {
  const out: Record<string, string> = {};
  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (let m = 0; m < 256; m++) {
    const on = new Set(dirs.filter((_, i) => m & (1 << i)).map((d) => d.join(',')));
    const r = pickPieces(plate, (dx, dy) => on.has(dx + ',' + dy));
    const [n, e, s, w] = [m & 1, m & 2, m & 4, m & 8];
    const diag = (a: number, b: number, bit: number): number => (a && b && (m & bit) ? 1 : 0);
    const canon = [!!n, !!e, !!s, !!w, diag(n, e, 16), diag(s, e, 32), diag(s, w, 64), diag(n, w, 128)].map(Number).join('');
    out[canon] = r.quarters ? r.quarters.join('/') : r.whole + (r.holes ? '+' + r.holes.join('') : '');
  }
  return out;
}

// ---- which tile(s) a cell shows (editor.js plateTile) ----

/** The resolved art of one cell: a named tile; four named quarters (top-left, top-right, bottom-left, bottom-right); or a tile with connector pixels copied in. */
export type Resolved =
  | { tile: string }
  | { quarters: [string, string, string, string]; ref: string }
  | { tile: string; base: string; parts: Array<[number, number, string, number, number]> };

function pieceNumber(plate: Plate, piece: string): number {
  if (piece === 'single') return plate.single as number;
  if (piece[0] === 'v' && piece.length === 2) return (plate.v as number[])[+piece[1]];
  if (piece[0] === 'h' && piece.length === 2) return (plate.h as number[])[+piece[1]];
  return plate[piece as keyof Plate] as number;
}

// Where a plate edge (tiles 56-72) turns into a rail edge on the ground sheets: the merge tiles (73-80). Read off the level:
// 73 sits between a plate top edge on its west and a rail top edge on its east, 74 the other way round, 77/78 the same on a
// bottom edge, 75/76 on a left / right edge with the plate above and the rail below, 79/80 with the rail above.
const MERGE_TILES: Record<string, Record<string, Record<string, number>>> = {
  ground1_tileset_: { T: { W: 73, E: 74 }, B: { W: 77, E: 78 }, L: { N: 75, S: 79 }, R: { N: 76, S: 80 } },
  dark_ground_tileset_: { T: { W: 73, E: 74 }, B: { W: 77, E: 78 }, L: { N: 75, S: 79 }, R: { N: 76, S: 80 } },
};
const MERGE_STEP: Record<string, [number, number]> = { W: [-1, 0], E: [1, 0], N: [0, 1], S: [0, -1] };
const OPEN_SIDE: Record<string, [number, number]> = { T: [0, 1], B: [0, -1], L: [-1, 0], R: [1, 0] };

/**
 * The art of a solid cell. `has(dx, dy)`: the neighbour is part of the same tilemap. `styleAt(dx, dy)`: the edge style of
 * that neighbour's sheet ('plate' | 'rail'), for the merge tiles; omit it to skip them.
 */
export function resolveCell(set: TileSet, has: Has, styleAt?: (dx: number, dy: number) => string | null): Resolved {
  const { plate, family } = set;
  const name = (p: number): string => family + p;
  const whole = (piece: string): Resolved => ({ tile: name(pieceNumber(plate, piece)) });
  const r = pickPieces(plate, has);

  // a rail edge beside a plate edge along the same side
  if (styleAt && plate.style === 'rail' && MERGE_TILES[family] && /^[TBLR]$/.test(r.whole || '') && !r.holes) {
    const [ox, oy] = OPEN_SIDE[r.whole as string];
    for (const [dir, tileNo] of Object.entries(MERGE_TILES[family][r.whole as string])) {
      const [dx, dy] = MERGE_STEP[dir], nx = dx, ny = dy, rx = -dx, ry = -dy;
      // only where the rail continues on the far side (plate | merge | rail): a lone rail cell between plates is an ordinary edge
      if (has(nx, ny) && styleAt(nx, ny) === 'plate' && !has(nx + ox, ny + oy) && has(rx, ry) && styleAt(rx, ry) === 'rail' && !has(rx + ox, ry + oy)) return { tile: name(tileNo) };
    }
    // a single rail cell between plates (plate | rail | plate): a cap
    const [a1, a2] = r.whole === 'T' || r.whole === 'B' ? [MERGE_STEP.W, MERGE_STEP.E] : [MERGE_STEP.N, MERGE_STEP.S];
    if (has(a1[0], a1[1]) && styleAt(a1[0], a1[1]) === 'plate' && !has(a1[0] + ox, a1[1] + oy) && has(a2[0], a2[1]) && styleAt(a2[0], a2[1]) === 'plate' && !has(a2[0] + ox, a2[1] + oy)) {
      return whole(r.whole === 'T' || r.whole === 'B' ? (plate.h && plate.h[0] ? 'h0' : 'TL') : (plate.v && plate.v[0] ? 'v0' : 'TL'));
    }
  }

  if (r.whole != null && r.holes) {
    const inner = (d: Corner): number | undefined => plate.inner?.[d];
    // a rail sheet's own inside-corner tile
    if (plate.rail && r.whole === 'C' && r.holes.length === 1 && inner(r.holes[0]) != null) return { tile: name(inner(r.holes[0]) as number) };
    // a rail sheet with no inside tile of its own (Floor plate) still gets the connector at a BOTTOM inside corner
    const railBottomOnly = plate.rail && r.whole === 'C' && !r.holes.some((d) => inner(d) != null) && r.holes.every((d) => d === 'SW' || d === 'SE');
    // corner pieces keep their rivets (and a rail has no line to join there)
    if (!/^[CTBLR]$/.test(r.whole) && (!plate.rail || !railBottomOnly)) return whole(r.whole);
    const baseTile = name(pieceNumber(plate, r.whole));
    const parts: Array<[number, number, string, number, number]> = [], tokens: string[] = [];
    for (const d of r.holes) {
      const role = connectorRoles(d), vId = pieceNumber(plate, role.v), hId = pieceNumber(plate, role.h);
      const vProf = EDGE_PROFILE[family + '|' + vId + '|' + role.v], hProf = EDGE_PROFILE[family + '|' + hId + '|' + role.h];
      if (!vProf || !hProf) continue;
      for (const [x, y, pid, sx, sy] of connector(d, vId, hId, vProf, hProf)) parts.push([x, y, name(pid), sx, sy]);
      tokens.push(d + vId + '.' + hId);
    }
    if (!tokens.length) return whole(r.whole);
    return { tile: baseTile + '+' + tokens.join('+'), base: baseTile, parts };
  }
  if (r.whole != null) return whole(r.whole);
  const names = (r.quarters as string[]).map((p) => name(pieceNumber(plate, p)));
  if (names.every((n) => n === names[0])) return { tile: names[0] };
  return { quarters: names as [string, string, string, string], ref: name(plate.C) };
}

/** The name the game gives a quarter-built tile (unique per combination, stable across saves). */
export function quarterTileName(family: string, quarters: string[]): string {
  return family + 'q' + quarters.map((q) => (q.startsWith(family) ? q.slice(family.length) : q)).join('_');
}

// ---- mask-table autotiles (moss, and vines later) ----
// Port of the original editor's autotilePick. The game's moss / vine tilemaps are rule tiles: a table from the 8-neighbour mask to the sprite
// to draw. Bit i of the mask is neighbour AROUND[i] (N, NE, E, SE, S, SW, W, NW; y up).
export const AROUND: Array<[number, number]> = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];

const bitCount = (n: number): number => { let c = 0; for (; n; n >>= 1) c += n & 1; return c; };

/** The neighbour mask of cell (x, y): a corner only counts when both sides next to it do. */
export function autotileMask(has: (x: number, y: number) => boolean, x: number, y: number): number {
  const bits = AROUND.map(([dx, dy]) => has(x + dx, y + dy));
  for (const c of [1, 3, 5, 7]) bits[c] = bits[c] && bits[c - 1] && bits[(c + 1) % 8];
  return bits.reduce((m, b, i) => (b ? m | (1 << i) : m), 0);
}

/**
 * The table entry for cell (x, y): the exact mask if the table has it, else the nearest one (a differing side costs 4, a differing corner 1).
 * `has(x, y)` says whether a cell is part of the same layer. Null when there is no table.
 */
export function autotilePick<T>(table: Record<number, T> | null | undefined, has: (x: number, y: number) => boolean, x: number, y: number): T | null {
  if (!table) return null;
  const mask = autotileMask(has, x, y);
  if (table[mask]) return table[mask];
  let best: T | null = null, score = Infinity;
  for (const [m, v] of Object.entries(table)) {
    const d = Number(m) ^ mask, sc = bitCount(d & 0b01010101) * 4 + bitCount(d & 0b10101010);
    if (sc < score) { score = sc; best = v; }
  }
  return best;
}
