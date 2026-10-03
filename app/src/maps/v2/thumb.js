// A map's picture for the maps list: the whole map, zoomed out to fit.
import { loadBase } from './base.js';
import { GL } from './render/gl.js';
import { WorldRenderer } from './render/world.js';
import { Doc } from './doc.js';
import { canConvert, fromMap } from './convert.js';

export const THUMB_W = 480, THUMB_H = 270;

// The layers a map is played on: framed by these (the dark backdrop and wall layers reach
// further, and show as nothing that small); by every layer when it has none of them.
const PLAYED = /^(new awesome nikki ground|blueBlocks|orangeBlocks|Spikes|blueSpikes|orangeSpikes|OvergrowthSpikes|moss|OvergrowthMoss|OvergrowthDestroyedGround)(#|$)/;

// The map's tiles without the odd stray far from the rest: the box holding all but the
// outermost half percent of them each way (by 32-cell chunks).
function tileBounds(doc, only = PLAYED) {
  const xs = [], ys = [];
  let total = 0;
  for (const l of doc.tiles.layers.values()) {
    if (only && !only.test(l.name)) continue;
    const span = l.size * 32;
    for (const [ck, c] of l.chunks) {
      let n = 0;
      for (let i = 0; i < c.length; i++) if (c[i]) n++;
      if (!n) continue;
      const [cx, cy] = ck.split(',').map(Number);
      xs.push([l.ox + cx * span, l.ox + (cx + 1) * span, n]); ys.push([l.oy + cy * span, l.oy + (cy + 1) * span, n]);
      total += n;
    }
  }
  if (!total) return only ? tileBounds(doc, null) : null;
  const cut = (list, lo) => {
    list.sort((a, b) => (lo ? a[0] - b[0] : b[1] - a[1]));
    let seen = 0;
    for (const [a, b, n] of list) { seen += n; if (seen > total * 0.005) return lo ? a : b; }
    return lo ? list[list.length - 1][0] : list[list.length - 1][1];
  };
  return [cut(xs, true), cut(ys, true), cut(xs, false), cut(ys, false)];
}

// Everything in the map: its tiles, and its things near them (a thing far off on its own,
// like a hidden credits room, would leave the rest of the map tiny).
function mapBounds(doc) {
  const ents = doc.entities.filter((e) => Number.isFinite(e.x) && Number.isFinite(e.y)), tiles = tileBounds(doc);
  let b = tiles ? tiles.slice() : null;
  const near = 1500;
  for (const e of ents) {
    if (!b) { b = [e.x, e.y, e.x, e.y]; continue; }
    if (tiles && (e.x < tiles[0] - near || e.x > tiles[2] + near || e.y < tiles[1] - near || e.y > tiles[3] + near)) continue;
    b[0] = Math.min(b[0], e.x); b[1] = Math.min(b[1], e.y); b[2] = Math.max(b[2], e.x); b[3] = Math.max(b[3], e.y);
  }
  return b;
}

// Draws the whole map on `canvas` (the renderer's) fitted in its middle, and returns that part
// as a PNG data URL of THUMB_W x THUMB_H.
export function shoot(renderer, canvas, doc) {
  const b = mapBounds(doc);
  if (!b) return null;
  const W = canvas.width, H = canvas.height, k = Math.min(W / THUMB_W, H / THUMB_H), tw = THUMB_W * k, th = THUMB_H * k;
  const bw = Math.max(64, b[2] - b[0]), bh = Math.max(64, b[3] - b[1]), scale = Math.min(tw / bw, th / bh) * 0.96;
  const ghost = renderer.ghost;
  renderer.ghost = null;
  renderer.draw({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, scale, dpr: 1 }, W, H, 0);
  renderer.ghost = ghost;
  const out = document.createElement('canvas');
  out.width = THUMB_W; out.height = THUMB_H;
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, (W - tw) / 2, (H - th) / 2, tw, th, 0, 0, THUMB_W, THUMB_H);
  return out.toDataURL('image/png');
}

// A picture of an installed map from its map.json (for maps saved before pictures, or elsewhere).
let offscreen = null;
export async function thumbOf(map, id) {
  if (!GL.supported() || canConvert(map)) return null;
  offscreen ||= loadBase().then(({ data, images }) => {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W * 2; canvas.height = THUMB_H * 2;
    return { base: data, canvas, renderer: new WorldRenderer(new GL(canvas), data, images) };
  });
  const o = await offscreen, doc = new Doc(o.base);
  fromMap(doc, map, id);
  o.renderer.setDoc(doc);
  return shoot(o.renderer, o.canvas, doc);
}
