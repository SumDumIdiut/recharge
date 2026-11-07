/** The level's backgrounds, shown behind the map in the editor so people build in context. A view aid only: a map always saves with the level's own background. */
export type BackdropId = string;
export const BACKDROPS: Array<{ id: BackdropId; label: string; file: string | null }> = [
  { id: 'none', label: 'None', file: null },
  { id: 'level', label: 'Level', file: 'Level_Background_Repeating_0.webp' },
  { id: 'overgrown', label: 'Overgrown', file: 'overgrown_background.webp' },
];

const images = new Map<string, HTMLImageElement | null>();
let listeners: Array<() => void> = [];
export function onBackdropLoaded(fn: () => void): () => void { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn); }; }
export const clearBackdropListeners = (): void => { listeners = []; };

export function backdropImage(id: BackdropId): HTMLImageElement | null {
  const file = BACKDROPS.find((b) => b.id === id)?.file;
  if (!file || typeof Image === 'undefined') return null;
  if (images.has(file)) return images.get(file) as HTMLImageElement | null;
  images.set(file, null);
  const img = new Image();
  img.onload = () => { images.set(file, img); for (const l of listeners) l(); };
  img.src = 'amp/art/bg/' + file;
  return null;
}

/** Tile the background over the view. The image is 1920x1080 level units; it parallaxes slightly with the camera like the game's. */
export function drawBackdrop(ctx: CanvasRenderingContext2D, id: BackdropId, camX: number, camY: number, zoom: number, width: number, height: number, parallax = true): boolean {
  const img = backdropImage(id);
  if (!img) return false;
  const tw = 1920 * zoom, th = 1080 * zoom;
  // the background drifts at 0.9 of the camera's movement, as the game's area backgrounds do
  const ox = width / 2 - camX * (parallax ? 0.9 : 1) * zoom, oy = height / 2 + camY * (parallax ? 0.9 : 1) * zoom;
  const x0 = Math.floor((0 - ox) / tw), x1 = Math.ceil((width - ox) / tw);
  const y0 = Math.floor((0 - oy) / th), y1 = Math.ceil((height - oy) / th);
  ctx.globalAlpha = id === "level" ? 0.3 : 0.55;
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) ctx.drawImage(img, Math.round(ox + tx * tw), Math.round(oy + ty * th), Math.ceil(tw) + 1, Math.ceil(th) + 1);
  ctx.globalAlpha = 1;
  return true;
}
