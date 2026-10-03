// Guide arrows: a path of cells drawn with the level's own guide-line tiles, the way the level
// lays them out (no turned tiles): a ring around the first cell with its stub toward the path,
// straight pieces, box corners at the turns, and a neck on the last cell with the head beyond it.
export const ARROW_LAYER = 'environmentalObjects_front';
const LT = (n) => 'line_tileset_' + n;
const ID = [1, 0, 0, 1];
const key = (d) => d[0] + ',' + d[1];
// [dx, dy, tile] around the ring's centre, by the way the path leaves it.
const RING = {
  '1,0': [[-1, 1, 49], [0, 1, 50], [1, 1, 51], [-1, 0, 62], [0, 0, 63], [1, 0, 64], [-1, -1, 74], [0, -1, 75], [1, -1, 76]],
  '-1,0': [[-1, 1, 4], [0, 1, 5], [1, 1, 6], [-1, 0, 23], [0, 0, 24], [1, 0, 25], [-1, -1, 38], [0, -1, 39], [1, -1, 40]],
  '0,1': [[-1, 1, 46], [0, 1, 47], [1, 1, 48], [-1, 0, 59], [0, 0, 60], [1, 0, 61], [-1, -1, 71], [0, -1, 72], [1, -1, 73]],
};
// The tileset's spare down ring and right head don't line up: the up ring and left head mirrored.
const FLIP_Y = [1, 0, 0, -1], FLIP_X = [-1, 0, 0, 1];
RING['0,-1'] = RING['0,1'].map(([dx, dy, t]) => [dx, -dy, t, FLIP_Y]);
// [dx, dy, tile] from the neck (the last cell), by the way the path arrives.
const HEAD = {
  '0,1': [[0, 0, 41], [-1, 1, 26], [0, 1, 27], [1, 1, 28], [-1, 2, 7], [0, 2, 8], [1, 2, 9]],
  '0,-1': [[0, 0, 52], [-1, -1, 65], [0, -1, 66], [1, -1, 67], [-1, -2, 77], [0, -2, 78], [1, -2, 79]],
  '-1,0': [[0, 0, 70], [-1, 0, 69], [-2, 0, 68], [-2, 1, 53], [-1, 1, 54], [-2, -1, 80], [-1, -1, 81]],
};
// A turn joins two sides: the box corner that does.
HEAD['1,0'] = HEAD['-1,0'].map(([dx, dy, t]) => [-dx, dy, t, FLIP_X]);
const CORNER = { '1,0|0,-1': 16, '-1,0|0,-1': 19, '1,0|0,1': 55, '-1,0|0,1': 58 };
// Straight pieces: the level mixes these looks, one look along each stretch.
const ACROSS = [18, 57, 17, 56], UPDOWN = [34, 45, 33, 44];

// The arrow's tiles: [[x, y, tile, matrix]] on ARROW_LAYER's grid.
export function arrowTiles(cells) {
  const out = new Map(), c = cells, n = c.length;
  if (n < 2) return [];
  const put = (x, y, t, m = ID) => out.set(x + ',' + y, [x, y, LT(t), m]);
  const step = (i, j) => [Math.sign(c[j][0] - c[i][0]), Math.sign(c[j][1] - c[i][1])];
  let look = 0;
  for (let i = 1; i < n - 1; i++) {
    const back = step(i, i - 1), on = step(i, i + 1);
    if (!back[0] === !on[0]) put(...c[i], (on[0] ? ACROSS : UPDOWN)[look % 4]);
    else {
      const h = back[0] ? back : on, v = back[0] ? on : back;
      put(...c[i], CORNER[key(h) + '|' + key(v)]);
      look = (look * 7 + c[i][0] * 3 + c[i][1] * 5 + 1) & 0xff;
    }
  }
  for (const [dx, dy, t, m] of RING[key(step(0, 1))]) put(c[0][0] + dx, c[0][1] + dy, t, m);
  const e = c[n - 1];
  for (const [dx, dy, t, m] of HEAD[key(step(n - 2, n - 1))]) put(e[0] + dx, e[1] + dy, t, m);
  return [...out.values()];
}
// An arrow's tiles in the store swapped from its old path's to its new one's.
export function redrawArrow(store, oldCells, newCells) {
  for (const [x, y] of arrowTiles(oldCells || [])) store.put(ARROW_LAYER, x, y, 0);
  for (const [x, y, t, m] of arrowTiles(newCells || [])) store.setAt(ARROW_LAYER, x, y, t, m);
}
// One step at a time along the grid toward `g`, backing up over the path where it doubles back.
export function extendTo(cells, g) {
  for (let guard = 0; guard < 500; guard++) {
    const last = cells[cells.length - 1], dx = g[0] - last[0], dy = g[1] - last[1];
    if (!dx && !dy) break;
    const next = Math.abs(dx) >= Math.abs(dy) ? [last[0] + Math.sign(dx), last[1]] : [last[0], last[1] + Math.sign(dy)];
    const prev = cells[cells.length - 2];
    if (prev && prev[0] === next[0] && prev[1] === next[1]) cells.pop(); else cells.push(next);
  }
  return cells;
}
// An arrow drawn by an older editor: its old pieces around the ends cleared, then laid again.
export function relayArrow(store, cells) {
  if (cells.length < 2) return;
  for (const [ex, ey] of [cells[0], cells[cells.length - 1]]) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const v = store.cell(ARROW_LAYER, ex + dx, ey + dy);
    if (v && store.tileName(v).startsWith('line_tileset_')) store.put(ARROW_LAYER, ex + dx, ey + dy, 0);
  }
  redrawArrow(store, null, cells);
}
