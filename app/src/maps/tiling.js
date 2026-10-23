// The Amplifier's block autotiling, pure: which piece of a tilesheet a cell shows given its eight neighbours.
//
// Every block sheet is a `plate`: { TL T TR L C R BL B BR } tile numbers (a 3x3 panel), optionally
//   single        a lone cell
//   v: [top, middle, bottom]   a 1-wide column          h: [left, middle, right]   a 1-high row
// `has(dx, dy)` says whether the neighbour at that offset (y up, like the editor's cells) is part of the
// same tileset, level blocks and your own alike.
//
// The rule follows the game's own rule tiles (read from the level's tiles; see tests/amp-tiling.test.mjs):
//   no neighbour / a 1-wide run  -> the sheet's own single / v / h piece, or the quarters cut from the panel when it has none
//   one missing side             -> edge, two missing sides -> outer corner (diagonals are ignored there)
//   all four sides present       -> centre, with an inside corner (see INSIDE_QUARTER) in each quarter whose diagonal is empty
// and an edge or corner cell that also has an empty diagonal gets the inside quarter too. Cells with an inside corner
// are put together quarter-wise, like the 1-wide strips are.
// The sheet's own art comes first: a lone cell, a 1-wide column and a 1-wide row each have a piece of their own on some
// sheets, and those are the art the game draws. The quarters are the fallback for the sheets that have none: they are cut
// out of whole tiles, so they drift from the game by a pixel or two at every half-cell seam.

export const DIAGONALS = ['NE', 'SE', 'SW', 'NW'];

// What each quarter (TL, TR, BL, BR) of a cell shows when only its two touching sides count.
const quarterPiece = (v, h, vPiece, hPiece, both) => (!v && !h ? both : !v ? vPiece : !h ? hPiece : 'C');

// An inside corner has no tile of its own: the cell keeps its piece, and the quarter at the empty diagonal gets a
// connector built from the two neighbouring EDGE pieces (see connector()), so their bevel / rail lines run on round
// the concave corner. pickPieces reports which diagonals: { whole, holes: ['NE', ...] }.

// -> { whole: 'TL' | 'T' | ... | 'v1' ..., holes?: ['NE', ...] } or { quarters: [TL, TR, BL, BR piece keys] }.
export function pickPieces(plate, has) {
  const n = has(0, 1), e = has(1, 0), s = has(0, -1), w = has(-1, 0);
  const quarters = () => ({ quarters: [quarterPiece(n, w, 'T', 'L', 'TL'), quarterPiece(n, e, 'T', 'R', 'TR'), quarterPiece(s, w, 'B', 'L', 'BL'), quarterPiece(s, e, 'B', 'R', 'BR')] });
  // The sheet's own single / v / h piece when it has one, the quarters cut from the panel when it has not.
  if (!n && !e && !s && !w) return plate.single != null ? { whole: 'single' } : quarters();
  if ((n || s) && !e && !w) return plate.v ? { whole: 'v' + (!n ? 0 : !s ? 2 : 1) } : quarters();
  if ((e || w) && !n && !s) return plate.h ? { whole: 'h' + (!w ? 0 : !e ? 2 : 1) } : quarters();
  const row = !n ? 'T' : !s ? 'B' : '', col = !w ? 'L' : !e ? 'R' : '';
  const base = row + col || 'C';
  const holes = DIAGONALS.filter((d) => (d[0] === 'N' ? n : s) && (d[1] === 'E' ? e : w) && !has(d[1] === 'E' ? 1 : -1, d[0] === 'N' ? 1 : -1));
  return holes.length ? { whole: base, holes } : { whole: base };
}

// The pixels of an inside-corner connector at a cell's `hole` ('NE'...). The empty diagonal's two neighbours are edge
// pieces: the wall beside the gap (R piece for a gap to the east, L for west) and the floor under / over it (T for a
// gap to the north, B for south). A line d pixels in from the wall's outline runs down the wall, round the corner and
// on along the floor d pixels in from its outline; so in the cell's corner square a pixel u in from the wall plane and
// v in from the floor plane is on the line d = max(u, v): the wall's profile at u where u >= v, the floor's at v where
// v > u. The outline itself (d = 0) passes through the corner point. Pixels are copied from clean profile lines (no
// rivets or brick gaps) so the lines continue with no stray bits.
// vId / hId: those pieces' tile ids; vProf / hProf: [clean line index, thickness] from edgeprofiles.js.
// -> [[x, y, tile id, source x, source y], ...] in the cell's own 32px pixels, y down.
export function connector(hole, vId, hId, vProf, hProf) {
  const north = hole[0] === 'N', east = hole[1] === 'E';
  const tV = Math.min(28, vProf[1]), tH = Math.min(28, hProf[1]), out = [];
  for (let u = 0; u < 28; u++) for (let v = 0; v < 28; v++) {
    const c = east ? 31 - u : u, r = north ? v : 31 - v;
    if (u >= v) { if (u < tV) out.push([c, r, vId, c, vProf[0]]); } else if (v < tH) out.push([c, r, hId, hProf[0], r]);
  }
  return out;
}
export const connectorRoles = (hole) => ({ v: hole[1] === 'E' ? 'R' : 'L', h: hole[0] === 'N' ? 'T' : 'B' });

// The full table for a sheet, for tests and the sheet report: every blob of the eight neighbours -> its piece.
export function tableOf(plate) {
  const out = {};
  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, -1], [-1, 1]]; // N E S W NE SE SW NW
  for (let m = 0; m < 256; m++) {
    const on = new Set(dirs.filter((_, i) => m & (1 << i)).map((d) => d.join(',')));
    const r = pickPieces(plate, (dx, dy) => on.has(dx + ',' + dy));
    const [n, e, s, w] = [m & 1, m & 2, m & 4, m & 8];
    const diag = (o, a, b, bit) => (a && b && (m & bit) ? 1 : 0);
    const canon = [!!n, !!e, !!s, !!w, diag(0, n, e, 16), diag(0, s, e, 32), diag(0, s, w, 64), diag(0, n, w, 128)].map(Number).join('');
    out[canon] = r.quarters ? r.quarters.join('/') : r.whole + (r.holes ? '+' + r.holes.join('') : '');
  }
  return out;
}
