import { COURSE, courseHit, courses, courseScreen, parseCourseKey } from '../content/course.js';
import { highlightCells } from '../render.js';
import { CELL, cellKey, parseKey, type Cell } from '../core/types.js';
import { topAt } from './cells.js';
import type { Tool } from './types.js';

/** Select a placed thing to edit its options in the Properties panel; Delete removes it. Drag a selected thing to move it. A course gate, reset, screen or spawn is selected the same way. */
let dragFrom: { layer: string; key: string; value: unknown; grab?: Cell; virtual?: boolean } | null = null;

const isCourse = (layer: string): boolean => layer === COURSE;

/** The cell a course entry stands on (its value), or null. */
const cellOfEntry = (v: unknown): Cell | null => (v && typeof v === 'object' && Number.isFinite((v as Cell).x) && Number.isFinite((v as Cell).y) ? (v as Cell) : null);

export const select: Tool = {
  id: 'select', label: 'Select', hotkey: 'V', cursor: 'default', hint: 'Click a thing to edit its properties. Drag to move it. Delete removes it.',
  down(api, p) {
    const t = topAt(api, p.cell.x, p.cell.y);
    if (t) {
      api.select({ layer: t.layer, key: t.key });
      dragFrom = { layer: t.layer, key: t.key, value: t.value };
    } else {
      // gates, resets, spawns and screens sit over the map: they are what is left under the pointer
      const g = courseHit(api.map, p.cell.x, p.cell.y);
      if (g) {
        const k = parseCourseKey(g.key);
        if (k && k.n >= 1) api.state.course = k.n;
        const stored = api.map.get(COURSE, g.key);
        if (stored !== undefined) { api.select({ layer: COURSE, key: g.key }); dragFrom = { layer: COURSE, key: g.key, value: stored, grab: p.cell }; }
        else {
          // a screen still at its default place: nothing to edit, but dragging it pins it where it lands
          const c = courses(api.map).find((x) => x.n === g.n), at = c && courseScreen(c);
          api.select(null);
          dragFrom = at ? { layer: COURSE, key: g.key, value: { x: Math.floor(at.x / CELL), y: Math.floor(at.y / CELL) }, grab: p.cell, virtual: true } : null;
        }
      } else { api.select(null); dragFrom = null; }
    }
    api.redraw();
  },
  move(api, p, pressed) {
    if (!pressed || !dragFrom) return;
    if (isCourse(dragFrom.layer)) {
      // a course part keeps its key and moves its cell by how far the pointer has moved
      const from = cellOfEntry(dragFrom.value), grab = dragFrom.grab;
      if (!from || !grab) return;
      const to = { x: from.x + p.cell.x - grab.x, y: from.y + p.cell.y - grab.y };
      if (to.x === cellOfEntry(api.map.get(COURSE, dragFrom.key))?.x && to.y === cellOfEntry(api.map.get(COURSE, dragFrom.key))?.y) return;
      api.beginStroke();
      api.edit(COURSE, dragFrom.key, to);
      api.endStroke();
      if (dragFrom.virtual) api.select({ layer: COURSE, key: dragFrom.key });
      api.redraw();
      return;
    }
    const to = cellKey(p.cell.x, p.cell.y);
    if (to === dragFrom.key) return;
    const layerId = dragFrom.layer.indexOf('@') < 0 ? 'main' : dragFrom.layer.slice(dragFrom.layer.indexOf('@') + 1);
    const def = api.map.layerDefs.find((l) => l.id === layerId);
    if (def?.locked || api.map.has(dragFrom.layer, to)) return;
    api.beginStroke();
    api.edit(dragFrom.layer, dragFrom.key, undefined);
    api.edit(dragFrom.layer, to, dragFrom.value);
    api.endStroke();
    dragFrom = { ...dragFrom, key: to };
    api.select({ layer: dragFrom.layer, key: to });
    api.redraw();
  },
  up() { dragFrom = null; },
  overlay(api, ctx, hover) {
    const s = api.state.selection;
    if (s && isCourse(s.layer)) {
      const c = cellOfEntry(api.map.get(COURSE, s.key));
      if (c) highlightCells(ctx, api.camera, [c], 'rgba(65,248,141,0.18)', 'rgba(65,248,141,0.9)');
    } else if (s) highlightCells(ctx, api.camera, [parseKey(s.key)], 'rgba(65,248,141,0.18)', 'rgba(65,248,141,0.9)');
    else if (hover) highlightCells(ctx, api.camera, [hover]);
  },
};
export const selectionExists = (api: { map: { has(l: string, k: string): boolean }; state: { selection: { layer: string; key: string } | null } }): boolean => !!api.state.selection && api.map.has(api.state.selection.layer, api.state.selection.key);
