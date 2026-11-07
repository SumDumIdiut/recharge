import { highlightCells } from '../render.js';
import { course, courseHit } from '../content/course.js';
import { COURSE } from '../content/coursedata.js';
import { clearCell, footprint, line, topAt } from './cells.js';
import type { Cell } from '../core/types.js';
import type { Tool, ToolApi } from './types.js';

let last: Cell | null = null;

function wipe(api: ToolApi, from: Cell | null, to: Cell): void {
  for (const c of from ? line(from, to) : [to]) for (const f of footprint(c, api.state.size)) clearCell(api, f.x, f.y);
}

export const erase: Tool = {
  id: 'erase', label: 'Erase', hotkey: 'E', cursor: 'crosshair', hint: 'Drag to erase blocks, spikes and objects.',
  down(api, p) {
    api.beginStroke(); last = p.cell;
    // nothing here to erase: a course gate, reset or spawn standing on the cell goes instead (the old editor's erase)
    const gate = !topAt(api, p.cell.x, p.cell.y) ? courseHit(api.map, p.cell.x, p.cell.y) : null;
    if (gate) { api.edit(COURSE, gate.key, undefined); course.cleanup?.(api.map, (l, k, v) => api.edit(l, k, v)); }
    else wipe(api, null, p.cell);
    api.redraw();
  },
  move(api, p, pressed) { if (!pressed || !last) return; wipe(api, last, p.cell); last = p.cell; api.redraw(); },
  up(api) { last = null; api.endStroke(); },
  overlay(api, ctx, hover) { if (hover) highlightCells(ctx, api.camera, footprint(hover, api.state.size), 'rgba(255,90,90,0.25)', 'rgba(255,90,90,0.6)'); },
};
