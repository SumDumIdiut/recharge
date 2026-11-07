/** Drawing: a chunked picture cache of the painted cells, plus the grid and the course overlay. No editing logic. */
import type { Atlas } from './atlas.js';
import { CONTENT } from './content/index.js';
import { COURSE } from './content/course.js';
import type { ContentType, DrawEnv } from './content/types.js';
import type { Camera } from './core/camera.js';
import type { AmpMap } from './core/map.js';
import { dataLayer } from './core/layers.js';
import { CELL, cellKey, parseKey, type Cell } from './core/types.js';
import { drawBackdrop, type BackdropId } from './backdrop.js';

export const CHUNK = 16;
const CHUNK_PX = CHUNK * CELL;
const MAX_CHUNKS = 160;

const COLORS = {
  bg: '#101214', grid: 'rgba(249,255,228,0.07)', major: 'rgba(249,255,228,0.16)', axis: 'rgba(65,248,141,0.35)',
  start: '#41f88d', end: '#dc72ec', spawn: '#ffd24a',
};

const chunkOf = (x: number): number => Math.floor(x / CHUNK);

/** Draw the (non-live) content of cell (x, y) of every visible layer, bottom layer first. Shared by the chunk cache and the thumbnail renderer. */
export function drawCell(env: DrawEnv, map: AmpMap, x: number, y: number, sx: number, sy: number, size: number): void {
  const key = cellKey(x, y);
  for (const layer of map.layerDefs) {
    if (!layer.visible) continue;
    for (const c of CONTENT) {
      if (c.layer === COURSE || c.live) continue;
      const dl = dataLayer(c.layer, layer.id);
      const v = map.get(dl, key);
      if (v !== undefined) c.draw(env, map, x, y, v, sx, sy, size, dl);
    }
  }
}

/** Whether a cell has anything the cell picture draws. */
function hasCellContent(map: AmpMap, key: string): boolean {
  for (const layer of map.layerDefs) {
    if (!layer.visible) continue;
    for (const c of CONTENT) if (c.layer !== COURSE && !c.live && map.has(dataLayer(c.layer, layer.id), key)) return true;
  }
  return false;
}

/**
 * The live content (scenery, moving platforms): drawn entry by entry because it spills over its cell. `under` is what sits behind the
 * cell picture (background-role layers); `over` is the rest. `at` gives a cell's top-left corner in pixels.
 */
export function drawLive(env: DrawEnv, map: AmpMap, at: (x: number, y: number) => [number, number], size: number, phase: 'under' | 'over', view?: { x0: number; x1: number; y0: number; y1: number }, skip?: (c: ContentType) => boolean): void {
  for (const layer of map.layerDefs) {
    if (!layer.visible) continue;
    for (const c of CONTENT) {
      if (!c.live || skip?.(c)) continue;
      // scenery behind the ground: back layers, and the main layer's scenery too (the game draws it behind the tiles)
      if ((layer.role === 'back' || (c.behind === true && layer.role === 'main')) !== (phase === 'under')) continue;
      const dl = dataLayer(c.layer, layer.id);
      const data = map.layers[dl];
      if (!data) continue;
      for (const [key, v] of data) {
        const cell = parseKey(key);
        // spilling content (a long platform path) is kept if its cell is near the view
        if (view && (cell.x < view.x0 - 64 || cell.x > view.x1 + 64 || cell.y < view.y0 - 64 || cell.y > view.y1 + 64)) continue;
        const [sx, sy] = at(cell.x, cell.y);
        c.draw(env, map, cell.x, cell.y, v, sx, sy, size, dl);
      }
    }
  }
}

/** The painted cells in 16x16-cell pictures, redrawn only where a cell (or a neighbour: tiles autotile) changed. */
export class ChunkCache {
  private chunks = new Map<string, HTMLCanvasElement | null>();
  private atlas: Atlas;
  private map: AmpMap;
  drawn = 0;

  constructor(map: AmpMap, atlas: Atlas) {
    this.map = map;
    this.atlas = atlas;
  }

  setMap(map: AmpMap): void { this.map = map; this.chunks.clear(); }
  setAtlas(atlas: Atlas): void { this.atlas = atlas; this.chunks.clear(); }
  clear(): void { this.chunks.clear(); }

  /** A cell changed: its picture and its neighbours' are stale. */
  invalidate(x: number, y: number, r = 2): void {
    for (let dx = -r; dx <= r; dx += r) for (let dy = -r; dy <= r; dy += r) this.chunks.delete(chunkOf(x + dx) + ',' + chunkOf(y + dy));
  }

  private build(cx: number, cy: number): HTMLCanvasElement | null {
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    let any = false;
    for (let y = y0; y < y0 + CHUNK && !any; y++) for (let x = x0; x < x0 + CHUNK; x++) {
      if (hasCellContent(this.map, cellKey(x, y))) { any = true; break; }
    }
    if (!any) return null;
    const cv = document.createElement('canvas');
    cv.width = CHUNK_PX; cv.height = CHUNK_PX;
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;
    const env: DrawEnv = { ctx, atlas: this.atlas };
    for (let y = y0; y < y0 + CHUNK; y++) for (let x = x0; x < x0 + CHUNK; x++) drawCell(env, this.map, x, y, (x - x0) * CELL, (CHUNK - 1 - (y - y0)) * CELL, CELL);
    this.drawn++;
    return cv;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const v = cam.visible();
    const px = CHUNK_PX * cam.zoom;
    ctx.imageSmoothingEnabled = cam.zoom < 1;
    for (let cy = chunkOf(v.y0); cy <= chunkOf(v.y1); cy++) {
      for (let cx = chunkOf(v.x0); cx <= chunkOf(v.x1); cx++) {
        const id = cx + ',' + cy;
        let cv = this.chunks.get(id);
        if (cv === undefined) {
          cv = this.build(cx, cy);
          this.chunks.set(id, cv);
          if (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value as string);
        }
        if (!cv) continue;
        const [sx, sy] = cam.toScreen(cx * CHUNK * CELL, (cy + 1) * CHUNK * CELL);
        // snap to whole pixels so neighbouring chunks meet exactly
        const x0 = Math.round(sx), y0 = Math.round(sy), w = Math.round(sx + px) - x0, h = Math.round(sy + px) - y0;
        ctx.drawImage(cv, x0, y0, w, h);
      }
    }
  }
}

export function drawBackground(ctx: CanvasRenderingContext2D, cam: Camera, backdrop: BackdropId = 'none', parallax = true): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cam.width, cam.height);
  if (backdrop !== 'none') drawBackdrop(ctx, backdrop, cam.x, cam.y, cam.zoom, cam.width, cam.height, parallax);
}

export function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera): void {
  const px = CELL * cam.zoom;
  if (px < 6) return;
  const v = cam.visible();
  ctx.lineWidth = 1;
  for (let x = v.x0; x <= v.x1; x++) {
    ctx.strokeStyle = x === 0 ? COLORS.axis : x % 8 === 0 ? COLORS.major : COLORS.grid;
    const sx = Math.round(cam.toScreen(x * CELL, 0)[0]) + 0.5;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cam.height); ctx.stroke();
  }
  for (let y = v.y0; y <= v.y1; y++) {
    ctx.strokeStyle = y === 0 ? COLORS.axis : y % 8 === 0 ? COLORS.major : COLORS.grid;
    const sy = Math.round(cam.toScreen(0, y * CELL)[1]) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cam.width, sy); ctx.stroke();
  }
}

export { drawCourse } from './course-view.js';

/** The arrow tool's colours: where it starts, where it ends, its bends. */
export const COLORS_ARROW = { start: '#41f88d', end: '#dc72ec', bend: '#ffd9a8' };

/** A filled dot with a dark rim (the arrow tool's path markers). */
export function outlineDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** An outline of an area in map units (y up): the moss cell under the pointer. */
export function outlineArea(ctx: CanvasRenderingContext2D, cam: Camera, a: { x0: number; y0: number; x1: number; y1: number }, fill = 'rgba(249,255,228,0.14)', stroke = 'rgba(249,255,228,0.5)'): void {
  const [sx, sy] = cam.toScreen(a.x0, a.y1), [ex, ey] = cam.toScreen(a.x1, a.y0);
  ctx.fillStyle = fill;
  ctx.fillRect(sx, sy, ex - sx, ey - sy);
  ctx.strokeStyle = stroke;
  ctx.strokeRect(sx + 0.5, sy + 0.5, ex - sx - 1, ey - sy - 1);
}

/** A cell-sized highlight (hover, brush footprint). */
export function highlightCells(ctx: CanvasRenderingContext2D, cam: Camera, cells: Cell[], fill = 'rgba(249,255,228,0.18)', stroke = 'rgba(249,255,228,0.4)'): void {
  const px = CELL * cam.zoom;
  for (const c of cells) {
    const [sx, sy] = cam.toScreen(c.x * CELL, (c.y + 1) * CELL);
    ctx.fillStyle = fill;
    ctx.fillRect(sx, sy, px, px);
    ctx.strokeStyle = stroke;
    ctx.strokeRect(sx + 0.5, sy + 0.5, px - 1, px - 1);
  }
}
