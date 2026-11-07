/** The view: which level point is at the middle of the canvas, and how far in. Pure maths. */
import { CELL, type Cell } from './types.js';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 6;

export class Camera {
  x = 0;
  y = 160;
  zoom = 1.5;
  width = 800;
  height = 600;

  toScreen(x: number, y: number): [number, number] { return [(x - this.x) * this.zoom + this.width / 2, this.height / 2 - (y - this.y) * this.zoom]; }
  toLevel(sx: number, sy: number): [number, number] { return [(sx - this.width / 2) / this.zoom + this.x, (this.height / 2 - sy) / this.zoom + this.y]; }
  cellAt(sx: number, sy: number): Cell {
    const [x, y] = this.toLevel(sx, sy);
    return { x: Math.floor(x / CELL), y: Math.floor(y / CELL) };
  }
  /** Visible cell range, one cell of margin. */
  visible(): { x0: number; x1: number; y0: number; y1: number } {
    const [lx0, ly1] = this.toLevel(0, 0), [lx1, ly0] = this.toLevel(this.width, this.height);
    return { x0: Math.floor(lx0 / CELL) - 1, x1: Math.ceil(lx1 / CELL) + 1, y0: Math.floor(ly0 / CELL) - 1, y1: Math.ceil(ly1 / CELL) + 1 };
  }
  panBy(dxScreen: number, dyScreen: number): void { this.x -= dxScreen / this.zoom; this.y += dyScreen / this.zoom; }
  /** Zoom by a factor keeping the level point under (sx, sy) where it is. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const [bx, by] = this.toLevel(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.x = bx - (sx - this.width / 2) / this.zoom;
    this.y = by + (sy - this.height / 2) / this.zoom;
  }
  /** Frame a rectangle of cells (x1/y1 exclusive) with a margin of cells. */
  fitCells(x0: number, y0: number, x1: number, y1: number, margin = 3): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(this.width / ((x1 - x0 + margin) * CELL), this.height / ((y1 - y0 + margin) * CELL))));
    this.x = ((x0 + x1) / 2) * CELL;
    this.y = ((y0 + y1) / 2) * CELL;
  }
}
