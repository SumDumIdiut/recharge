/** Shape tools: straight line, rectangle frame, and ellipse (outline or filled). Each drags a rubber band, then stamps the brush. Shift erases. */
import { highlightCells } from '../render.js';
import { clearCell, ellipse, line, putCell, rectOutline } from './cells.js';
import type { Cell } from '../core/types.js';
import type { Tool } from './types.js';

let from: Cell | null = null;
let to: Cell | null = null;

/** A shape tool from its id/key/label and a function giving the cells between two corners. */
function shapeTool(id: string, hotkey: string, label: string, hint: string, cells: (a: Cell, b: Cell) => Cell[]): Tool {
  return {
    id, label, hotkey, group: 'Shapes', cursor: 'crosshair', hint,
    down(_api, p) { from = p.cell; to = p.cell; },
    move(api, p, pressed) { if (pressed && from) { to = p.cell; api.redraw(); } },
    up(api, p) {
      if (!from) return;
      api.beginStroke();
      for (const c of cells(from, p.cell)) { if (p.shift) clearCell(api, c.x, c.y); else putCell(api, c.x, c.y); }
      api.endStroke();
      from = to = null;
      api.redraw();
    },
    overlay(api, ctx, hover) {
      const list = from && to ? cells(from, to) : hover ? [hover] : [];
      if (list.length <= 20000) highlightCells(ctx, api.camera, list);
    },
  };
}

export const lineTool = shapeTool('line', 'L', 'Line', 'Drag a straight line of the brush. Shift: erase.', (a, b) => line(a, b));
export const frameTool = shapeTool('frame', 'K', 'Frame', 'Drag a hollow rectangle of the brush. Shift: erase.', (a, b) => rectOutline(a, b));
export const ellipseTool = shapeTool('ellipse', 'O', 'Ellipse', 'Drag an ellipse outline. Shift: erase.', (a, b) => ellipse(a, b, false));
export const ellipseFillTool = shapeTool('ellipseFill', 'U', 'Filled ellipse', 'Drag a filled ellipse. Shift: erase.', (a, b) => ellipse(a, b, true));
