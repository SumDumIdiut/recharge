import { contentById } from '../content/index.js';
import { highlightCells, outlineArea } from '../render.js';
import { arrowTool } from './arrows.js';
import { brushSize, clearCell, footprint, line, putCell } from './cells.js';
import type { Cell } from '../core/types.js';
import type { Tool, ToolApi } from './types.js';

let last: Cell | null = null;
let drawing = false;

function stamp(api: ToolApi, from: Cell | null, to: Cell, erase: boolean): void {
  const size = brushSize(api);
  for (const c of from ? line(from, to) : [to]) for (const f of footprint(c, size)) { if (erase) clearCell(api, f.x, f.y); else putCell(api, f.x, f.y); }
}

export const paint: Tool = {
  id: 'paint', label: 'Paint', hotkey: 'B', cursor: 'crosshair', hint: 'Drag to paint the selected brush. Shift: erase.',
  // the arrow brush is drawn along a drag by the arrow tool
  down(api, p) { if (api.state.content === 'arrows' && !p.shift) { drawing = true; return arrowTool.down(api, p); } api.beginStroke(); last = p.cell; stamp(api, null, p.cell, p.shift); api.redraw(); },
  move(api, p, pressed) { if (drawing) return arrowTool.move?.(api, p, pressed); if (!pressed || !last) return; stamp(api, last, p.cell, p.shift); last = p.cell; api.redraw(); },
  up(api, p) { if (drawing) { drawing = false; return arrowTool.up?.(api, p); } last = null; api.endStroke(); },
  overlay(api, ctx, hover) {
    if (api.state.content === 'arrows') return arrowTool.overlay?.(api, ctx, hover);
    if (!hover) return;
    const o = contentById(api.state.content)?.outline;
    if (o) outlineArea(ctx, api.camera, o(hover.x, hover.y));
    else highlightCells(ctx, api.camera, footprint(hover, brushSize(api)));
  },
};
