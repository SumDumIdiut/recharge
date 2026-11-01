// A skin's picture from its sheet, ported from the current app (app/src/skin-thumb.js).
// The sheet is the Unity animator template: 6 rows (Idle, run, Fall, Jump, wallPose, Dash), a 2px gutter around and between
// cells, magenta guide lines in the gutters. The cell grid is derived the way the mod does it: cell = (size - 2) / count - 2.
// The frame shown is the first non-empty one (row 0 left to right, then the other rows), cropped to its visible pixels.

const GUTTER = 2;
const ROWS = 6;
const MIN_PIXELS = 24; // fewer visible pixels than this is an empty frame (stray dust)
const MIN_SIDE = 0.12; // a frame narrower or shorter than this share of its cell is a stray line, not a character

export interface Rect { x: number; y: number; w: number; h: number }

/** The guide-line test from GridSheet.IsGridLineColor, plus a looser one for the blurred edges of a guide line. */
export function isGuide(r: number, g: number, b: number, a: number): boolean {
  if (a <= 0) return false;
  if (Math.abs(r - 255) + g + Math.abs(b - 220) <= 60) return true;
  return r > 170 && b > 130 && g < 110 && r - g > 90 && b - g > 70;
}

/** Cells are roughly square, so the width gives the column count (the real template is 9 columns of 256px). */
export function gridFor(w: number, h: number): { cols: number; rows: number; cellW: number; cellH: number } | null {
  const cellH = (h - GUTTER) / ROWS - GUTTER;
  if (!(cellH >= 4)) return null;
  const cols = Math.max(1, Math.round((w - GUTTER) / (cellH + GUTTER)));
  const cellW = (w - GUTTER) / cols - GUTTER;
  if (!(cellW >= 4)) return null;
  return { cols, rows: ROWS, cellW, cellH };
}

/** Makes the region of (br,bg,bb)-coloured pixels connected to the border of [x0,x1) x [y0,y1) transparent, in place. */
export function keyOut(data: Uint8ClampedArray, w: number, x0: number, y0: number, x1: number, y1: number, br: number, bg: number, bb: number, tol = 30): void {
  const cw = x1 - x0, ch = y1 - y0;
  const seen = new Uint8Array(cw * ch);
  const stack: number[] = [];
  const near = (x: number, y: number): boolean => {
    const i = (y * w + x) * 4;
    return data[i + 3] > 0 && Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) <= tol;
  };
  const push = (x: number, y: number): void => {
    const k = (y - y0) * cw + (x - x0);
    if (!seen[k] && near(x, y)) { seen[k] = 1; stack.push(x, y); }
  };
  for (let x = x0; x < x1; x++) { push(x, y0); push(x, y1 - 1); }
  for (let y = y0; y < y1; y++) { push(x0, y); push(x1 - 1, y); }
  while (stack.length) {
    const y = stack.pop() as number, x = stack.pop() as number;
    data[(y * w + x) * 4 + 3] = 0;
    if (x > x0) push(x - 1, y);
    if (x < x1 - 1) push(x + 1, y);
    if (y > y0) push(x, y - 1);
    if (y < y1 - 1) push(x, y + 1);
  }
}

/** RGBA bytes → the first non-empty frame's visible pixels (plus a margin), or null. Keys a flat background out of `data` in place. */
/** The art in one cell (row, col) of a sheet, keyed and cropped to its visible pixels; null for an empty or non-character cell. */
export function cellArt(data: Uint8ClampedArray, w: number, h: number, row: number, col: number): Rect | null {
  const g = gridFor(w, h);
  if (!g || row >= g.rows || col >= g.cols) return null;
  const cx = GUTTER + col * (g.cellW + GUTTER), cy = GUTTER + row * (g.cellH + GUTTER);
  const x0 = Math.round(cx) + 1, y0 = Math.round(cy) + 1;
  const x1 = Math.min(w, Math.round(cx + g.cellW) - 1), y1 = Math.min(h, Math.round(cy + g.cellH) - 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const px = (x: number, y: number): number[] => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const corners = [px(x0, y0), px(x1 - 1, y0), px(x0, y1 - 1), px(x1 - 1, y1 - 1)];
  const [br, bg, bb, ba] = corners[0];
  // An opaque flat background (some skins are painted on white) is keyed out from the frame's border only,
  // so the same colour inside the character stays.
  const flat = ba >= 250 && !isGuide(br, bg, bb, ba) &&
    corners.every((c) => Math.abs(c[0] - br) + Math.abs(c[1] - bg) + Math.abs(c[2] - bb) <= 12 && c[3] >= 250);
  if (flat) keyOut(data, w, x0, y0, x1, y1, br, bg, bb);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 8 || isGuide(data[i], data[i + 1], data[i + 2], a)) continue;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (n < MIN_PIXELS) return null;
  // A sliver (a stray line across the cell) isn't a character either.
  if (maxX - minX + 1 < MIN_SIDE * (x1 - x0) || maxY - minY + 1 < MIN_SIDE * (y1 - y0)) return null;
  // Art filling the whole cell edge to edge is a picture or screenshot, not a character frame.
  if (maxX - minX + 1 >= 0.95 * (x1 - x0) && maxY - minY + 1 >= 0.95 * (y1 - y0)) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function findSkinFrame(data: Uint8ClampedArray, w: number, h: number, margin = 4): Rect | null {
  const g = gridFor(w, h);
  if (!g) return null;
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.cols; col++) {
      const art = cellArt(data, w, h, row, col);
      if (!art) continue;
      const cx = GUTTER + col * (g.cellW + GUTTER), cy = GUTTER + row * (g.cellH + GUTTER);
      const x0 = Math.round(cx) + 1, y0 = Math.round(cy) + 1;
      const x1 = Math.min(w, Math.round(cx + g.cellW) - 1), y1 = Math.min(h, Math.round(cy + g.cellH) - 1);
      const rx = Math.max(x0, art.x - margin), ry = Math.max(y0, art.y - margin);
      return { x: rx, y: ry, w: Math.min(x1, art.x + art.w + margin) - rx, h: Math.min(y1, art.y + art.h + margin) - ry };
    }
  }
  return null;
}

/** The sheet's rows, in the template's order. */
export const SKIN_ROWS = ['Idle', 'Run', 'Fall', 'Jump', 'Wall', 'Dash'] as const;

/**
 * One animation row as frames that line up: every non-empty cell, all cut with the same box (the union of their art, relative to
 * the cell), so the character doesn't jitter between frames. Keys flat backgrounds in `data` as it goes. Empty rows give [].
 */
export function rowFrames(data: Uint8ClampedArray, w: number, h: number, row: number, margin = 2): Rect[] {
  const g = gridFor(w, h);
  if (!g) return [];
  const found: Array<{ ox: number; oy: number; art: Rect }> = [];
  for (let col = 0; col < g.cols; col++) {
    const art = cellArt(data, w, h, row, col);
    if (art) found.push({ ox: Math.round(GUTTER + col * (g.cellW + GUTTER)), oy: Math.round(GUTTER + row * (g.cellH + GUTTER)), art });
  }
  if (found.length === 0) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of found) {
    minX = Math.min(minX, f.art.x - f.ox); minY = Math.min(minY, f.art.y - f.oy);
    maxX = Math.max(maxX, f.art.x + f.art.w - f.ox); maxY = Math.max(maxY, f.art.y + f.art.h - f.oy);
  }
  minX = Math.max(1, minX - margin); minY = Math.max(1, minY - margin);
  maxX = Math.min(Math.round(g.cellW) - 1, maxX + margin); maxY = Math.min(Math.round(g.cellH) - 1, maxY + margin);
  return found.map((f) => ({ x: f.ox + minX, y: f.oy + minY, w: maxX - minX, h: maxY - minY }));
}

/** The source rect fitted into a boxW × boxH box (aspect kept, centred), shrunk by `pad` on each side. */
export function fitRect(src: Rect, boxW: number, boxH: number, pad = 0): { dx: number; dy: number; dw: number; dh: number } {
  const s = Math.min((boxW - 2 * pad) / src.w, (boxH - 2 * pad) / src.h);
  const dw = src.w * s, dh = src.h * s;
  return { dx: (boxW - dw) / 2, dy: (boxH - dh) / 2, dw, dh };
}

/**
 * Draws the skin's first real frame from a loaded sheet onto a new canvas of boxW × boxH CSS pixels (crisp, nearest-neighbour).
 * Returns null when the sheet has no character art or its pixels can't be read (a tainted canvas).
 * When it returns null, the caller should keep the original image as a fallback.
 */
export function skinCanvas(img: HTMLImageElement, boxW: number, boxH: number): HTMLCanvasElement | null {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const work = document.createElement('canvas');
  work.width = w; work.height = h;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  if (!wctx) return null;
  wctx.drawImage(img, 0, 0);
  let frame: Rect | null;
  try {
    const px = wctx.getImageData(0, 0, w, h);
    frame = findSkinFrame(px.data, w, h);
    if (frame) wctx.putImageData(px, 0, 0);
  } catch {
    return null; // tainted canvas: no pixel access
  }
  if (!frame) return null;
  const dpr = window.devicePixelRatio || 1;
  const out = document.createElement('canvas');
  out.width = Math.round(boxW * dpr);
  out.height = Math.round(boxH * dpr);
  out.className = 'skin-canvas';
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.imageSmoothingEnabled = false; // pixel art stays sharp
  const f = fitRect(frame, out.width, out.height, Math.round(out.height * 0.08));
  octx.drawImage(work, frame.x, frame.y, frame.w, frame.h, Math.round(f.dx), Math.round(f.dy), Math.round(f.dw), Math.round(f.dh));
  return out;
}
