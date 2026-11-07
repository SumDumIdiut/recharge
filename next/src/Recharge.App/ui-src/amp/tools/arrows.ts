/** The arrow tool (the old editor's guide arrow): press where the arrow starts - its circle - and drag along the path to where its head goes. */
import { ARROWS, arrowCells, extendPath, type Arrow, type Step } from '../content/arrows.js';
import { cellKey, parseKey, type Cell } from '../core/types.js';
import { COLORS_ARROW, outlineDot } from '../render.js';
import type { Tool, ToolApi } from './types.js';

let cur: { dl: string; key: string; fresh: boolean } | null = null;

const rel = (origin: Cell, cells: Step[]): Step[] => cells.map(([x, y]) => [x - origin.x, y - origin.y] as Step);

function down(api: ToolApi, p: { cell: Cell }): void {
  const dl = api.layerFor('arrows');
  cur = null;
  if (!dl) return;
  api.beginStroke();
  const g = p.cell;
  const data = api.map.layer(dl);
  const same = (s: Step | undefined): boolean => !!s && s[0] === g.x && s[1] === g.y;
  let found: { key: string; cells: Step[]; value: Arrow } | null = null, reverse = false;
  for (const [key, v] of data) {
    const a = v as Arrow;
    const cells = arrowCells(key, a);
    if (same(cells[cells.length - 1])) { found = { key, cells, value: a }; reverse = false; break; }
    if (!found && same(cells[0])) { found = { key, cells, value: a }; reverse = true; }
  }
  if (found && reverse) {
    // pressing an arrow's start continues it from there: it is turned round (it now starts at its old end)
    const cells = [...found.cells].reverse(), origin = { x: cells[0][0], y: cells[0][1] }, to = cellKey(origin.x, origin.y);
    if (to !== found.key && data.has(to)) found = null;
    else {
      api.edit(dl, found.key, undefined);
      api.edit(dl, to, { ...found.value, cells: rel(origin, cells) });
      cur = { dl, key: to, fresh: false };
    }
  } else if (found) cur = { dl, key: found.key, fresh: false };
  if (!cur) {
    const key = cellKey(g.x, g.y);
    if (!data.has(key)) { api.edit(dl, key, { cells: [[0, 0]] }); cur = { dl, key, fresh: true }; }
  }
  api.redraw();
}

function move(api: ToolApi, p: { cell: Cell }, pressed: boolean): void {
  if (!pressed || !cur) return;
  const a = api.map.get(cur.dl, cur.key) as Arrow | undefined;
  if (!a) return;
  const origin = parseKey(cur.key), cells = arrowCells(cur.key, a);
  if (extendPath(cells, p.cell)) { api.edit(cur.dl, cur.key, { ...a, cells: rel(origin, cells) }); api.redraw(); }
}

function up(api: ToolApi): void {
  if (!cur) return;
  const a = api.map.get(cur.dl, cur.key) as Arrow | undefined;
  // an arrow needs two cells; a click without a drag leaves nothing
  if (a && a.cells.length < 2) api.edit(cur.dl, cur.key, undefined);
  cur = null;
  api.endStroke();
  api.redraw();
}

function overlay(api: ToolApi, ctx: CanvasRenderingContext2D, hover: Cell | null): void {
  const cam = api.camera;
  const dl = api.layerFor('arrows') ?? ARROWS;
  const dot = (c: Step, r: number, fill: string): void => {
    const [x, y] = cam.toScreen(c[0] * 32 + 16, c[1] * 32 + 16);
    outlineDot(ctx, x, y, r * Math.max(0.6, Math.min(1.4, cam.zoom)), fill);
  };
  let onEnd = false;
  for (const [key, v] of api.map.layers[dl] ?? []) {
    const a = v as Arrow;
    const c = arrowCells(key, a);
    for (let i = 1; i < c.length - 1; i++) if (c[i - 1][0] !== c[i + 1][0] && c[i - 1][1] !== c[i + 1][1]) dot(c[i], 4, COLORS_ARROW.bend);
    dot(c[0], 6, COLORS_ARROW.start);
    if (c.length > 1) dot(c[c.length - 1], 6, COLORS_ARROW.end);
    if (hover && c.length && [c[0], c[c.length - 1]].some((e) => e[0] === hover.x && e[1] === hover.y)) onEnd = true;
  }
  if (hover) {
    const [sx, sy] = cam.toScreen(hover.x * 32, (hover.y + 1) * 32), px = 32 * cam.zoom;
    ctx.strokeStyle = onEnd ? COLORS_ARROW.start : '#ff9a3c';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, px, px);
  }
}

export const arrowTool: Tool = {
  id: 'arrow', label: 'Guide arrow', hotkey: 'A', cursor: 'crosshair',
  hint: 'Drag across cells to draw a guide arrow: a circle where you start, the head where you let go. Drag from either end to continue it.',
  activate(api) { api.setBrush('arrows', 'arrow'); },
  down, move, up, overlay,
};
