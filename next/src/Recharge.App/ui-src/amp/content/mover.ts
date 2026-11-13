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

export interface Mover { dx: number; dy: number; w: number; h: number; time: number; back: number; auto: boolean; pause: number; pauseBack: number; look: string; group?: string; /** The drawn route: cells relative to the anchor, first = [0, 0], last = [dx, dy]. Drawn movers ride along it; plain ones move straight. */ path?: PathPt[]; smooth?: boolean; /** The platform's own tiles, relative to the anchor, y up, one cell each. Absent: the w x h rectangle the mover was placed with. Painting tiles on a mover fills this in. */ tiles?: PathPt[] }

export type PathPt = [number, number];

export const MOVER_DEFAULT: Mover = { dx: 8, dy: 0, w: 3, h: 3, time: 3, back: 1.75, auto: true, pause: 1, pauseBack: 0.5, look: 'zip' };
export const norm = (v: unknown): Mover => ({ ...MOVER_DEFAULT, ...((v as Partial<Mover>) || {}) });

/** The platform's tiles as offsets from the anchor, y up: the tiles you painted, or the w x h rectangle a rect mover implies (the anchor under the square's middle, down-left of centre for even widths, as the old box centring was). */
export function tilesOf(m: Mover): PathPt[] {
  if (m.tiles && m.tiles.length) return m.tiles;
  const loX = -Math.ceil((m.w - 1) / 2), loY = -Math.ceil((m.h - 1) / 2);
  const out: PathPt[] = [];
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) out.push([loX + i, loY + j]);
  return out;
}

/** A mover's tile bounds as offsets from its anchor: from the lowest to the highest tile. */
export function tileBounds(m: Mover): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const [x, y] of tilesOf(m)) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** The waypoints of a drawn mover (relative cells). One point is not a drawn mover. */
export const isDrawn = (v: unknown): v is Mover =>
  !!v && typeof v === 'object' && Array.isArray((v as Mover).path) && (v as Mover).path!.length >= 2;

/** Catmull-Rom through the waypoints: a curve that passes through each of them, T = 0.5 (centripetal-ish, no loops on sharp corners). */
export function smoothPath(pts: PathPt[], samplesPerSegment = 8): PathPt[] {
  if (pts.length < 3) return pts;
  const at = (i: number): PathPt => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const out: PathPt[] = [];
  for (let s = 0; s < pts.length - 1 - 0; s++) {
    const p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
    for (let j = s === 0 ? 0 : 1; j <= samplesPerSegment; j++) {
      const t = j / samplesPerSegment, t2 = t * t, t3 = t2 * t;
      out.push([
        round(0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)),
        round(0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)),
      ]);
    }
  }
  return out;
}

/** The drawn route as one polyline of cells, corners and all (a plain mover has none). */
export function routePoints(m: Mover): PathPt[] {
  return m.smooth && isDrawn(m) ? smoothPath(m.path!) : (m.path && m.path.length >= 2 ? m.path : []);
}

/** Cumulative length along the polyline, then the offset (dx, dy) at progress k (0..1) - what the sim, the playtest and the drawing all share. */
export function offsetAlong(m: Mover, k: number): PathPt {
  const pts = routePoints(m);
  if (!pts.length) return [m.dx * k, m.dy * k];
  if (k <= 0) return pts[0];
  if (k >= 1) return pts[pts.length - 1];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += stepLen(pts[i - 1], pts[i]);
  let target = k * total, walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = stepLen(pts[i - 1], pts[i]);
    if (walked + seg >= target) {
      const f = seg > 0 ? (target - walked) / seg : 0;
      return [round(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f), round(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f)];
    }
    walked += seg;
  }
  return pts[pts.length - 1];
}

const stepLen = (a: PathPt, b: PathPt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

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

/** The zip sprite: 96 x 96 of three-band rows/columns (caps and rails at the border, the quilted core in the middle) meant to be 9-sliced as one connected texture. */
const ZIP_BORDER = 32; // one third: a tile takes exactly one third of the sprite

/** The platform's body. The zip look draws the sprite's thirds per tile, chosen from the tile's position in the shape, so the
 * platform reads as one connected sprite (caps at the ends, the core repeating between them) - and painting tiles anywhere extends it.
 * Tile-set looks stay the autotiled block they were. */
function body(env: DrawEnv, x: number, y: number, m: Mover, size: number, alpha: number): void {
  const ctx = env.ctx;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  const tiles = tilesOf(m), { minX, maxX, minY, maxY } = tileBounds(m);
  const ts = m.look !== 'zip' ? tileSet(m.look) : null;
  const set = ts && ts.id === m.look ? ts : null; // an unknown look falls back to the zip art, like before
  const src = set ? null : env.atlas.source('obj_zipmover');
  if (set) {
    // a tile-set look: the autotiled block, one resolved cell per tile over the shape
    const has = (tx: number, ty: number): boolean => tiles.some(([a, b]) => a === tx && b === ty);
    for (const [tx, ty] of tiles) {
      const px = Math.round(x + (tx - minX) * size), py = Math.round(y + (maxY - ty) * size), s = Math.round(x + (tx - minX + 1) * size) - px;
      const r = resolveCell(set, (dx, dy) => has(tx + dx, ty + dy));
      drawResolved(env.atlas, ctx, r, px, py, s);
    }
  } else if (src) {
    // one connected texture: each tile takes the sprite's matching third, chosen by tile adjacency (like a 9-slice),
    // so caps land on the shape's edges and the quilted core fills runs in between - and a plain 3x3 is the sprite 1:1
    const gw = src.w / 3, gh = src.h / 3;
    const has = (tx: number, ty: number): boolean => tiles.some(([a, b]) => a === tx && b === ty);
    for (const [tx, ty] of tiles) {
      const px = Math.round(x + (tx - minX) * size), py = Math.round(y + (maxY - ty) * size), s = Math.round(x + (tx - minX + 1) * size) - px;
      const west = has(tx - 1, ty), east = has(tx + 1, ty), north = has(tx, ty + 1), south = has(tx, ty - 1);
      const cx3 = west && east ? 1 : west ? 2 : east ? 0 : 1; // column thirds: left cap, run, right cap, middle when alone
      const cy3 = north && south ? 1 : north ? 2 : south ? 0 : 1; // row thirds: top cap, run, bottom cap, middle when alone
      ctx.drawImage(src.img, src.x + cx3 * gw, src.y + cy3 * gh, gw, gh, px, py, s, s);
    }
  } else if (src) {
    for (const [tx, ty] of tiles) {
      const px = Math.round(x + (tx - minX) * size), py = Math.round(y + (maxY - ty) * size), s = Math.round(x + (tx - minX + 1) * size) - px;
      env.atlas.stretch(ctx, 'obj_zipmover', px, py, s, s);
    }
  } else {
    for (const [tx, ty] of tiles) {
      const px = Math.round(x + (tx - minX) * size), py = Math.round(y + (maxY - ty) * size), s = Math.round(x + (tx - minX + 1) * size) - px;
      ctx.fillStyle = '#8b8d86'; ctx.fillRect(px, py, s, s);
    }
  }
  ctx.globalAlpha = prev;
}

/** Draw a mover's platform with its top-left at (x, y) pixels - also how the playtest draws it in motion. */
export const drawMoverBody = body;

/** The zip's route strip: the art's riveted rail edge repeated along the line - the game's own track look. */
function drawStrip(env: DrawEnv, x1: number, y1: number, x2: number, y2: number, size: number, alpha: number): void {
  const ctx = env.ctx;
  const src = env.atlas.source('obj_zipmover');
  if (!src) {
    ctx.strokeStyle = 'rgba(220,114,236,' + alpha + ')';
    ctx.lineWidth = Math.max(1, size / 12);
    ctx.setLineDash([size / 3, size / 4]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const pw = 12 * (size / 32), ph = 8 * (size / 32); // each riveted band of the rail edge, scaled with the view
  const prev = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = prev * alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x1, y1);
  ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
  for (let t = pw / 2, len = Math.hypot(x2 - x1, y2 - y1) + pw / 2; t < len; t += pw) {
    ctx.drawImage(src.img, src.x + 42, src.y + src.h - 8, 12, 8, t - pw / 2, -ph / 2, pw, ph);
  }
  ctx.restore();
}

/** The zip's cog node, drawn big like the game does: the mount the platform rides out to. */
function drawCog(env: DrawEnv, x: number, y: number, size: number, alpha = 1): void {
  const ctx = env.ctx;
  const src = env.atlas.source('obj_zipnode');
  if (!src) {
    ctx.fillStyle = 'rgba(220,114,236,' + alpha + ')';
    ctx.beginPath(); ctx.arc(x, y, size * 0.5, 0, Math.PI * 2); ctx.fill();
    return;
  }
  const cog = size * 1.05;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.imageSmoothingEnabled = false;
  // the gear sits inside the 96 x 96 sprite with padding: crop its own box so it fills the node
  ctx.drawImage(src.img, src.x + 25, src.y + 25, 48, 46, x - cog / 2, y - cog / 2, cog, cog);
  ctx.globalAlpha = prev;
}

/** The picker's presets: one zip mover — the 3 x 3 tile platform. Its mode, direction and look are the brush's options (motion, direction, block kind); drawing its route is the zip path tool's job. */
const PRESETS: Record<string, { label: string; value: Partial<Mover> }> = {
  zip: { label: 'Zip mover', value: {} },
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
  brushes: Object.entries(PRESETS).map(([id, p]): Brush => ({ id, label: p.label, group: 'Moving', thumb: { mover: { ...MOVER_DEFAULT, ...p.value } } })),
  place: (brush) => ({ ...MOVER_DEFAULT, ...(PRESETS[brush.id]?.value ?? {}) }),
  brushOf(value) {
    if (!value) return null;
    // one zip type: every mover is the zip brush, whatever it is like (its options say the rest)
    return { brush: movers.brushes.find((b) => b.id === 'zip') as Brush };
  },
  options(value?: unknown): OptionDef[] {
    const isd = value !== undefined && isDrawn(norm(value));
    const pathLen = (m: Mover): number => {
      const pts = routePoints(m);
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += stepLen(pts[i - 1], pts[i]);
      return total;
    };
    return [
      { key: 'look', label: 'Block kind', type: 'select', choices: LOOKS, hint: "What the platform is made of. The editor shows it; the game plays its own zip mover.", get: (v) => norm(v).look, set: (v, x) => move(norm(v), { look: String(x) }) },
      ...(isd ? [] : [{ key: 'dir', label: 'Direction', type: 'select', hint: 'Which way it rides from its start. Pick a direction, then set the distance.', get: (v) => dirOf(norm(v)),
        choices: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }, { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }, { value: 'custom', label: 'Custom (diagonal)' }],
        set: (v: unknown, x: unknown) => {
          const m = norm(v), d = Math.max(1, Math.round(distance(m)) || 1);
          const to: Record<string, [number, number]> = { right: [d, 0], left: [-d, 0], up: [0, d], down: [0, -d] };
          const t = to[String(x)];
          return t ? move(m, { dx: t[0], dy: t[1] }) : m;
        } } as OptionDef]),
      { key: 'dist', label: isd ? 'Length' : 'Distance', type: 'number', min: 1, max: 400, step: 1, unit: 'cells', hint: isd ? 'How long the drawn route is.' : 'How far it rides (the trip keeps its speed).',
        get: (v) => round(isd ? pathLen(norm(v)) : distance(norm(v))),
        set: (v, x) => {
          const m = norm(v);
          if (isd) {
            // scale the whole drawn route to the length asked for
            const now = pathLen(m), n = Math.max(1, Number(x)), k = now > 0 ? n / now : 1;
            if (Math.abs(k - 1) < 0.001) return m;
            return { ...m, time: round(m.time * k, 3), back: round(m.back * k, 3) };
          }
          const d = distance(m), n = Math.max(1, Number(x));
          if (d === 0) return move(m, { dx: n });
          const k = n / d;
          return move(m, { dx: round(m.dx * k), dy: round(m.dy * k), time: round(m.time * k, 3), back: round(m.back * k, 3) });
        } },
      { key: 'speed', label: 'Speed', type: 'number', min: 0.5, max: 100, step: 0.5, unit: 'cells/s', hint: 'How fast it rides out (the return keeps its own time).',
        get: (v) => { const m = norm(v); const d = isd ? pathLen(m) : distance(m); return round(m.time > 0 ? d / m.time : 0); },
        set: (v, x) => { const m = norm(v); const d = isd ? pathLen(m) : distance(m); return move(m, { time: round(d / Math.max(0.1, Number(x)), 3) }); } },
      set('back', 'Return time', MOVER_DEFAULT.back, { min: 0.2, max: 120, step: 0.25, unit: 's', hint: 'Seconds to ride back to the start.' }),
      { key: 'mode', label: 'Motion', type: 'select', hint: 'Ping-pong: loops there and back on its own. On touch: waits until the player stands on it.', get: (v) => (norm(v).auto ? 'loop' : 'touch'),
        choices: [{ value: 'loop', label: 'Ping-pong loop' }, { value: 'touch', label: 'On touch' }],
        set: (v, x) => move(norm(v), { auto: String(x) === 'loop' }) },
      set('pause', 'Start delay', MOVER_DEFAULT.pause, { min: 0, max: 30, step: 0.25, unit: 's', hint: 'How long it rests before leaving (after the touch, for an on-touch mover).' }),
      set('pauseBack', 'Wait at end', MOVER_DEFAULT.pauseBack, { min: 0, max: 30, step: 0.25, unit: 's' }),
      ...(norm(value).tiles ? [] : [
        set('w', 'Width', MOVER_DEFAULT.w, { min: 1, max: 40, step: 1, unit: 'cells' }),
        set('h', 'Height', MOVER_DEFAULT.h, { min: 1, max: 40, step: 1, unit: 'cells' }),
      ]),
      ...(isd ? [] : [
        set('dx', 'End offset X', MOVER_DEFAULT.dx, { min: -200, max: 200, step: 1, unit: 'cells', hint: 'The end point, sideways from the start (negative: left).' }),
        set('dy', 'End offset Y', MOVER_DEFAULT.dy, { min: -200, max: 200, step: 1, unit: 'cells', hint: 'The end point, up from the start (negative: down).' }),
      ]),
      ...(isd ? [{ key: 'smooth', label: 'Curve', type: 'select', hint: 'Smooth: the platform rides a curve through the drawn shape. Corners: it rims the shape you drew, cell by cell.', get: (v) => (norm(v).smooth === false ? 'corner' : 'smooth'),
        choices: [{ value: 'smooth', label: 'Smooth curve' }, { value: 'corner', label: 'Drawn corners' }],
        set: (v: unknown, x: unknown) => move(norm(v), { smooth: String(x) !== 'corner' }) } as OptionDef] : []),
      groupOption(),
    ];
  },
  draw(env: DrawEnv, _map, _x, _y, value, sx, sy, size) {
    const m = norm(value);
    const ctx = env.ctx;
    // the platform is centred on its anchor cell: its tiles sit around it (body and box agree through tileBounds)
    const cx = sx + size / 2, cy = sy + size / 2;
    const b = tileBounds(m);
    const x0 = cx + b.minX * size - size / 2, y0 = cy - (b.maxY + 0.5) * size;
    ctx.save();
    if (isDrawn(m)) {
      // the drawn route: a curve (or the raw polyline) through the shape, a node at each drawn cell, and the cog at the end
      const pts = routePoints(m);
      const stroke = (alpha: number): void => {
        ctx.strokeStyle = 'rgba(220,114,236,' + alpha + ')';
        ctx.lineWidth = Math.max(1, size / 12);
        ctx.setLineDash([size / 3, size / 4]);
        ctx.beginPath();
        ctx.moveTo(cx + pts[0][0] * size, cy - pts[0][1] * size);
        if (m.smooth === false) for (let i = 1; i < pts.length; i++) ctx.lineTo(cx + pts[i][0] * size, cy - pts[i][1] * size);
        else for (let i = 1; i < pts.length - 1; i++) {
          const mx = cx + (pts[i][0] + pts[i + 1][0]) * size / 2, my = cy - (pts[i][1] + pts[i + 1][1]) * size / 2;
          ctx.quadraticCurveTo(cx + pts[i][0] * size, cy - pts[i][1] * size, mx, my);
        }
        ctx.lineTo(cx + pts[pts.length - 1][0] * size, cy - pts[pts.length - 1][1] * size);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      stroke(0.8);
      // cells you drew: a node at each waypoint (the samples just shape the line)
      ctx.fillStyle = 'rgba(220,114,236,0.95)';
      for (const [px, py] of m.path!) {
        ctx.beginPath();
        ctx.arc(cx + px * size, cy - py * size, Math.max(2, size / 7), 0, Math.PI * 2);
        ctx.fill();
      }
      body(env, x0 + m.dx * size, y0 - m.dy * size, m, size, 0.35);
      if (env.atlas.has('obj_zipnode')) drawCog(env, cx + m.dx * size, cy - m.dy * size, size);
      stroke(0.35);
    } else {
      // the route: the game's riveted rail strip repeated along the line, the cog at the end, the ghost platform riding it
      const ex = cx + m.dx * size, ey = cy - m.dy * size;
      drawStrip(env, cx, cy, ex, ey, size, 0.8);
      body(env, x0 + m.dx * size, y0 - m.dy * size, m, size, 0.35);
      if (env.atlas.has('obj_zipnode')) drawCog(env, ex, ey, size);
    }
    ctx.restore();
    body(env, x0, y0, m, size, 1);
    ctx.strokeStyle = m.auto ? '#dc72ec' : '#ffd24a';
    ctx.lineWidth = Math.max(1, size / 16);
    ctx.strokeRect(x0, y0, (b.maxX - b.minX + 1) * size, (b.maxY - b.minY + 1) * size);
  },
  toJson(map, sink: JsonSink) {
    for (const { data } of eachLayer(map, MOVERS)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const m = norm(value);
        const c = parseKey(key);
        const drawn = isDrawn(m);
        const bounds = tileBounds(m);
        const tiles = tilesOf(m);
        sink.objects.push({
          type: 'clone', ...ZIP_SOURCE, x: c.x * CELL + CELL / 2, y: c.y * CELL + CELL / 2, order: 0,
          zip: {
            // a drawn mover carries its route (level units) and its corner/curve choice; end mirrors the route's end so older
            // loaders (and the fallback) move the platform straight the same way
            ...(drawn ? { path: m.path!.map(([px, py]) => [px * CELL, py * CELL]), smooth: m.smooth !== false } : {}),
            end: drawn ? [m.path![m.path!.length - 1][0] * CELL, m.path![m.path!.length - 1][1] * CELL] : [m.dx * CELL, m.dy * CELL],
            time: m.time, backTime: m.back, size: [(bounds.maxX - bounds.minX + 1) * CELL, (bounds.maxY - bounds.minY + 1) * CELL],
            // one rectangle per platform tile, from the anchor out (the loader hangs a sprite slice + collider per tile)
            rects: tiles.map(([tx, ty]) => [tx * CELL, ty * CELL, CELL, CELL]),
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
  /** A mover is hit anywhere along its platform or (a drawn one) its route, so erasing and picking find its anchor that way. */
  cellOf(x, y, map, dl) {
    if (!map || !dl) return null;
    const tile = tileMoverAt(map, dl, x, y);
    if (tile) return parseKey(tile.key);
    return moverAt(map, dl, x, y);
  },
  /** Erasing one tile shortens the platform; erasing its anchor (or a drawn route) removes the whole mover. */
  eraseAt(x, y, map, dl) {
    if (!map || !dl) return null;
    const tile = tileMoverAt(map, dl, x, y);
    if (!tile) return null;
    const o = parseKey(tile.key);
    if (o.x === x && o.y === y) return { key: tile.key, value: undefined };
    const rest = tilesOf(tile.mover).filter(([a, b]) => o.x + a !== x || o.y + b !== y);
    if (!rest.length) return { key: tile.key, value: undefined };
    return { key: tile.key, value: { ...tile.mover, tiles: rest } };
  },
};

/** A mover's platform and its end position as boxes in level units (for the simulation): start, end - the tiles' bounds. */
export function moverBoxes(key: string, value: unknown): { start: { x: number; y: number; w: number; h: number }; end: { x: number; y: number; w: number; h: number } } {
  const m = norm(value);
  const c = parseKey(key);
  const { minX, maxX, minY, maxY } = tileBounds(m);
  const x = (c.x + minX) * CELL, y = (c.y + minY) * CELL, w = (maxX - minX + 1) * CELL, h = (maxY - minY + 1) * CELL;
  return { start: { x, y, w, h }, end: { x: x + m.dx * CELL, y: y + m.dy * CELL, w, h } };
}

/** The mover whose platform tile is this cell (its key is the anchor), or null: what painting a tile onto a mover extends. */
export function tileMoverAt(map: AmpMap, dl: string, x: number, y: number): { key: string; mover: Mover } | null {
  const data = map.layers[dl];
  if (!data) return null;
  for (const [key, v] of data) {
    const m = norm(v);
    if (typeof m !== 'object' || Array.isArray(v)) continue;
    const o = parseKey(key);
    if (tilesOf(m).some(([tx, ty]) => o.x + tx === x && o.y + ty === y)) return { key, mover: m };
  }
  return null;
}

/** The drawn mover whose route is closest to this cell (within half a cell of the curve), i.e. its anchor - null otherwise. */
export function moverAt(map: AmpMap, dl: string, x: number, y: number): { x: number; y: number } | null {
  let best: { key: string; dist: number } | null = null;
  const data = map.layers[dl];
  if (!data) return null;
  for (const [key, v] of data) {
    if (!isDrawn(v)) continue;
    const o = parseKey(key);
    for (const pts of sampleRoutes(v)) {
      for (const [px, py] of pts) {
        const d = Math.hypot(o.x + px - x, o.y + py - y);
        if (d <= 0.5 && (!best || d < best.dist)) best = { key, dist: d };
      }
    }
  }
  return best ? parseKey(best.key) : null;
}

/** The drawn mover's routes as polylines of absolute cells (one per drawn mover: its sampled curve). */
function sampleRoutes(m: Mover): PathPt[][] {
  const pts = routePoints(m);
  return pts.length >= 2 ? [pts] : [];
}
