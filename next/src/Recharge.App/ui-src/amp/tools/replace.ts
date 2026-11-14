/** Replace: click a tile and every tile in the map that matches it becomes the current brush (a map-wide swap, one undo step). */
import { cellSignature, occupiedCells, putCell } from './cells.js';
import type { Tool } from './types.js';

export const replaceTool: Tool = {
  id: 'replace', label: 'Replace', hotkey: 'J', group: 'Draw', cursor: 'crosshair',
  hint: 'Click a tile to swap every matching tile in the map for the current brush.',
  down(api, p) {
    const target = cellSignature(api, p.cell.x, p.cell.y);
    if (!target) return;
    const hits = occupiedCells(api).filter((c) => cellSignature(api, c.x, c.y) === target);
    if (hits.length === 0) return;
    api.beginStroke();
    for (const c of hits) putCell(api, c.x, c.y);
    api.endStroke();
    api.redraw();
  },
};
