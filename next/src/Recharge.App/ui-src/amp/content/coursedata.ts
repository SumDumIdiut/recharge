/**
 * The course data, pure (no drawing): how the old Amplifier's courses sit in the map and how they export.
 *
 * A course is a start gate, an end gate, a screen, timer resets and a reward. They live in the `course` layer, one cell-valued key per
 * part, so a gate is selected, moved and erased like any other placed thing:
 *   course 1:  start  end  screen  reset:<i>  meta        (the keys earlier files already used)
 *   course n:  c<n>:start  c<n>:end  c<n>:screen  c<n>:reset:<i>  c<n>:meta
 *   spawn, spawn:<i> (extra spawns, numbered from 2)
 * `meta` holds {reward}. A gate is the cell it stands on; its world point is the cell's middle plus the old editor's lift (START_LIFT,
 * END_LIFT, SPAWN_LIFT), exactly where gateAt put it.
 */
import type { AmpMap } from '../core/map.js';
import { CELL, type Cell } from '../core/types.js';

export const COURSE = 'course';

/** The old editor's gate boxes (dx, dy: the box centre from the gate's point) and lifts (the point's height above the cell's bottom). */
export const START_BOX = { dx: 0, dy: 0, w: 60, h: 250 };
export const END_BOX = { dx: 0, dy: -26, w: 240, h: 13 };
export const SPAWN_BOX = { dx: 0, dy: 0, w: 32, h: 64 };
export const RESET_BOX = { dx: 0, dy: 150, w: 20, h: 400 };
/** A course's screen (reward, best time, clones) sits at its texts' centre; the board image is centred 3.5 above it (MapCourses.PlaceScreen). */
export const SCREEN_BOX = { dx: 0, dy: 3.5, w: 385, h: 172.5 };
export const START_LIFT = 125;
export const GATE_LIFT = START_LIFT;
export const END_LIFT = 32;
export const SPAWN_LIFT = 40;
export const RESET_LIFT = END_LIFT;

export const CURRENCIES: Array<[string, string]> = [['Cash', 'Cash'], ['GreenPower', 'Green power'], ['AtomicPower', 'Nuclear power'], ['CloneDust', 'Clone dust'], ['RedPower', 'Red power'], ['BluePower', 'Blue power']];
/** The old editor's course colours, by course number. */
export const COURSE_COLORS = ['#41f88d', '#4fc3ff', '#ffb347', '#ff6fd8', '#c792ea', '#f5e663', '#7ee0c3', '#ff8a80'];

export type Part = 'start' | 'end' | 'screen' | 'reset' | 'meta' | 'spawn' | 'xspawn';
export interface Reward { currency: string; amount: number }
export interface World { x: number; y: number }
export interface CourseData { n: number; id: string; start?: Cell; end?: Cell; screen?: Cell; resets: Array<{ i: number; cell: Cell }>; reward: Reward }

export type GateId = 'start' | 'end' | 'spawn';

/** The map key of a course part (`index` for resets and extra spawns). */
export function courseKey(n: number, part: Part, index = 0): string {
  if (part === 'spawn') return 'spawn';
  if (part === 'xspawn') return 'spawn:' + index;
  const name = part === 'reset' ? 'reset:' + index : part;
  return n === 1 ? name : 'c' + n + ':' + name;
}

export function parseCourseKey(key: string): { n: number; part: Part; index: number } | null {
  if (key === 'spawn') return { n: 0, part: 'spawn', index: 0 };
  let m = /^spawn:(\d+)$/.exec(key);
  if (m) return { n: 0, part: 'xspawn', index: +m[1] };
  m = /^(?:c(\d+):)?(start|end|screen|meta|reset:(\d+))$/.exec(key);
  if (!m) return null;
  const part = m[3] !== undefined ? 'reset' : (m[2] as Part);
  return { n: m[1] ? +m[1] : 1, part, index: m[3] !== undefined ? +m[3] : 0 };
}

const isCell = (v: unknown): v is Cell => !!v && typeof v === 'object' && Number.isFinite((v as Cell).x) && Number.isFinite((v as Cell).y);

export const DEFAULT_REWARD = (): Reward => ({ currency: 'Cash', amount: 0 });

/** Every course of the map, by number. A course exists while it has a start or an end gate. */
export function courses(map: AmpMap): CourseData[] {
  const data = map.layers[COURSE];
  if (!data) return [];
  const by = new Map<number, CourseData>();
  const get = (n: number): CourseData => {
    let c = by.get(n);
    if (!c) by.set(n, (c = { n, id: 'c' + n, resets: [], reward: DEFAULT_REWARD() }));
    return c;
  };
  for (const [key, v] of data) {
    const k = parseCourseKey(key);
    if (!k || k.n < 1) continue;
    if (k.part === 'start' && isCell(v)) get(k.n).start = v;
    else if (k.part === 'end' && isCell(v)) get(k.n).end = v;
    else if (k.part === 'screen' && isCell(v)) get(k.n).screen = v;
    else if (k.part === 'reset' && isCell(v)) get(k.n).resets.push({ i: k.index, cell: v });
    else if (k.part === 'meta' && v && typeof v === 'object') {
      const r = (v as { reward?: Partial<Reward> }).reward;
      if (r) get(k.n).reward = { currency: typeof r.currency === 'string' ? r.currency : 'Cash', amount: Number.isFinite(r.amount) ? (r.amount as number) : 0 };
    }
  }
  return [...by.values()].filter((c) => c.start || c.end).sort((a, b) => a.n - b.n).map((c) => ({ ...c, resets: c.resets.sort((a, b) => a.i - b.i) }));
}
export const completeCourses = (map: AmpMap): CourseData[] => courses(map).filter((c) => c.start && c.end);
export const courseById = (map: AmpMap, id: unknown): CourseData | undefined => courses(map).find((c) => c.id === id);
/** The number a course shows ("Course 2"): its place among the map's courses. */
export const courseNumber = (map: AmpMap, id: string): number => courses(map).findIndex((c) => c.id === id) + 1;
export const courseColor = (map: AmpMap, id: string): string => COURSE_COLORS[Math.max(0, courseNumber(map, id) - 1) % COURSE_COLORS.length];
export const isLinked = (map: AmpMap, id: unknown): boolean => !!courseById(map, id);
export const linkLabel = (map: AmpMap, id: string): string => (courseById(map, id) ? 'Course ' + courseNumber(map, id) : '');
export const nextCourseN = (map: AmpMap): number => courses(map).reduce((m, c) => Math.max(m, c.n), 0) + 1;

/** The first course's gate (the course the playtest runs); `spawn` is the map's own. */
export function gate(map: AmpMap, id: GateId): Cell | null {
  if (id === 'spawn') return (map.get(COURSE, 'spawn') as Cell | undefined) ?? null;
  const c = courses(map).find((x) => x[id]);
  return c?.[id] ?? null;
}
/** The extra spawn points, in order. */
export function extraSpawns(map: AmpMap): Array<{ i: number; cell: Cell }> {
  const out: Array<{ i: number; cell: Cell }> = [];
  for (const [key, v] of map.layers[COURSE] ?? []) { const k = parseCourseKey(key); if (k?.part === 'xspawn' && isCell(v)) out.push({ i: k.index, cell: v }); }
  return out.sort((a, b) => a.i - b.i);
}

export const gatePoint = (g: Cell, lift: number): [number, number] => [g.x * CELL + CELL / 2, g.y * CELL + lift];
const pt = (g: Cell, lift: number): World => { const [x, y] = gatePoint(g, lift); return { x, y }; };
export const startPoint = (g: Cell): World => pt(g, START_LIFT);
export const endPoint = (g: Cell): World => pt(g, END_LIFT);
export const resetPoint = (g: Cell): World => pt(g, RESET_LIFT);
export const spawnPoint = (g: Cell): World => pt(g, SPAWN_LIFT);

/** Where a finished course's screen goes (courseScreen): where it was put, or just left of its start gate. */
export function courseScreen(c: CourseData): World | null {
  if (!c.start || !c.end) return null;
  if (c.screen) return { x: c.screen.x * CELL + CELL / 2, y: c.screen.y * CELL + CELL / 2 };
  const s = startPoint(c.start);
  return { x: Math.round(s.x - START_BOX.w / 2 - 40 - SCREEN_BOX.w / 2 - SCREEN_BOX.dx), y: Math.round(s.y + 20) };
}

/** The saved course, as the old courseJson wrote it (field names and order), for the world origin (ox, oy). */
export function courseJson(c: CourseData, ox = 0, oy = 0): Record<string, unknown> {
  const r = Math.round;
  const s = startPoint(c.start as Cell), e = endPoint(c.end as Cell), screen = courseScreen(c) as World;
  const out: Record<string, unknown> = { id: c.id, startX: r(s.x - ox), startY: r(s.y - oy), endX: r(e.x - ox), endY: r(e.y - oy), screenX: r(screen.x - ox), screenY: r(screen.y - oy), reward: c.reward };
  // Timer resets: a run ends here without finishing the course, so no reward.
  if (c.resets.length) out.resets = c.resets.map(({ cell }) => { const g = resetPoint(cell); return { x: r(g.x - ox), y: r(g.y - oy), w: RESET_BOX.w, h: RESET_BOX.h, dx: RESET_BOX.dx, dy: RESET_BOX.dy }; });
  return out;
}

/** The box (world centre, size) a part occupies, for hit tests and drawing. */
export function partBox(part: Part, cell: Cell, c?: CourseData): { cx: number; cy: number; w: number; h: number } | null {
  switch (part) {
    case 'start': { const p = startPoint(cell); return { cx: p.x + START_BOX.dx, cy: p.y + START_BOX.dy, w: START_BOX.w, h: START_BOX.h }; }
    case 'end': { const p = endPoint(cell); return { cx: p.x + END_BOX.dx, cy: p.y + END_BOX.dy, w: END_BOX.w, h: END_BOX.h }; }
    case 'reset': { const p = resetPoint(cell); return { cx: p.x + RESET_BOX.dx, cy: p.y + RESET_BOX.dy, w: RESET_BOX.w, h: RESET_BOX.h }; }
    case 'spawn': case 'xspawn': { const p = spawnPoint(cell); return { cx: p.x + SPAWN_BOX.dx, cy: p.y + SPAWN_BOX.dy, w: SPAWN_BOX.w, h: SPAWN_BOX.h }; }
    case 'screen': { const s = c ? courseScreen(c) : null; return s ? { cx: s.x + SCREEN_BOX.dx, cy: s.y + SCREEN_BOX.dy, w: SCREEN_BOX.w, h: SCREEN_BOX.h } : null; }
    default: return null;
  }
}

/** The course part under a cell: the key and part whose box covers the cell (a gate's own cell first), or null. */
export function courseHit(map: AmpMap, x: number, y: number): { key: string; n: number; part: Part; index: number } | null {
  const cs = courses(map);
  const cands: Array<{ key: string; n: number; part: Part; index: number; cell: Cell; box: NonNullable<ReturnType<typeof partBox>> }> = [];
  const add = (key: string, n: number, part: Part, index: number, cell: Cell | undefined): void => {
    const box = cell && partBox(part, cell);
    if (cell && box) cands.push({ key, n, part, index, cell, box });
  };
  add('spawn', 0, 'spawn', 0, gate(map, 'spawn') ?? undefined);
  for (const s of extraSpawns(map)) add(courseKey(0, 'xspawn', s.i), 0, 'xspawn', s.i, s.cell);
  for (const c of cs) {
    for (const r of c.resets) add(courseKey(c.n, 'reset', r.i), c.n, 'reset', r.i, r.cell);
    add(courseKey(c.n, 'start'), c.n, 'start', 0, c.start);
    add(courseKey(c.n, 'end'), c.n, 'end', 0, c.end);
  }
  const inBox = (b: { cx: number; cy: number; w: number; h: number }): boolean => {
    const x0 = Math.floor((b.cx - b.w / 2) / CELL), x1 = Math.floor((b.cx + b.w / 2 - 1e-6) / CELL), y0 = Math.floor((b.cy - b.h / 2) / CELL), y1 = Math.floor((b.cy + b.h / 2 - 1e-6) / CELL);
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };
  const out = (c: { key: string; n: number; part: Part; index: number }): { key: string; n: number; part: Part; index: number } => ({ key: c.key, n: c.n, part: c.part, index: c.index });
  const own = cands.find((c) => c.cell.x === x && c.cell.y === y);
  if (own) return out(own);
  const boxed = cands.find((c) => inBox(c.box));
  if (boxed) return out(boxed);
  for (const c of cs) {
    const b = partBox('screen', { x: 0, y: 0 }, c);
    if (b && inBox(b)) return { key: courseKey(c.n, 'screen'), n: c.n, part: 'screen', index: 0 };
  }
  return null;
}

/** A course reassembled for the map's next free number, with its gates, from an exported group (a file made elsewhere). */
export function coursesFromGroup(group: Record<string, unknown>): Array<{ key: string; cell: Cell; meta?: { reward: Reward } }> {
  const out: Array<{ key: string; cell: Cell; meta?: { reward: Reward } }> = [];
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const cellOf = (x: unknown, y: unknown, lift: number): Cell | null => (num(x) && num(y) ? { x: Math.floor(x / CELL), y: Math.floor((y - lift) / CELL) } : null);
  const list = Array.isArray(group.courses) ? (group.courses as Array<Record<string, unknown>>) : [];
  list.forEach((c, i) => {
    const n = i + 1;
    const s = cellOf(c.startX, c.startY, START_LIFT), e = cellOf(c.endX, c.endY, END_LIFT);
    if (s) out.push({ key: courseKey(n, 'start'), cell: s });
    if (e) out.push({ key: courseKey(n, 'end'), cell: e });
    // a screen at the default place (just left of the start gate) is not pinned
    const dflt = num(c.startX) && num(c.startY) ? { x: Math.round(c.startX - START_BOX.w / 2 - 40 - SCREEN_BOX.w / 2 - SCREEN_BOX.dx), y: Math.round(c.startY + 20) } : null;
    if (num(c.screenX) && num(c.screenY) && !(dflt && dflt.x === c.screenX && dflt.y === c.screenY)) out.push({ key: courseKey(n, 'screen'), cell: { x: Math.floor(c.screenX / CELL), y: Math.floor(c.screenY / CELL) } });
    const rs = Array.isArray(c.resets) ? (c.resets as Array<Record<string, unknown>>) : [];
    rs.forEach((r, j) => { const rc = cellOf(r.x, r.y, RESET_LIFT); if (rc) out.push({ key: courseKey(n, 'reset', j + 1), cell: rc }); });
    const rw = c.reward as Partial<Reward> | undefined;
    if (rw && (s || e)) out.push({ key: courseKey(n, 'meta'), cell: { x: 0, y: 0 }, meta: { reward: { currency: typeof rw.currency === 'string' ? rw.currency : 'Cash', amount: num(rw.amount) ? rw.amount : 0 } } });
  });
  return out;
}
