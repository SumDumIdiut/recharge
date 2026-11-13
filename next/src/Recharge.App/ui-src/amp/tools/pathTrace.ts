/** The one place a drag trace is turned into a drawn route (the zip path tool): the pointer's route as the same axis-step path the guide arrows draw. */
import type { Cell } from '../core/types.js';
import type { PathPt } from '../content/mover.js';

/** Extend a route towards a target cell, one axis step at a time; stepping back onto the previous cell shortens it. Mutates `cells`. */
export function extendCellsPath(cells: PathPt[], target: Cell): boolean {
  let changed = false;
  for (let guard = 0; guard < 800; guard++) {
    const last = cells[cells.length - 1];
    const dx = target.x - last[0], dy = target.y - last[1];
    if (!dx && !dy) return changed;
    const next: PathPt = Math.abs(dx) >= Math.abs(dy) ? [last[0] + Math.sign(dx), last[1]] : [last[0], last[1] + Math.sign(dy)];
    const prev = cells[cells.length - 2];
    if (prev && prev[0] === next[0] && prev[1] === next[1]) cells.pop();
    else cells.push(next);
    changed = true;
  }
  return changed;
}
