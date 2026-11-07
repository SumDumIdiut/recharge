/** The cell edits the painting tools share. All of them respect the layer stack: hidden and locked layers are left alone. */
import { CONTENT, brushOf } from '../content/index.js';
import type { ContentType } from '../content/types.js';
import { COURSE } from '../content/course.js';
import { dataLayer } from '../core/layers.js';
import { cellKey, type Cell } from '../core/types.js';
import type { ToolApi } from './types.js';

/** The cells a square brush covers around a cell. */
export function footprint(cell: Cell, size: number): Cell[] {
  const lo = -Math.floor((size - 1) / 2);
  const out: Cell[] = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push({ x: cell.x + lo + dx, y: cell.y + lo + dy });
  return out;
}

/** The brush's footprint size: kinds that are one thing per cell stay at one. */
export function brushSize(api: ToolApi): number {
  return api.state.content === 'blocks' ? api.state.size : 1;
}

/** Empty a cell in every visible, unlocked layer. */
export function clearCell(api: ToolApi, x: number, y: number): void {
  const key = cellKey(x, y);
  for (const layer of api.map.layerDefs) {
    if (!layer.visible || layer.locked) continue;
    for (const c of CONTENT) {
      if (c.layer === COURSE) continue;
      const dl = dataLayer(c.layer, layer.id);
      const at = storeKey(c, x, y, key, api, dl);
      if (api.map.has(dl, at)) api.edit(dl, at, undefined);
    }
  }
}

/** The key a content type stores the thing covering cell (x, y) under (bigger-than-a-cell things like moss store under one cell). */
function storeKey(c: ContentType, x: number, y: number, key: string, api: ToolApi, dl: string): string {
  const s = c.cellOf?.(x, y, api.map, dl);
  return s ? cellKey(s.x, s.y) : key;
}

/** Put the brush's draft in a cell, replacing the other exclusive things in that layer. */
export function putCell(api: ToolApi, x: number, y: number): void {
  const picked = brushOf({ content: api.state.content, brush: api.state.brush });
  if (!picked) return;
  const dl = api.layerFor(picked.content.id);
  if (!dl) return;
  if (picked.content.id === 'arrows') return; // an arrow is drawn along a drag (the arrow tool), not stamped
  const key = storeKey(picked.content, x, y, cellKey(x, y), api, dl);
  if (picked.content.exclusive) {
    const layerId = dl.indexOf('@') < 0 ? 'main' : dl.slice(dl.indexOf('@') + 1);
    for (const c of CONTENT) {
      if (c.layer === COURSE || !c.exclusive || c === picked.content) continue;
      const other = dataLayer(c.layer, layerId);
      if (api.map.has(other, key)) api.edit(other, key, undefined);
    }
  }
  api.edit(dl, key, JSON.parse(JSON.stringify(api.state.draft ?? null)));
}

/** The cells on the straight line between two cells, both ends included. */
export function line(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  let x = a.x, y = a.y;
  const dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y), sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x, y });
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

/** The cells of the rectangle between two corner cells. */
export function rect(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) out.push({ x, y });
  return out;
}

/** The topmost placed thing in a cell (layers top first), as a data layer id and value, or null. */
export function topAt(api: ToolApi, x: number, y: number, bigToo = true): { layer: string; key: string; value: unknown; content: string } | null {
  for (let i = api.map.layerDefs.length - 1; i >= 0; i--) {
    const layer = api.map.layerDefs[i];
    if (!layer.visible) continue;
    for (let j = CONTENT.length - 1; j >= 0; j--) {
      const c = CONTENT[j];
      if (c.layer === COURSE || (c.cellOf && !bigToo)) continue;
      const dl = dataLayer(c.layer, layer.id);
      const key = storeKey(c, x, y, cellKey(x, y), api, dl);
      const v = api.map.get(dl, key);
      if (v !== undefined) return { layer: dl, key, value: v, content: c.id };
    }
  }
  return null;
}

/** What a cell holds, as one comparable string ("" for empty): the topmost thing. */
export function cellSignature(api: ToolApi, x: number, y: number): string {
  const t = topAt(api, x, y, false);
  return t ? t.layer + ':' + JSON.stringify(t.value) : '';
}
