/**
 * A rendered thumbnail of a map from its own data, for maps that have no uploaded picture. Uses the same tile
 * renderer as the editor (content modules + the game's tile sprites). Cheap: one small canvas per map, cached by id and revision.
 */
import { loadAtlas, type Atlas } from './atlas.js';
import { ATLAS_INDEX } from './atlas-index.js';
import { gate } from './content/course.js';
import type { DrawEnv } from './content/types.js';
import { CELL, type Json } from './core/types.js';
import { fromMapJson, mapBounds } from './model.js';
import { drawCell, drawLive } from './render.js';

export const PREVIEW_W = 320;
export const PREVIEW_H = 180;
const BG = '#101214';

interface RawTile { x: number; y: number; name: string; mat?: number[] }

/** Tiles a game map file names that the sprite sheet has (tileLayers, and `tile` objects): for maps not made in the Amplifier. */
export function rawTiles(json: Json): RawTile[] {
  const out: RawTile[] = [];
  const mats = (Array.isArray(json.mats) ? json.mats : []) as number[][];
  for (const layer of (Array.isArray(json.tileLayers) ? json.tileLayers : []) as Array<{ names?: string[]; runs?: number[] }>) {
    const names = layer.names || [], r = layer.runs || [];
    for (let i = 0; i + 4 < r.length; i += 5) {
      const name = names[r[i + 3]];
      if (!name || !ATLAS_INDEX[name]) continue;
      for (let n = 0; n < r[i + 2]; n++) out.push({ x: r[i + 1] + n, y: r[i], name, mat: mats[r[i + 4]] });
    }
  }
  const group = (Array.isArray(json.groups) ? json.groups[0] : null) as { objects?: Array<Record<string, unknown>> } | null;
  for (const o of group?.objects || []) {
    if (!o || o.type !== 'tile' || typeof o.tileName !== 'string' || !ATLAS_INDEX[o.tileName]) continue;
    if (typeof o.cellX !== 'number' || typeof o.cellY !== 'number') continue;
    out.push({ x: o.cellX, y: o.cellY, name: o.tileName, mat: Array.isArray(o.matrix) ? (o.matrix as number[]) : undefined });
  }
  return out;
}

function gatesOf(json: Json): Array<{ x: number; y: number; color: string }> {
  const g = (Array.isArray(json.groups) ? json.groups[0] : null) as Json | null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: Array<{ x: number; y: number; color: string }> = [];
  if (g && g.gates === true) {
    if (num(g.startX) && num(g.startY)) out.push({ x: g.startX / CELL, y: g.startY / CELL, color: '#41f88d' });
    if (num(g.endX) && num(g.endY)) out.push({ x: g.endX / CELL, y: g.endY / CELL, color: '#dc72ec' });
  }
  return out;
}

/** Draw a map file's picture into a fresh canvas, fit to its content. Returns null when there is nothing to show. */
export function renderPreviewCanvas(json: Json, atlas: Atlas, width = PREVIEW_W, height = PREVIEW_H): HTMLCanvasElement | null {
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  const env: DrawEnv = { ctx, atlas };
  const gates = gatesOf(json);
  const amp = json.amp !== undefined;
  const tiles = amp ? [] : rawTiles(json);
  const map = amp ? fromMapJson(json) : null;
  let b = map ? mapBounds(map) : null;
  if (!map && tiles.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tiles) { x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x + 1); y0 = Math.min(y0, t.y); y1 = Math.max(y1, t.y + 1); }
    b = { x0, y0, x1, y1 };
  }
  if (!b) return null;
  // keep gates in frame, a little air around
  for (const g of gates) { b.x0 = Math.min(b.x0, Math.floor(g.x)); b.x1 = Math.max(b.x1, Math.ceil(g.x) + 1); b.y0 = Math.min(b.y0, Math.floor(g.y) - 4); b.y1 = Math.max(b.y1, Math.ceil(g.y) + 4); }
  const margin = 2;
  const w = b.x1 - b.x0 + margin * 2, h = b.y1 - b.y0 + margin * 2;
  const scale = Math.min(width / w, height / h, 16);
  const ox = (width - (b.x1 - b.x0) * scale) / 2, oy = (height - (b.y1 - b.y0) * scale) / 2;
  const at = (x: number, y: number): [number, number] => [ox + (x - b.x0) * scale, oy + (b.y1 - y - 1) * scale];
  const size = Math.max(1, scale);
  if (map) {
    drawLive(env, map, at, size, 'under');
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
      const [sx, sy] = at(x, y);
      drawCell(env, map, x, y, sx, sy, size);
    }
    drawLive(env, map, at, size, 'over');
    for (const id of ['start', 'end'] as const) {
      const g = gate(map, id);
      if (g) gates.push({ x: g.x + 0.5, y: g.y + 4, color: id === 'start' ? '#41f88d' : '#dc72ec' });
    }
  } else {
    for (const t of tiles) {
      const [sx, sy] = at(t.x, t.y);
      const m = t.mat && t.mat.length === 4 ? ([t.mat[0], t.mat[1], t.mat[2], t.mat[3]] as [number, number, number, number]) : undefined;
      atlas.draw(ctx, t.name, sx, sy, size + (scale < 1 ? 0.5 : 0), { matrix: m });
    }
  }
  // gates as thin poles (only the amp branch added from cells; file gates for others)
  const drawn = map ? gates.filter((g) => g.y !== undefined).slice(-2) : gates;
  for (const g of drawn) {
    const [sx, sy] = at(g.x - 0.5, map ? g.y - 4 : g.y);
    ctx.fillStyle = g.color;
    ctx.fillRect(sx + size / 2 - 1, sy - size * 3, 2, size * 4);
  }
  return cv;
}

const cache = new Map<string, Promise<string | null>>();

/**
 * The preview of a map as a data URL, rendered once per `id` + `revision` (a new save changes the revision). `load` fetches the
 * map's data and runs only on a cache miss.
 */
export function mapPreviewUrl(id: string, revision: string, load: () => Promise<Json | null>): Promise<string | null> {
  const key = id + '@' + revision;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const json = await load();
      if (!json) return null;
      const atlas = await loadAtlas();
      const cv = renderPreviewCanvas(json, atlas);
      return cv ? cv.toDataURL('image/png') : null;
    })().catch(() => null);
    cache.set(key, hit);
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}

/** Whether a picture for this id and revision is already made (or being made). */
export const hasPreview = (id: string, revision: string): boolean => cache.has(id + '@' + revision);

export const clearPreviewCache = (): void => cache.clear();
