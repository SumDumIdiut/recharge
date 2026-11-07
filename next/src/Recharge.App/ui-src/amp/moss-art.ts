/**
 * Moss art: the level's own moss sprites (64x64, the game's "Moss" rule tile) cut from the original editor's tile sheet into art/moss.png,
 * and the rule table that picks one from a cell's eight neighbours (the original's art.autotiles.moss). Sprite numbers are positions in the
 * sheet, 7 per row. Moss lives on the game's own 64-unit moss grid, not on the 32-unit cells.
 */

export const MOSS_SIZE = 64;
const COLS = 7;

/** neighbour mask (tiling.ts AROUND bits) -> sprite number in art/moss.png. From the original's basemap autotiles.moss. */
export const MOSS_TABLE: Record<number, number> = {
  1: 0, 4: 3, 5: 23, 7: 7, 16: 2, 17: 1, 20: 5, 23: 33, 28: 11, 29: 20, 31: 9, 64: 6, 65: 4, 68: 26, 71: 32, 80: 24, 92: 29, 95: 28,
  112: 12, 113: 30, 116: 27, 119: 31, 124: 15, 125: 21, 127: 16, 193: 8, 197: 25, 199: 13, 209: 22, 221: 34, 223: 17, 241: 10,
  247: 18, 253: 19, 255: 14,
};
/** The sprite shown for a lone full block of moss (the picker thumbnail). */
export const MOSS_FULL = MOSS_TABLE[255];

let image: HTMLImageElement | null = null;
let started = false;
let listeners: Array<() => void> = [];

/** Called when the moss sheet finishes loading (the editor repaints). */
export function onMossLoaded(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

export function mossImage(): HTMLImageElement | null {
  if (image) return image;
  if (!started && typeof Image !== 'undefined') {
    started = true;
    const img = new Image();
    img.onload = () => { image = img; for (const l of listeners) l(); };
    img.src = 'amp/art/moss.png';
  }
  return null;
}

/** Draw sprite `n` into the square (x, y) of side `size` (screen pixels). False while the sheet is loading. */
export function drawMossSprite(ctx: CanvasRenderingContext2D, n: number, x: number, y: number, size: number, alpha = 1): boolean {
  const img = mossImage();
  if (!img) return false;
  const prev = ctx.globalAlpha, smooth = ctx.imageSmoothingEnabled;
  ctx.globalAlpha = prev * alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, (n % COLS) * MOSS_SIZE, Math.floor(n / COLS) * MOSS_SIZE, MOSS_SIZE, MOSS_SIZE, x, y, size, size);
  ctx.imageSmoothingEnabled = smooth;
  ctx.globalAlpha = prev;
  return true;
}
