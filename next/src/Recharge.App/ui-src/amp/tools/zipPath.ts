/** The zip path tool: the one zip mover can be drawn. Press on a route's end (or anywhere fresh) and drag across
 * cells to shape the ride, curves and custom shapes included; a straight zip keeps all its options and just grows a route. */
import { MOVERS, tileMoverAt, type Mover, type PathPt } from '../content/mover.js';
import { cellKey, parseKey, type Cell } from '../core/types.js';
import { COLORS_ARROW, outlineDot } from '../render.js';
import type { Tool, ToolApi } from './types.js';
import { extendCellsPath } from './pathTrace.js';

let cur: { dl: string; key: string; fresh: boolean } | null = null;

/** Ways a drag can continue an existing drawn mover: the end of its route, or the key cell itself. */
function hitRoute(api: ToolApi, dl: string, g: Cell): { key: string; m: Mover } | null {
  const data = api.map.layers[dl];
  if (!data) return null;
  for (const [key, v] of data) {
    const m = v as Mover;
    if (typeof m !== 'object' || !Array.isArray(m.path) || m.path.length < 1) continue;
    if (key === cellKey(g.x, g.y)) return { key, m };
    const o = parseKey(key);
    const last = m.path[m.path.length - 1];
    if (o.x + last[0] === g.x && o.y + last[1] === g.y) return { key, m };
  }
  return null;
}

function down(api: ToolApi, p: { cell: Cell }): void {
  const dl = api.layerFor(MOVERS);
  cur = null;
  if (!dl) return;
  api.beginStroke();
  const g = p.cell, data = api.map.layer(dl);
  // continuing: press on a drawn mover (its end, its anchor, or anywhere on it) to add route after it
  const hit = hitRoute(api, dl, g);
  if (hit) { cur = { dl, key: hit.key, fresh: false }; api.redraw(); return; }
  // a straight (not yet drawn) zip pressed anywhere on its platform: it keeps everything and starts a clean
  // route from its anchor - the drag traces the whole ride, so a drag back through it reshapes instead of doubling
  const tile = tileMoverAt(api.map, dl, g.x, g.y);
  if (tile) {
    api.edit(dl, tile.key, { ...tile.mover, path: [[0, 0]], smooth: tile.mover.smooth ?? true });
    cur = { dl, key: tile.key, fresh: false };
    api.redraw();
    return;
  }
  // nothing under the press: a fresh mover from the draft, its route growing with the drag
  const base = (api.state.draft && typeof api.state.draft === 'object' ? api.state.draft : {}) as Partial<Mover>;
  api.edit(dl, cellKey(g.x, g.y), { ...base, dx: 0, dy: 0, path: [[0, 0]], smooth: true });
  cur = { dl, key: cellKey(g.x, g.y), fresh: true };
  api.redraw();
}

function move(api: ToolApi, p: { cell: Cell }, pressed: boolean): void {
  if (!pressed || !cur) return;
  const m = api.map.get(cur.dl, cur.key) as Mover | undefined;
  const pts = m?.path && m.path.length >= 1 ? [...m.path] : null;
  if (!m || !pts) return;
  // the route is stored relative to the anchor, so the dragged editor cell has to come back relative to it
  const anchor = parseKey(cur.key);
  if (!extendCellsPath(pts, { x: p.cell.x - anchor.x, y: p.cell.y - anchor.y })) return;
  const last = pts[pts.length - 1];
  // dx/dy mirror the route's end, so straight fallbacks (and older loaders) still know where it goes
  api.edit(cur.dl, cur.key, { ...m, dx: last[0], dy: last[1], path: pts });
  api.redraw();
}

function up(api: ToolApi): void {
  if (!cur) return;
  const m = api.map.get(cur.dl, cur.key) as Mover | undefined;
  const pts = m?.path || [];
  if (pts.length >= 3) {
    // a shaped ride: whatever the drag traced, and the smooth/corner choice already on the mover
  } else if (pts.length === 2) {
    // one straight stretch: it stays a plain mover going from here to there
    api.edit(cur.dl, cur.key, { ...m, dx: pts[1][0], dy: pts[1][1], path: undefined, smooth: undefined });
  } else if (cur.fresh) {
    api.edit(cur.dl, cur.key, undefined); // a route of nowhere is nothing
  } else {
    api.edit(cur.dl, cur.key, { ...m, path: undefined, smooth: undefined }); // an existing zip left as it was
  }
  cur = null;
  api.endStroke();
  api.redraw();
}

function overlay(api: ToolApi, ctx: CanvasRenderingContext2D, hover: Cell | null): void {
  const cam = api.camera;
  const dl = api.layerFor(MOVERS) ?? MOVERS;
  if (!hover) return;
  const [sx, sy] = cam.toScreen(hover.x * 32, (hover.y + 1) * 32), px = 32 * cam.zoom;
  ctx.strokeStyle = '#ff9a3c';
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, px, px);
  const drawn: Array<{ o: Cell; m: Mover }> = [];
  for (const [key, v] of api.map.layers[dl] ?? []) {
    const m = v as Mover;
    if (typeof m !== 'object' || !Array.isArray(m.path) || m.path.length < 3) continue;
    drawn.push({ o: parseKey(key), m });
  }
  const dot = (x: number, y: number, r: number, fill: string): void => outlineDot(ctx, x, y, r * Math.max(0.6, Math.min(1.4, cam.zoom)), fill);
  for (const { o, m } of drawn) {
    const pts = m.path!;
    const [ex, ey] = cam.toScreen((o.x + pts[pts.length - 1][0]) * 32 + 16, (o.y + pts[pts.length - 1][1]) * 32 + 16);
    dot(ex, ey, 6, COLORS_ARROW.end);
  }
}

export const zipPathTool: Tool = {
  id: 'zippath', label: 'Zip path', hotkey: 'C', cursor: 'crosshair',
  hint: 'Drag across cells to draw a zip mover\'s route - curves and custom shapes included. Press the end of a route to keep drawing; a straight zip keeps its options and just grows a route.',
  activate(api) { api.setBrush(MOVERS, 'zip'); },
  down, move, up, overlay,
};
