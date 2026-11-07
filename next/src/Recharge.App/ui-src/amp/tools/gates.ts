/**
 * The course tools (the old editor's start / end / reset / spawn tools). A start or end gate goes to the active course; a gate the active
 * course already has opens the next course (an end goes to a course that has a start and no end first). A reset needs a course. Dragging
 * with the button down moves the gate just placed. Select edits one afterwards (reward), Delete / Erase removes it.
 */
import { solidAt } from '../content/blocks.js';
import { COURSE, courseKey, courses, extraSpawns, nextCourseN, type GateId } from '../content/course.js';
import { cellKey, sameCell, type Cell } from '../core/types.js';
import type { Tool, ToolApi } from './types.js';

type Kind = GateId | 'reset' | 'xspawn';

/** The course a gate of this kind goes to, or null when it needs one and the map has none. */
function targetCourse(api: ToolApi, kind: 'start' | 'end' | 'reset'): number | null {
  const cs = courses(api.map);
  const active = cs.find((c) => c.n === api.state.course);
  if (kind === 'reset') return active?.n ?? cs[cs.length - 1]?.n ?? null;
  if (active && !active[kind]) return active.n;
  if (kind === 'end') { const open = cs.find((c) => c.start && !c.end); if (open) return open.n; }
  return nextCourseN(api.map);
}

/** A spawn stands on the ground: a cell inside blocks lifts to the first free one above (the old gateAt). */
function standing(api: ToolApi, cell: Cell): Cell {
  let y = cell.y;
  for (let n = 0; n < 200 && solidAt(api.map, cell.x, y); n++) y++;
  return { x: cell.x, y };
}

let placed: string | null = null;

function keyFor(api: ToolApi, kind: Kind): string | null {
  if (kind === 'spawn') return 'spawn';
  if (kind === 'xspawn') return courseKey(0, 'xspawn', Math.max(1, ...extraSpawns(api.map).map((s) => s.i)) + 1);
  const n = targetCourse(api, kind);
  if (n === null) return null;
  if (kind === 'reset') {
    const idx = Math.max(0, ...(courses(api.map).find((c) => c.n === n)?.resets.map((r) => r.i) ?? [])) + 1;
    return courseKey(n, 'reset', idx);
  }
  return courseKey(n, kind);
}

function place(kind: Kind, api: ToolApi, cell: Cell): void {
  api.beginStroke();
  const c = kind === 'spawn' || kind === 'xspawn' ? standing(api, cell) : cell;
  const key = placed ?? keyFor(api, kind);
  if (key) {
    api.edit(COURSE, key, { x: c.x, y: c.y });
    placed = key;
    const m = /^c(\d+):/.exec(key);
    if (kind === 'start' || kind === 'end' || kind === 'reset') api.state.course = m ? +m[1] : 1;
    // a first start gate brings a spawn two cells back, so a new map is playable straight away
    if (kind === 'start' && !api.map.has(COURSE, 'spawn')) api.edit(COURSE, 'spawn', { x: cell.x - 2, y: cell.y });
  }
  api.endStroke();
  api.redraw();
}

function gateTool(kind: Kind, label: string, hotkey: string, hint: string): Tool {
  return {
    id: kind, label, hotkey, cursor: 'crosshair', hint,
    down(api, p) { placed = null; place(kind, api, p.cell); },
    move(api, p, pressed) { if (pressed && placed) place(kind, api, p.cell); },
    up() { placed = null; },
  };
}

export const startGate = gateTool('start', 'Start gate', 'S', 'Click to place the start gate (where a run begins). A second start opens the next course. Drag to move.');
export const endGate = gateTool('end', 'End gate', 'D', 'Click to place the end gate (the exit) of the course being made.');
export const resetGate = gateTool('reset', 'Timer reset', 'Z', 'Click to place a timer reset: a run ends here without finishing the course. Needs a course.');
export const spawnPoint = gateTool('spawn', 'Spawn', 'P', 'Click to place the spawn point (where the player appears).');
export const extraSpawn = gateTool('xspawn', 'Extra spawn', 'X', 'Click to place an extra spawn point (the player swaps between spawns in the game).');
// kept for tests: whether a cell holds a gate
export const gateAt = (api: ToolApi, id: GateId, cell: Cell): boolean => sameCell(api.map.get(COURSE, id) as Cell | undefined, cell) && !!cellKey(cell.x, cell.y);
