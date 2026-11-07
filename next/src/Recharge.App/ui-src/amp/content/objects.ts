/** Placeable things: a spring, a checkpoint, a sign. One per cell; they save as the game's own object types. */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, parseKey, type Json } from '../core/types.js';
import type { JsonSink } from './sink.js';
import { courseById, courses } from './coursedata.js';
import { ampLayer, groupOption, numberOption, textOption, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const OBJECTS = 'objects';

/** A level sign's text object the game copies (the same one the Amplifier's signs use). */
export const SIGN_SOURCE = 'zone 2/Area1/Lighting objects/CoolStatue/StatuePrestigeText';

/** A checkpoint's trigger box (w, h and the box centre's offset dx, dy from the flag), in level units: the old editor's trig. */
export interface Trigger { w: number; h: number; dx: number; dy: number }
/** The boxes the game's own checkpoints have (the old catalog's "Checkpoint" and "Course checkpoint"). */
export const CHECKPOINT_BOX: Record<string, Trigger> = { checkpoint: { w: 400, h: 400, dx: 0, dy: 150 }, courseCheckpoint: { w: 100, h: 300, dx: 0, dy: 100 } };
export const isCheckpoint = (t: unknown): boolean => t === 'checkpoint' || t === 'courseCheckpoint';
/** A checkpoint's trigger: its own size when the map sets one, else the game's. */
export const trigOf = (o: PlacedObject): Trigger => ({ ...CHECKPOINT_BOX[o.t === 'courseCheckpoint' ? 'courseCheckpoint' : 'checkpoint'], ...(o.trig || {}) });
/** Where a checkpoint's flag and respawn point sit: at the object's own position, the box around it (checkpoint.js checkpointExport). */
export const checkpointExport = (x: number, y: number, t: Trigger): { x: number; y: number; trigger: Trigger } => ({ x: Math.round(x), y: Math.round(y), trigger: { w: t.w, h: t.h, dx: t.dx, dy: t.dy } });

export interface PlacedObject { t: 'spring' | 'checkpoint' | 'courseCheckpoint' | 'sign'; course?: string; trig?: Partial<Trigger>; text?: string; strength?: number; upForce?: number; width?: number; height?: number; color?: string; alpha?: number; group?: string }

/** The spring's own values in the game (SpringScript.strength / upForce), used when none are set. */
export const SPRING_DEFAULTS = { strength: 80, upForce: 70 };

/** Where the thing sits above the bottom of its cell: a spring and a checkpoint stand on the floor under the cell, a sign is centred. */
export const LIFT: Record<string, number> = { spring: 64, checkpoint: 48, courseCheckpoint: 48, sign: 16 };
const SPRITE: Record<string, string> = { spring: 'obj_spring', checkpoint: 'obj_checkpoint', courseCheckpoint: 'obj_checkpoint' };

const hexToRgb = (hex: string): number[] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0.482, 0.714, 0.322];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => Math.round(v * 1000) / 1000);
};

const STRENGTH = numberOption('strength', 'Bounce strength', SPRING_DEFAULTS.strength, { min: 10, max: 300, step: 5, hint: "How hard the spring pushes sideways (the game's own default is 80)." });
const UPFORCE = numberOption('upForce', 'Bounce height', SPRING_DEFAULTS.upForce, { min: 10, max: 300, step: 5, hint: "How hard it pushes up (the game's own default is 70)." });

const trigOption = (key: keyof Trigger, label: string, min: number, hint?: string): OptionDef => ({
  ...numberOption(key, label, 0, { min, max: 4000, step: 10, unit: 'units', hint }),
  get: (v) => trigOf(v as PlacedObject)[key],
  set: (v, x) => { const o = v as PlacedObject; return { ...o, trig: { ...trigOf(o), [key]: Number(x) } }; },
});

/** A checkpoint's options: which course it counts for, and its trigger box. */
function checkpointOptions(map: AmpMap | undefined): OptionDef[] {
  const cs = map ? courses(map) : [];
  const link: OptionDef = {
    key: 'course', label: 'Belongs to', type: 'select',
    hint: 'Filed under a course, this checkpoint only counts during that course\'s run; "Any course" always counts.',
    choices: [{ value: '', label: 'Any course' }, ...cs.map((c, i) => ({ value: c.id, label: 'Course ' + (i + 1) }))],
    get: (v) => { const id = (v as PlacedObject)?.course; return id && cs.some((c) => c.id === id) ? id : ''; },
    set: (v, x) => { const { course: _c, ...rest } = (v as PlacedObject) || {}; return String(x) ? { ...rest, course: String(x) } : rest; },
  };
  return [
    link,
    trigOption('w', 'Trigger width', 10, 'The box that sets the respawn when the player touches it.'),
    trigOption('h', 'Trigger height', 10),
    trigOption('dx', 'Box offset X', -4000, "Where the box's centre sits from the flag."),
    trigOption('dy', 'Box offset Y', -4000),
  ];
}

export const objects: ContentType = {
  id: 'objects',
  label: 'Objects',
  layer: OBJECTS,
  roles: ['main'],
  exclusive: true,
  brushes: [
    { id: 'spring', label: 'Spring', group: 'Objects', thumb: { sprite: 'obj_spring' } },
    { id: 'checkpoint', label: 'Checkpoint', group: 'Checkpoints', thumb: { sprite: 'obj_checkpoint' } },
    { id: 'courseCheckpoint', label: 'Course checkpoint', group: 'Checkpoints', thumb: { sprite: 'obj_checkpoint', color: '#ffb347' } },
    { id: 'sign', label: 'Sign', group: 'Objects', thumb: { glyph: 'T', color: '#7bb652' } },
  ],
  place: (brush, opts) => (brush.id === 'sign' ? { t: 'sign', text: opts.text || 'Sign' } : { t: brush.id }),
  brushOf: (value) => {
    const o = value as PlacedObject | undefined;
    const b = o && objects.brushes.find((x) => x.id === o.t);
    return b ? { brush: b } : null;
  },
  options(value, ctx): OptionDef[] {
    const t = (value as PlacedObject | undefined)?.t;
    if (t === 'spring') return [STRENGTH, UPFORCE, groupOption()];
    if (isCheckpoint(t)) return [...checkpointOptions(ctx?.map), groupOption()];
    if (t === 'sign') return [
      textOption('text', 'Text', 'Sign', { hint: 'What the sign says.' }),
      { ...textOption('color', 'Colour', '#7bb652'), type: 'color' },
      numberOption('alpha', 'Opacity', 1, { min: 0, max: 1, step: 0.1 }),
      groupOption(),
    ];
    return [];
  },
  draw(env: DrawEnv, _map, _x, _y, value, sx, sy, size) {
    const o = value as PlacedObject;
    const ctx = env.ctx;
    const k = size / CELL;
    const sprite = SPRITE[o?.t];
    if (sprite && env.atlas.has(sprite)) {
      const [w, h] = env.atlas.size(sprite) as [number, number];
      // centred above the bottom of the cell
      const cx = sx + size / 2, cy = sy + size - LIFT[o.t] * k;
      env.atlas.draw(ctx, sprite, cx - (w / 2) * k, cy - (h / 2) * k, size);
      return;
    }
    if (o?.t === 'sign') {
      ctx.fillStyle = (o.color || '#7bb652');
      ctx.globalAlpha *= o.alpha ?? 1;
      ctx.font = '700 ' + Math.max(8, Math.round(size * 0.5)) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((o.text || 'Sign').slice(0, 24), sx + size / 2, sy + size / 2);
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(123,182,82,0.5)';
      ctx.strokeRect(sx + 1, sy + 1, size - 2, size - 2);
      return;
    }
    ctx.fillStyle = '#ffd24a';
    ctx.fillRect(sx + size * 0.2, sy + size * 0.2, size * 0.6, size * 0.6);
  },
  toJson(map, sink: JsonSink) {
    for (const { data } of eachLayer(map, OBJECTS)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const o = value as PlacedObject;
        const c = parseKey(key);
        const x = c.x * CELL + CELL / 2, y = c.y * CELL + (LIFT[o.t] ?? CELL / 2);
        if (o.t === 'sign') {
          sink.objects.push({
            type: 'sign', path: SIGN_SOURCE, x, y, text: o.text || 'Sign', width: o.width ?? 281, height: o.height ?? 56,
            color: hexToRgb(o.color || '#7bb652'), rotation: 0, ...(o.alpha !== undefined && o.alpha !== 1 ? { alpha: o.alpha } : {}), ...(o.group ? { group: o.group } : {}), amp: true,
          });
        } else if (o.t === 'spring') {
          sink.objects.push({ type: 'spring', x, y, ...(o.strength !== undefined ? { strength: o.strength } : {}), ...(o.upForce !== undefined ? { upForce: o.upForce } : {}), ...(o.group ? { group: o.group } : {}), amp: true });
        } else if (isCheckpoint(o.t)) {
          // the old clone export: position, then the trigger (only when the map sized it), its course (only an existing one), the course-checkpoint flag
          const f = checkpointExport(x, y, trigOf(o));
          sink.objects.push({
            type: 'checkpoint', x: f.x, y: f.y, ...(o.trig ? { trigger: f.trigger } : {}), ...(o.course && courseById(map, o.course) ? { course: o.course } : {}),
            ...(o.t === 'courseCheckpoint' ? { courseCheckpoint: true } : {}), ...(o.group ? { group: o.group } : {}), amp: true,
          });
        }
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, OBJECTS);
    if (pairs) for (const [k, v] of pairs) if (v && typeof v === 'object' && ['spring', 'checkpoint', 'courseCheckpoint', 'sign'].includes((v as PlacedObject).t)) map.layer(OBJECTS).set(k, v);
  },
};
