import { highlightCells } from '../render.js';
import { clearCell, putCell, rect } from './cells.js';
import type { Cell } from '../core/types.js';
import type { Tool } from './types.js';

let from: Cell | null = null;
let to: Cell | null = null;

export const rectangle: Tool = {
  id: 'rect', label: 'Rectangle', hotkey: 'R', cursor: 'crosshair', hint: 'Drag a rectangle to fill it with the brush. Shift: erase it.',
  down(_api, p) { from = p.cell; to = p.cell; },
  move(api, p, pressed) { if (pressed && from) { to = p.cell; api.redraw(); } },
  up(api, p) {
    if (!from) return;
    api.beginStroke();
    for (const c of rect(from, p.cell)) { if (p.shift) clearCell(api, c.x, c.y); else putCell(api, c.x, c.y); }
    api.endStroke();
    from = to = null;
    api.redraw();
  },
  overlay(api, ctx, hover) {
    const cells = from && to ? rect(from, to) : hover ? [hover] : [];
    if (cells.length <= 20000) highlightCells(ctx, api.camera, cells);
  },
};
