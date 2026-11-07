/**
 * Moving platforms: the game's zip mover. A platform that rides from its start to an end point and back; it saves as a copy of the
 * level's zip mover (the same `clone` + `zip` object the old Amplifier wrote), which the game plays - it needs the map's
 * "zip movers" player rule, which the file sets for you. Anchor cell = the middle of the platform at its start.
 */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, parseKey, type Json } from '../core/types.js';
import { resolveCell, tileSet, TILESETS } from '../tiling.js';
import { drawResolved } from '../tileart.js';
import type { JsonSink } from './sink.js';
import { ampLayer, groupOption, boolOption, numberOption, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const MOVERS = 'movers';

/** Where the game's zip mover lives in the level (copied from here) - the same source every map made by the old Amplifier names. */
export const ZIP_SOURCE = { path: 'Courses/course 10/DisableBits/ZipMover (5)', srcX: 32495.9, srcY: 6181.3 };

export interface Mover { dx: number; dy: number; w: number; h: number; time: number; back: number; auto: boolean; pause: number; pauseBack: number; look: string; group?: string }

export const MOVER_DEFAULT: Mover = { dx: 8, dy: 0, w: 4, h: 1, time: 3, back: 1.75, auto: true, pause: 1, pauseBack: 0.5, look: 'zip' };
export const norm = (v: unknown): Mover => ({ ...MOVER_DEFAULT, ...((v as Partial<Mover>) || {}) });

/** What a mover looks like in the editor: the game's zip mover sprite, or a block of any tile set (the platform's "block kind"). The game itself always plays its zip mover. */
export const LOOKS = [{ value: 'zip', label: 'Zip mover' }, ...TILESETS.map((t) => ({ value: t.id, label: t.label + ' blocks' }))];

/** One full trip in seconds: wait, ride out, wait at the end, ride back. */
export const cycleSeconds = (m: Mover): number => m.pause + m.time + m.pauseBack + m.back;
export const distance = (m: Mover): number => Math.hypot(m.dx, m.dy);

/** How far along its path (0 at the start, 1 at the end) a mover is `t` seconds into its trip. Pure; the simulation and the editor share it. */
export function progressAt(m: Mover, t: number): number {
  if (t < m.pause) return 0;
  t -= m.pause;
  if (t < m.time) return m.time > 0 ? t / m.time : 1;
  t -= m.time;
  if (t < m.pauseBack) return 1;
  t -= m.pauseBack;
  return t < m.back ? 1 - (m.back > 0 ? t / m.back : 1) : 0;
}

type Dir = 'right' | 'left' | 'up' | 'down' | 'custom';
const dirOf = (m: Mover): Dir => (m.dy === 0 && m.dx > 0 ? 'right' : m.dy === 0 && m.dx < 0 ? 'left' : m.dx === 0 && m.dy > 0 ? 'up' : m.dx === 0 && m.dy < 0 ? 'down' : 'custom');
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

/** The platform's body: a zip mover sprite stretched over w x h cells, or a w x h block of a tile set (autotiled as one block). */
function body(env: DrawEnv, x: number, y: number, m: Mover, size: number, alpha: number): void {
  const ctx = env.ctx;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  const set = m.look !== 'zip' ? tileSet(m.look) : null;
  if (set && m.look === set.id) {
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
      const r = resolveCell(set, (dx, dy) => { const cx = i + dx, cy = m.h - 1 - j + dy; return cx >= 0 && cx < m.w && cy >= 0 && cy < m.h; });
      const px = Math.round(x + i * size), py = Math.round(y + j * size), s = Math.round(x + (i + 1) * size) - px;
      drawResolved(env.atlas, ctx, r, px, py, s);
    }
  } else if (env.atlas.has('obj_zipmover')) env.atlas.stretch(ctx, 'obj_zipmover', x, y, m.w * size, m.h * size);
  else { ctx.fillStyle = '#8b8d86'; ctx.fillRect(x, y, m.w * size, m.h * size); }
  ctx.globalAlpha = prev;
}

/** Draw a mover's platform with its top-left at (x, y) pixels - also how the playtest draws it in motion. */
export const drawMoverBody = body;

/** The picker's presets: each places a mover with these values over the defaults. */
const PRESETS: Record<string, { label: string; value: Partial<Mover> }> = {
  zip: { label: 'Zip mover', value: {} },
  lift: { label: 'Lift', value: { dx: 0, dy: 8, w: 3, h: 1, time: 3, back: 3 } },
  shuttle: { label: 'Fast shuttle', value: { dx: 12, dy: 0, w: 3, h: 1, time: 1.5, back: 1.5, pause: 0.5, pauseBack: 0.25 } },
  touch: { label: 'On touch', value: { auto: false, pause: 0.25 } },
  crusher: { label: 'Big block', value: { dx: 0, dy: -6, w: 3, h: 3, time: 0.6, back: 2.5, pause: 1.5, pauseBack: 0.5, look: 'plate' } },
};

const move = (m: Mover, patch: Partial<Mover>): Mover => ({ ...m, ...patch });
const set = (key: keyof Mover, label: string, def: number, extra: Partial<OptionDef>): OptionDef => ({
  ...numberOption(key, label, def, extra),
  get: (v) => norm(v)[key],
  set: (v, x) => move(norm(v), { [key]: Number(x) } as Partial<Mover>),
});

export const movers: ContentType = {
  id: 'movers',
  label: 'Moving platforms',
  layer: MOVERS,
  roles: ['main'],
  exclusive: false,
  live: true,
  brushes: Object.entries(PRESETS).map(([id, p]): Brush => ({ id, label: p.label, group: 'Moving', thumb: { sprite: 'obj_zipmover' } })),
  place: (brush) => ({ ...MOVER_DEFAULT, ...(PRESETS[brush.id]?.value ?? {}) }),
  brushOf(value) {
    if (!value) return null;
    const m = norm(value);
    const id = !m.auto ? 'touch' : m.h >= 3 ? 'crusher' : m.dx === 0 && m.dy !== 0 ? 'lift' : m.time <= 1.5 && m.dy === 0 ? 'shuttle' : 'zip';
    return { brush: movers.brushes.find((b) => b.id === id) as Brush };
  },
  options(): OptionDef[] {
    return [
      { key: 'look', label: 'Block kind', type: 'select', choices: LOOKS, hint: "What the platform is made of. The editor shows it; the game plays its own zip mover.", get: (v) => norm(v).look, set: (v, x) => move(norm(v), { look: String(x) }) },
      { key: 'dir', label: 'Direction', type: 'select', hint: 'Which way it rides from its start. Pick a direction, then set the distance.', get: (v) => dirOf(norm(v)),
        choices: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }, { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }, { value: 'custom', label: 'Custom (diagonal)' }],
        set: (v, x) => {
          const m = norm(v), d = Math.max(1, Math.round(distance(m)) || 1);
          const to: Record<string, [number, number]> = { right: [d, 0], left: [-d, 0], up: [0, d], down: [0, -d] };
          const t = to[String(x)];
          return t ? move(m, { dx: t[0], dy: t[1] }) : m;
        } },
      { key: 'dist', label: 'Distance', type: 'number', min: 1, max: 200, step: 1, unit: 'cells', hint: 'How far it rides (the trip keeps its speed).',
        get: (v) => round(distance(norm(v))),
        set: (v, x) => {
          const m = norm(v), d = distance(m), n = Math.max(1, Number(x));
          if (d === 0) return move(m, { dx: n });
          const k = n / d;
          return move(m, { dx: round(m.dx * k), dy: round(m.dy * k), time: round(m.time * k, 3), back: round(m.back * k, 3) });
        } },
      { key: 'speed', label: 'Speed', type: 'number', min: 0.5, max: 100, step: 0.5, unit: 'cells/s', hint: 'How fast it rides out (the return keeps its own time).',
        get: (v) => { const m = norm(v); return round(m.time > 0 ? distance(m) / m.time : 0); },
        set: (v, x) => { const m = norm(v); return move(m, { time: round(distance(m) / Math.max(0.1, Number(x)), 3) }); } },
      set('back', 'Return time', MOVER_DEFAULT.back, { min: 0.2, max: 120, step: 0.25, unit: 's', hint: 'Seconds to ride back to the start.' }),
      { key: 'mode', label: 'Motion', type: 'select', hint: 'Ping-pong: loops there and back on its own. On touch: waits until the player stands on it.', get: (v) => (norm(v).auto ? 'loop' : 'touch'),
        choices: [{ value: 'loop', label: 'Ping-pong loop' }, { value: 'touch', label: 'On touch' }],
        set: (v, x) => move(norm(v), { auto: String(x) === 'loop' }) },
      set('pause', 'Start delay', MOVER_DEFAULT.pause, { min: 0, max: 30, step: 0.25, unit: 's', hint: 'How long it rests before leaving (after the touch, for an on-touch mover).' }),
      set('pauseBack', 'Wait at end', MOVER_DEFAULT.pauseBack, { min: 0, max: 30, step: 0.25, unit: 's' }),
      set('w', 'Width', MOVER_DEFAULT.w, { min: 1, max: 40, step: 1, unit: 'cells' }),
      set('h', 'Height', MOVER_DEFAULT.h, { min: 1, max: 40, step: 1, unit: 'cells' }),
      set('dx', 'End offset X', MOVER_DEFAULT.dx, { min: -200, max: 200, step: 1, unit: 'cells', hint: 'The end point, sideways from the start (negative: left).' }),
      set('dy', 'End offset Y', MOVER_DEFAULT.dy, { min: -200, max: 200, step: 1, unit: 'cells', hint: 'The end point, up from the start (negative: down).' }),
      groupOption(),
    ];
  },
  draw(env: DrawEnv, _map, _x, _y, value, sx, sy, size) {
    const m = norm(value);
    const ctx = env.ctx;
    // the platform is centred on its anchor cell
    const cx = sx + size / 2, cy = sy + size / 2;
    const x0 = cx - (m.w * size) / 2, y0 = cy - (m.h * size) / 2;
    // the path: a dashed line to a ghost at the end point
    const ex = cx + m.dx * size, ey = cy - m.dy * size;
    ctx.save();
    ctx.strokeStyle = 'rgba(220,114,236,0.8)';
    ctx.lineWidth = Math.max(1, size / 12);
    ctx.setLineDash([size / 3, size / 4]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    body(env, x0 + m.dx * size, y0 - m.dy * size, m, size, 0.35);
    if (env.atlas.has('obj_zipnode')) env.atlas.stretch(env.ctx, 'obj_zipnode', ex - size * 0.5, ey - size * 0.5, size, size);
    body(env, x0, y0, m, size, 1);
    ctx.strokeStyle = m.auto ? '#dc72ec' : '#ffd24a';
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeRect(x0, y0, m.w * size, m.h * size);
  },
  toJson(map, sink: JsonSink) {
    for (const { data } of eachLayer(map, MOVERS)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const m = norm(value);
        const c = parseKey(key);
        sink.objects.push({
          type: 'clone', ...ZIP_SOURCE, x: c.x * CELL + CELL / 2, y: c.y * CELL + CELL / 2, order: 0,
          zip: {
            end: [m.dx * CELL, m.dy * CELL], time: m.time, backTime: m.back, size: [m.w * CELL, m.h * CELL],
            ...(m.auto ? { auto: true, pauseMove: m.pause, pauseReturn: m.pauseBack } : {}),
          },
          ...(m.group ? { group: m.group } : {}),
          amp: true,
        });
        // the player rule that makes zip movers work
        sink.player.zipMovers = true;
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, MOVERS);
    if (pairs) for (const [k, v] of pairs) if (v && typeof v === 'object') map.layer(MOVERS).set(k, v);
  },
};

/** A mover's platform and its end position as boxes in level units (for the simulation): start, end. */
export function moverBoxes(key: string, value: unknown): { start: { x: number; y: number; w: number; h: number }; end: { x: number; y: number; w: number; h: number } } {
  const m = norm(value);
  const c = parseKey(key);
  const cx = c.x * CELL + CELL / 2, cy = c.y * CELL + CELL / 2;
  const w = m.w * CELL, h = m.h * CELL;
  return { start: { x: cx - w / 2, y: cy - h / 2, w, h }, end: { x: cx - w / 2 + m.dx * CELL, y: cy - h / 2 + m.dy * CELL, w, h } };
}
