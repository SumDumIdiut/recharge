/** Drawing a resolved cell (tiling.ts): the one place that knows how a named tile, four quarters or a connector tile reach the canvas. */
import type { Atlas } from './atlas.js';
import type { Resolved } from './tiling.js';

// Connector tiles are composed once (a 32px canvas of the base tile with the copied pixels laid over it) and kept per atlas.
const composed = new WeakMap<Atlas, Map<string, HTMLCanvasElement | null>>();

function compose(atlas: Atlas, r: Extract<Resolved, { parts: unknown }>): HTMLCanvasElement | null {
  let cache = composed.get(atlas);
  if (!cache) composed.set(atlas, (cache = new Map()));
  if (cache.has(r.tile)) return cache.get(r.tile) as HTMLCanvasElement | null;
  let cv: HTMLCanvasElement | null = null;
  const base = atlas.source?.(r.base);
  if (base && typeof document !== 'undefined') {
    cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base.img, base.x, base.y, base.w, base.h, 0, 0, 32, 32);
    for (const [x, y, tile, sx, sy] of r.parts) {
      const src = atlas.source(tile);
      if (src) ctx.drawImage(src.img, src.x + sx, src.y + sy, 1, 1, x, y, 1, 1);
    }
  }
  cache.set(r.tile, cv);
  return cv;
}

/** Draw a resolved cell into the square (x, y, size). False when the sheet lacks the art (the caller may paint a stand-in). */
export function drawResolved(atlas: Atlas, ctx: CanvasRenderingContext2D, r: Resolved, x: number, y: number, size: number): boolean {
  if ('parts' in r) {
    const cv = compose(atlas, r);
    if (!cv) return atlas.draw(ctx, r.base, x, y, size);
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, x, y, size, size);
    ctx.imageSmoothingEnabled = prev;
    return true;
  }
  if ('tile' in r) return atlas.draw(ctx, r.tile, x, y, size);
  let ok = true;
  r.quarters.forEach((q, i) => { ok = atlas.draw(ctx, q, x, y, size, { quarter: i }) && ok; });
  return ok;
}
