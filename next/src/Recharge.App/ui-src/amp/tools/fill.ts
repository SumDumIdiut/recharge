import { mapBounds } from '../model.js';
import { cellSignature, clearCell, putCell } from './cells.js';
import type { Tool } from './types.js';

const MAX = 6000;

/** Flood fill: the connected cells holding the same thing as the clicked one become the brush. An empty region is only filled if it is closed in (within a margin of the map). */
export const fill: Tool = {
  id: 'fill', label: 'Fill', hotkey: 'G', cursor: 'cell', hint: 'Click to flood-fill a region with the brush. Shift: erase the region.',
  down(api, p) {
    const target = cellSignature(api, p.cell.x, p.cell.y);
    const b = mapBounds(api.map) || { x0: p.cell.x, y0: p.cell.y, x1: p.cell.x + 1, y1: p.cell.y + 1 };
    const m = 24;
    const inside = (x: number, y: number): boolean => x >= b.x0 - m && x < b.x1 + m && y >= b.y0 - m && y < b.y1 + m;
    const seen = new Set<string>();
    const todo = [p.cell];
    const found: Array<{ x: number; y: number }> = [];
    while (todo.length) {
      const c = todo.pop() as { x: number; y: number };
      const k = c.x + ',' + c.y;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!inside(c.x, c.y)) return; // leaked out of the map: not a closed region
      if (cellSignature(api, c.x, c.y) !== target) continue;
      found.push(c);
      if (found.length > MAX) return;
      todo.push({ x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 });
    }
    api.beginStroke();
    for (const c of found) { if (p.shift) clearCell(api, c.x, c.y); else putCell(api, c.x, c.y); }
    api.endStroke();
    api.redraw();
  },
};
