// Square crop / zoom maths for the profile picture dialog, and the resize that happens before upload.
// The crop box is `box` px wide. At zoom 1 the picture just covers the box; (ox, oy) is how far the picture's centre
// sits from the box centre in box px.
export const AVATAR_SIZE = 256;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampZoom = (z) => clamp(Number.isFinite(z) ? z : 1, MIN_ZOOM, MAX_ZOOM);

export function scaleFor(imgW, imgH, box, zoom) {
  return (box / Math.min(imgW, imgH)) * clampZoom(zoom);
}

// Keeps the picture covering the whole box.
export function clampOffset(imgW, imgH, box, zoom, ox, oy) {
  const s = scaleFor(imgW, imgH, box, zoom);
  const mx = Math.max(0, (imgW * s - box) / 2), my = Math.max(0, (imgH * s - box) / 2);
  return { x: clamp(ox || 0, -mx, mx), y: clamp(oy || 0, -my, my) };
}

// The square of the source picture (in its own pixels) that the box shows.
export function sourceRect(imgW, imgH, box, zoom, ox = 0, oy = 0) {
  const s = scaleFor(imgW, imgH, box, zoom);
  const o = clampOffset(imgW, imgH, box, zoom, ox, oy);
  const left = (box - imgW * s) / 2 + o.x, top = (box - imgH * s) / 2 + o.y;
  return { sx: -left / s + 0, sy: -top / s + 0, sw: box / s, sh: box / s };
}

// Centre-crop of a picture to an out.w x out.h aspect (banners).
export function coverSource(imgW, imgH, outW, outH) {
  const want = outW / outH, have = imgW / imgH;
  if (have > want) { const sw = imgH * want; return { sx: (imgW - sw) / 2, sy: 0, sw, sh: imgH }; }
  const sh = imgW / want;
  return { sx: 0, sy: (imgH - sh) / 2, sw: imgW, sh };
}

// Draws the source rect into an out-sized canvas and returns a Blob (WebP when the engine can encode it, else PNG).
export async function renderToBlob(img, rect, outW, outH, doc = globalThis.document) {
  const canvas = doc.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, outW, outH);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.92));
  canvas.width = canvas.height = 0; // free the backing store
  if (!blob) throw new Error('Could not encode the picture.');
  return blob;
}
