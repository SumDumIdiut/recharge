/** The scenery sprites' images (loaded on first use, shared by the editor and the previews). */
import { DECO_SPRITES, type DecoSprite } from './deco-index.js';

const images = new Map<string, HTMLImageElement | null>();
let listeners: Array<() => void> = [];

export const decoSprite = (name: string): DecoSprite | undefined => DECO_SPRITES.find((d) => d.sprite === name);

/** Called when a sprite image finishes loading (the editor repaints). */
export function onDecoLoaded(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

export function decoImage(file: string): HTMLImageElement | null {
  if (images.has(file)) return images.get(file) as HTMLImageElement | null;
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  images.set(file, null);
  img.onload = () => { images.set(file, img); for (const l of listeners) l(); };
  img.src = 'amp/art/plants/' + file;
  return null;
}

/** Draw a scenery sprite centred at (cx, cy) in screen pixels; `zoom` is screen pixels per game unit. */
export function drawDeco(ctx: CanvasRenderingContext2D, d: DecoSprite, cx: number, cy: number, zoom: number, opts: { scale?: number; flipX?: boolean; flipY?: boolean; rotation?: number; alpha?: number } = {}): boolean {
  const img = decoImage(d.file);
  if (!img) return false;
  const w = d.w * (opts.scale ?? 1) * zoom, h = d.h * (opts.scale ?? 1) * zoom;
  ctx.save();
  ctx.translate(cx, cy);
  if (opts.rotation) ctx.rotate((-opts.rotation * Math.PI) / 180);
  ctx.scale(opts.flipX ? -1 : 1, opts.flipY ? -1 : 1);
  if (opts.alpha !== undefined) ctx.globalAlpha *= opts.alpha;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}
