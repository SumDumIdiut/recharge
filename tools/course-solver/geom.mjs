// Geometry helpers for the course solver: rectangles and a solid-cell grid.
//
// Pure: no DOM, no canvas, no engine. Everything here is testable in Node.

export const CELL = 32;

/** An axis-aligned box. `y` is the BOTTOM edge, and up is +y. */
export const rect = (x, y, w, h) => ({ x, y, w, h });

/** Do two boxes overlap? Touching edges do not count. */
export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Is the point inside the box? Bottom/left inclusive, top/right exclusive. */
export function contains(r, px, py) {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

const key = (cx, cy) => cx + ',' + cy;

/**
 * A grid of solid cells. The world is 32 units to a cell (the editor's CELL), and a cell is
 * solid or it is not; a box is solid if it touches any solid cell.
 */
export class SolidGrid {
  constructor(cell = CELL) {
    this.cell = cell;
    this.cells = new Set();
  }

  add(cx, cy) {
    this.cells.add(key(cx, cy));
  }

  /** Fill every cell that the box touches. */
  addRect(x, y, w, h) {
    const c = this.cell;
    const x0 = Math.floor(x / c);
    const x1 = Math.floor((x + w - 1e-6) / c);
    const y0 = Math.floor(y / c);
    const y1 = Math.floor((y + h - 1e-6) / c);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) this.add(cx, cy);
  }

  has(cx, cy) {
    return this.cells.has(key(cx, cy));
  }

  solidAt(x, y) {
    return this.has(Math.floor(x / this.cell), Math.floor(y / this.cell));
  }

  /** Does the box touch a solid cell? */
  hits(x, y, w, h) {
    const c = this.cell;
    const x0 = Math.floor(x / c);
    const x1 = Math.floor((x + w - 1e-6) / c);
    const y0 = Math.floor(y / c);
    const y1 = Math.floor((y + h - 1e-6) / c);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (this.has(cx, cy)) return true;
    return false;
  }

  get size() {
    return this.cells.size;
  }

  /** World-space bounds of every solid cell, or null when empty. */
  bounds() {
    if (!this.cells.size) return null;
    const c = this.cell;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const k of this.cells) {
      const [cx, cy] = k.split(',');
      const x = +cx * c, y = +cy * c;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + c > maxX) maxX = x + c;
      if (y + c > maxY) maxY = y + c;
    }
    return { minX, minY, maxX, maxY };
  }

  *iter() {
    const c = this.cell;
    for (const k of this.cells) {
      const [cx, cy] = k.split(',');
      yield { x: +cx * c, y: +cy * c, w: c, h: c };
    }
  }
}

/** The box that contains every input box, expanded by `pad`. */
export function unionBox(boxes, pad = 0) {
  const real = boxes.filter(Boolean);
  if (!real.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of real) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
