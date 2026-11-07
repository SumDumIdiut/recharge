/**
 * Courses: the old Amplifier's course system. A course is a start gate, an end gate, a screen, timer resets and a reward; a map can have
 * several (gates go to the active course, a second start opens the next), plus the spawn point and extra spawns. Checkpoints can be filed
 * under a course (objects.ts). It saves as the old editor's `courseJson` list in the group (`courses`) next to the first course's
 * startX / endX / gates / reward, the spawn (and `spawns`), exactly as the old export wrote them; the data layout is coursedata.ts.
 *
 * Not ported: the level's own courses and their respawn markers, the level course screen's texts (the new editor has no base level),
 * and moving a gate to another course from its panel (select it, delete it and place it again with that course active).
 */
import type { AmpMap } from '../core/map.js';
import { CELL, type Cell, type Json } from '../core/types.js';
import type { JsonSink } from './sink.js';
import {
  COURSE, CURRENCIES, GATE_LIFT, SPAWN_LIFT, courseJson, coursesFromGroup, courseKey, courses, completeCourses, endPoint, extraSpawns, gate, gatePoint,
  parseCourseKey, spawnPoint, startPoint, DEFAULT_REWARD, type GateId, type Reward,
} from './coursedata.js';
import { ampLayer, type ContentType, type OptionDef } from './types.js';

export * from './coursedata.js';

const rewardOf = (ctx: { map: AmpMap; key?: string } | undefined): Reward => {
  const k = ctx?.key && parseCourseKey(ctx.key);
  return (k && courses(ctx.map).find((c) => c.n === k.n)?.reward) || DEFAULT_REWARD();
};
const rewardEdit = (field: 'currency' | 'amount'): OptionDef['edits'] => (_v, x, ctx) => {
  const k = ctx.key && parseCourseKey(ctx.key);
  if (!k) return [];
  const cur = rewardOf(ctx);
  const next: Reward = { ...cur, [field]: field === 'amount' ? Math.max(0, Number(x) || 0) : String(x) };
  return [{ layer: COURSE, key: courseKey(k.n, 'meta'), value: { reward: next } }];
};

export const course: ContentType = {
  id: 'course',
  label: 'Course',
  layer: COURSE,
  roles: ['main'],
  exclusive: false,
  brushes: [],
  place: () => undefined,
  brushOf: () => null,
  options(value, ctx): OptionDef[] {
    const k = ctx?.key ? parseCourseKey(ctx.key) : null;
    if (!k || (k.part !== 'start' && k.part !== 'end')) return [];
    return [
      {
        key: 'currency', label: 'Reward', type: 'select', hint: 'What finishing this course pays (the course the gate belongs to).',
        choices: CURRENCIES.map(([v, t]) => ({ value: v, label: t })),
        get: (_v, c) => rewardOf(c).currency, set: (v) => v, edits: rewardEdit('currency'),
      },
      {
        key: 'amount', label: 'Amount', type: 'number', min: 0, max: 1e9, step: 1,
        get: (_v, c) => rewardOf(c).amount, set: (v) => v, edits: rewardEdit('amount'),
      },
    ];
  },
  draw() { /* drawn by the course overlay, not per cell */ },
  cleanup(map, edit) {
    // a course with no gate left takes its screen, resets and reward with it
    const alive = new Set(courses(map).map((c) => c.n));
    for (const key of [...(map.layers[COURSE]?.keys() ?? [])]) {
      const k = parseCourseKey(key);
      if (k && k.n >= 1 && !alive.has(k.n)) edit(COURSE, key, undefined);
    }
  },
  toJson(map, sink: JsonSink) {
    const full = completeCourses(map), first = full[0];
    const spawn = gate(map, 'spawn');
    const anyStart = gate(map, 'start');
    // no complete course: a free-play map starts and ends at the spawn (the old editor's rule)
    const fallback: [number, number] = spawn ? gatePoint(spawn, SPAWN_LIFT) : anyStart ? gatePoint(anyStart, GATE_LIFT) : [0, GATE_LIFT];
    const s: [number, number] = first ? ((p) => [p.x, p.y] as [number, number])(startPoint(first.start as Cell)) : fallback;
    const e: [number, number] = first ? ((p) => [p.x, p.y] as [number, number])(endPoint(first.end as Cell)) : fallback;
    const g = sink.group;
    Object.assign(g, { startX: s[0], startY: s[1], endX: e[0], endY: e[1] });
    if (spawn) { const p = spawnPoint(spawn); g.spawnX = p.x; g.spawnY = p.y; }
    const xs = extraSpawns(map);
    if (xs.length) g.spawns = xs.map(({ cell }) => { const p = spawnPoint(cell); return { x: Math.round(p.x), y: Math.round(p.y) }; });
    g.gates = !!first;
    if (first) g.reward = first.reward;
    g.courses = full.map((c) => courseJson(c));
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, COURSE);
    if (pairs) { for (const [k, v] of pairs) map.layer(COURSE).set(k, v); return; }
    // version 1 files kept the gates in the amp block as [x, y]; a map made elsewhere only in its group
    const amp = json.amp as { start?: number[] | null; end?: number[] | null; spawn?: number[] | null } | undefined;
    const put = (key: string, v: number[] | null | undefined): void => { if (Array.isArray(v) && v.length === 2) map.layer(COURSE).set(key, { x: v[0], y: v[1] }); };
    if (amp && 'start' in amp) { put('start', amp.start); put('end', amp.end); put('spawn', amp.spawn); return; }
    const group = (Array.isArray(json.groups) ? json.groups[0] : null) as Json | null;
    if (!group) return;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const cellOf = (x: unknown, y: unknown, lift: number): Cell | null => (num(x) && num(y) ? { x: Math.floor(x / CELL), y: Math.floor((y - lift) / CELL) } : null);
    const listed = coursesFromGroup(group);
    if (listed.length) {
      for (const it of listed) map.layer(COURSE).set(it.key, it.meta ?? it.cell);
    } else if (group.gates === true) {
      const s = cellOf(group.startX, group.startY, GATE_LIFT), e = cellOf(group.endX, group.endY, 32);
      if (s) map.layer(COURSE).set('start', s);
      if (e) map.layer(COURSE).set('end', e);
    }
    const sp = cellOf(group.spawnX, group.spawnY, SPAWN_LIFT);
    if (sp) map.layer(COURSE).set('spawn', sp);
    if (Array.isArray(group.spawns)) (group.spawns as Array<Record<string, unknown>>).forEach((s, i) => { const c = cellOf(s.x, s.y, SPAWN_LIFT); if (c) map.layer(COURSE).set(courseKey(0, 'xspawn', i + 2), c); });
  },
};

