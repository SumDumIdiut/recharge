// The Hitboxes overlay's geometry for the user's own things, kept apart from the canvas so it can be tested.

// Which tilemap a placed block kind lands on in the game, and whether that tilemap has a collider
// (TilemapCollider2D + CompositeCollider2D). Illusory walls, backgrounds and the breakable-ground art are walk-through.
export function solidGroup(kind, sets = {}) {
  if (kind === 'ground' || kind === 'dark') return 'ground';
  if (kind === 'blue' || kind === 'orange') return kind;
  const layer = sets[kind]?.layer;
  if (layer === 'ground') return 'ground';
  if (layer === 'blueBlocks') return 'blue';
  if (layer === 'orangeBlocks') return 'orange';
  return null;
}

// The merged outline of a set of cells ("cx,cy" keys): one closed polygon per connected edge loop, in cell-corner
// coordinates (x right, y up, the cell cx,cy spanning cx..cx+1 and cy..cy+1), collinear points dropped.
export function outlineLoops(keys) {
  const cells = new Set(keys);
  const has = (x, y) => cells.has(x + ',' + y);
  const out = new Map(); // "x,y" -> list of [x, y] it leads to
  const edge = (a, b) => { const k = a.join(','); (out.get(k) || out.set(k, []).get(k)).push(b); };
  for (const k of cells) {
    const [x, y] = k.split(',').map(Number);
    if (!has(x, y - 1)) edge([x, y], [x + 1, y]);
    if (!has(x + 1, y)) edge([x + 1, y], [x + 1, y + 1]);
    if (!has(x, y + 1)) edge([x + 1, y + 1], [x, y + 1]);
    if (!has(x - 1, y)) edge([x, y + 1], [x, y]);
  }
  // Sort adjacency lists by angle for deterministic walk order (independent of cell insertion order).
  for (const [k, list] of out) {
    const [cx, cy] = k.split(',').map(Number);
    list.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  }
  const loops = [];
  for (const [k0, list0] of out) {
    while (list0.length) {
      const start = k0.split(',').map(Number), pts = [start];
      let cur = list0.pop();
      let from = start;
      while (cur[0] !== start[0] || cur[1] !== start[1]) {
        pts.push(cur);
        const list = out.get(cur.join(','));
        // At a pinch corner (multiple continuations) take the left-most turn so touching cells stay separate shapes.
        // If only one continuation exists (normal convex/concave corner), take it directly.
        const dx = cur[0] - from[0], dy = cur[1] - from[1];
        let i = -1;
        if (list.length === 1) {
          i = 0; // only one way to go
        } else {
          i = list.findIndex((n) => (n[0] - cur[0]) * -dy + (n[1] - cur[1]) * dx > 0); // left turn
          if (i < 0) i = list.findIndex((n) => (n[0] - cur[0]) * dx + (n[1] - cur[1]) * dy > 0); // straight
        }
        if (i < 0) {
          // Malformed edge graph: no valid continuation at a pinch corner. This should not happen for valid cell sets.
          // Throw to surface the problem instead of picking arbitrarily (which was insertion-order dependent).
          throw new Error(`outlineLoops: malformed loop at ${cur.join(',')} from ${from.join(',')} (no valid continuation, ${list.length} options)`);
        }
        from = cur;
        cur = list.splice(i, 1)[0];
      }
      const n = pts.length, keep = pts.filter((p, i) => {
        const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
        return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
      });
      loops.push(keep);
    }
  }
  return loops;
}

// A collider shape (list of polygons) through a 2x2 matrix [a, b, c, d], as the game's spike does.
export const turnShape = (shape, m) => shape.map((poly) => poly.map(([x, y]) => [m[0] * x + m[1] * y, m[2] * x + m[3] * y]));
export function shapeBounds(shape) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of shape) for (const [x, y] of poly) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
}
