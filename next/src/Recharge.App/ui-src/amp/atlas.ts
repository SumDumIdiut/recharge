/** The game's tile sprites, cut from the game's own tile atlas into one image (art/atlas.png, index in atlas-index.ts). */
import { ATLAS_INDEX } from './atlas-index.js';

/** [a, b, c, d] 2x2 matrix as the game stores it ([1,0,0,1] is identity, y up). */
export type Matrix = readonly [number, number, number, number];

export interface Atlas {
  has(name: string): boolean;
  /** The sheet image and a sprite's rectangle in it, for composing tiles pixel by pixel (connectors). */
  source(name: string): { img: CanvasImageSource; x: number; y: number; w: number; h: number } | null;
  /** Draw a sprite into the square (x, y, size). `matrix` turns/mirrors it about the square's middle; `quarter` (0 TL, 1 TR, 2 BL, 3 BR) draws just that quarter. */
  draw(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, opts?: { quarter?: number; matrix?: Matrix; alpha?: number }): boolean;
}

export const emptyAtlas: Atlas = { has: () => false, source: () => null, draw: () => false, size: () => null, stretch: () => false };

function make(img: CanvasImageSource | null): Atlas {
  return {
    has: (name) => img !== null && ATLAS_INDEX[name] !== undefined,
    source: (name) => (img && ATLAS_INDEX[name] ? { img, x: ATLAS_INDEX[name][0], y: ATLAS_INDEX[name][1], w: ATLAS_INDEX[name][2], h: ATLAS_INDEX[name][3] } : null),
    size: (name) => (ATLAS_INDEX[name] ? [ATLAS_INDEX[name][2], ATLAS_INDEX[name][3]] : null),
    stretch(ctx, name, x, y, w, h, alpha) {
      const r = ATLAS_INDEX[name];
      if (!img || !r) return false;
      const prev = ctx.globalAlpha;
      if (alpha !== undefined) ctx.globalAlpha = prev * alpha;
      ctx.drawImage(img, r[0], r[1], r[2], r[3], x, y, w, h);
      ctx.globalAlpha = prev;
      return true;
    },
    draw(ctx, name, x, y, size, opts) {
      const r = ATLAS_INDEX[name];
      if (!img || !r) return false;
      const [sx, sy, sw, sh] = r;
      const q = opts?.quarter;
      const m = opts?.matrix;
      const prevAlpha = ctx.globalAlpha;
      if (opts?.alpha !== undefined) ctx.globalAlpha = prevAlpha * opts.alpha;
      const scale = size / 32;
      if (m && (m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1)) {
        ctx.save();
        // game matrices are y-up; canvas is y-down, so the rotation sense flips
        ctx.translate(x + size / 2, y + size / 2);
        ctx.transform(m[0], -m[2], -m[1], m[3], 0, 0);
        ctx.drawImage(img, sx, sy, sw, sh, -size / 2, -size / 2, sw * scale, sh * scale);
        ctx.restore();
      } else if (q === undefined) {
        ctx.drawImage(img, sx, sy, sw, sh, x, y, sw * scale, sh * scale);
      } else {
        const hw = sw / 2, hh = sh / 2, c = q % 2, r2 = q >> 1;
        ctx.drawImage(img, sx + c * hw, sy + r2 * hh, hw, hh, x + c * hw * scale, y + r2 * hh * scale, hw * scale, hh * scale);
      }
      if (opts?.alpha !== undefined) ctx.globalAlpha = prevAlpha;
      return true;
    },
  };
}

let shared: Promise<Atlas> | null = null;

/** Load the sheet once; every caller (editor, previews) shares it. Resolves with an atlas that draws nothing if the image is missing. */
export function loadAtlas(url = 'amp/art/atlas.png'): Promise<Atlas> {
  if (!shared) {
    shared = new Promise((resolve) => {
      if (typeof Image === 'undefined') { resolve(emptyAtlas); return; }
      const img = new Image();
      img.onload = () => resolve(make(img));
      img.onerror = () => resolve(emptyAtlas);
      img.src = url;
    });
  }
  return shared;
}
