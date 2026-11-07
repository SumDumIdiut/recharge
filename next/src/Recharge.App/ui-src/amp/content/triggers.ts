/**
 * Trigger zones: a rectangle that acts when the player walks into it (the old Amplifier's "triggers"). Each has a kind - switch the
 * music / background, show / hide / toggle / move a group, teleport, kill, swap block colours, set respawn, zoom the camera, show a
 * message. A zone is centred on its anchor cell; its size and any marker offset are in level units, exactly as the old editor kept them.
 * It saves as the same `trigger` object the old editor's triggerJson wrote.
 *
 * Not ported: the base level's own triggers (the new editor has no base level), the music / image file library (a media trigger
 * picks the game's tracks and "the level's own" background; a custom image already in a file is kept), and "group starts hidden".
 */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, parseKey, type Json } from '../core/types.js';
import type { JsonSink } from './sink.js';
import { ampLayer, boolOption, numberOption, selectOption, textOption, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const TRIGGERS = 'triggers';

export interface TriggerKind { label: string; group: string; color: string; glyph: string; about: string }

/** The old editor's TRIGGER_KINDS, in its order. */
export const TRIGGER_KINDS: Record<string, TriggerKind> = {
  media: { glyph: '♪', label: 'Music / background', group: 'Level', color: '#c792ff', about: 'switches them when the player walks in' },
  show: { glyph: '+', label: 'Show group', group: 'Groups', color: '#5fd4a0', about: 'turns a group on' },
  hide: { glyph: '−', label: 'Hide group', group: 'Groups', color: '#e0736a', about: 'turns a group off' },
  toggle: { glyph: '⇄', label: 'Toggle group', group: 'Groups', color: '#e0c36a', about: 'flips a group on / off' },
  move: { glyph: '↔', label: 'Move group', group: 'Groups', color: '#6aa8e0', about: 'slides a group by an offset' },
  teleport: { glyph: '◎', label: 'Teleport', group: 'Player', color: '#b07bff', about: 'sends the player to the marker' },
  kill: { glyph: '✕', label: 'Kill zone', group: 'Player', color: '#ff4f6d', about: 'kills the player like a spike' },
  swapBlocks: { glyph: '⇆', label: 'Swap block colours', group: 'Player', color: '#e0c36a', about: 'swaps blue and orange blocks' },
  respawn: { glyph: '⚑', label: 'Set respawn', group: 'Player', color: '#41f88d', about: 'the player respawns at the marker' },
  zoom: { glyph: '⌕', label: 'Camera zoom', group: 'Camera', color: '#7ad7f0', about: 'zooms the camera while inside' },
  message: { glyph: '✉', label: 'Message', group: 'Camera', color: '#f0f07a', about: 'shows text on screen' },
};
export const GROUP_KINDS = new Set(['show', 'hide', 'toggle', 'move']);
export const MARKER_KINDS = new Set(['teleport', 'respawn']);
/** The game's tracks a media trigger can switch to. */
export const GAME_TRACKS: Array<[string, string]> = [['Area1Track1', 'Area 1 - track 1'], ['Area1Track2', 'Area 1 - track 2'], ['Area2Track1', 'Area 2 - track 1'], ['Area2Track2', 'Area 2 - track 2'], ['TripBreaker', 'Trip breaker'], ['Overgrowth', 'Overgrowth']];

export interface Background { image: string; parallax?: number; scale?: number }
export interface Trigger {
  kind: string; w: number; h: number; once?: boolean;
  music?: string; background?: 'level' | Background;
  group?: string; dx?: number; dy?: number; time?: number; back?: boolean;
  tx?: number; ty?: number; size?: number; text?: string; seconds?: number;
}

/** A fresh trigger of a kind with the old editor's defaults (newTrigger). */
export function newTrigger(kind: string): Trigger {
  const t: Trigger = { kind, w: 256, h: 256 };
  if (kind === 'move') Object.assign(t, { dx: 0, dy: 256, time: 1 });
  if (MARKER_KINDS.has(kind)) Object.assign(t, { tx: 512, ty: 0 });
  if (kind === 'zoom') t.size = 1.5;
  if (kind === 'message') Object.assign(t, { text: 'Hello!', seconds: 3 });
  if (GROUP_KINDS.has(kind)) t.group = '1';
  return t;
}
const kindOf = (t: Trigger): string => (TRIGGER_KINDS[t.kind] ? t.kind : 'media');
const norm = (v: unknown): Trigger => ({ ...newTrigger('media'), ...((v as Partial<Trigger>) || {}) });

/** The text shown on a zone (the old triggerLabel). */
export function triggerLabel(t: Trigger): string {
  const k = kindOf(t), d = TRIGGER_KINDS[k];
  if (k === 'media') {
    const music = !t.music ? '' : t.music === 'level' ? 'level music' : t.music === 'none' ? 'silence' : (GAME_TRACKS.find(([id]) => 'game:' + id === t.music)?.[1] ?? t.music);
    const bg = !t.background ? '' : t.background === 'level' ? 'level background' : t.background.image;
    return [music ? '♪ ' + music : '', bg ? 'bg ' + bg : ''].filter(Boolean).join('  ·  ') || 'TRIGGER (does nothing yet)';
  }
  const extra = GROUP_KINDS.has(k) ? ' "' + (t.group || '?') + '"' + (k === 'move' ? ` by ${t.dx || 0}, ${t.dy || 0}` : '')
    : k === 'zoom' ? ' x' + (t.size || 1) : k === 'message' ? ': ' + (t.text || '') : '';
  return d.label.toUpperCase() + extra + (t.once ? ' (once)' : '');
}

/** The saved object, as the old triggerJson wrote it (the zone's centre is (x, y) in level units). */
export function triggerJson(t: Trigger, x: number, y: number): Json {
  const k = kindOf(t);
  const o: Json = { type: 'trigger', kind: k, x: Math.round(x), y: Math.round(y), w: t.w, h: t.h, ...(t.once ? { once: true } : {}) };
  if (k === 'media') Object.assign(o, t.music ? { music: t.music } : {}, t.background ? { background: t.background === 'level' ? 'level' : { image: t.background.image, parallax: t.background.parallax ?? 0.8, scale: t.background.scale ?? 1 } } : {});
  if (GROUP_KINDS.has(k)) o.group = t.group || '';
  if (k === 'move') Object.assign(o, { dx: t.dx || 0, dy: t.dy || 0, time: t.time ?? 1, ...(t.back ? { back: true } : {}) });
  if (MARKER_KINDS.has(k)) Object.assign(o, { tx: Math.round(x + (t.tx || 0)), ty: Math.round(y + (t.ty || 0)) });
  if (k === 'zoom') o.size = t.size || 1;
  if (k === 'message') Object.assign(o, { text: t.text || '', seconds: t.seconds ?? 3 });
  return o;
}

const patch = (v: unknown, p: Partial<Trigger>): Trigger => ({ ...norm(v), ...p });
const num = (key: keyof Trigger, label: string, def: number, extra: Partial<OptionDef> = {}): OptionDef => ({
  ...numberOption(key, label, def, extra),
  get: (v) => (norm(v)[key] as number | undefined) ?? def,
  set: (v, x) => patch(v, { [key]: Number(x) } as Partial<Trigger>),
});

const MUSIC_CHOICES = [{ value: '', label: 'No change' }, { value: 'level', label: "The level's own" }, { value: 'none', label: 'Silence' }, ...GAME_TRACKS.map(([id, t]) => ({ value: 'game:' + id, label: t }))];

export const triggers: ContentType = {
  id: 'triggers',
  label: 'Triggers',
  layer: TRIGGERS,
  roles: ['main'],
  exclusive: false,
  live: true,
  brushes: Object.entries(TRIGGER_KINDS).map(([id, d]): Brush => ({ id, label: d.label, group: d.group, thumb: { glyph: d.glyph, color: d.color } })),
  place: (brush) => newTrigger(brush.id),
  brushOf(value) {
    if (!value) return null;
    const b = triggers.brushes.find((x) => x.id === kindOf(norm(value)));
    return b ? { brush: b } : null;
  },
  options(value): OptionDef[] {
    const t = norm(value), k = kindOf(t);
    const out: OptionDef[] = [{
      key: 'kind', label: 'Kind', type: 'select', hint: TRIGGER_KINDS[k].about, choices: Object.entries(TRIGGER_KINDS).map(([v, d]) => ({ value: v, label: d.label })),
      get: (v) => kindOf(norm(v)),
      set: (v, x) => ({ ...newTrigger(String(x)), w: norm(v).w, h: norm(v).h, ...(norm(v).once ? { once: true } : {}), kind: String(x) }),
    }];
    if (k === 'media') {
      out.push({ ...selectOption('music', 'Music', '', MUSIC_CHOICES), get: (v) => norm(v).music ?? '', set: (v, x) => { const { music: _m, ...rest } = norm(v); return String(x) ? { ...rest, music: String(x) } : rest; } });
      const custom = typeof t.background === 'object';
      out.push({
        key: 'background', label: 'Background', type: 'select', hint: 'The level has no image library here: pick the level\'s own, or leave it.',
        choices: [{ value: '', label: 'No change' }, { value: 'level', label: "The level's own" }, ...(custom ? [{ value: 'custom', label: 'Image from the file' }] : [])],
        get: (v) => { const b = norm(v).background; return !b ? '' : b === 'level' ? 'level' : 'custom'; },
        set: (v, x) => { const { background: b, ...rest } = norm(v); const s = String(x); return s === 'level' ? { ...rest, background: 'level' } : s === 'custom' && b ? { ...rest, background: b } : rest; },
      });
      if (custom) {
        const bg = (v: unknown): Background => (norm(v).background as Background);
        out.push({ ...numberOption('parallax', 'Parallax', 0.8, { min: 0, max: 1, step: 0.05 }), get: (v) => bg(v).parallax ?? 0.8, set: (v, x) => patch(v, { background: { ...bg(v), parallax: Number(x) } }) });
        out.push({ ...numberOption('bgscale', 'Image scale', 1, { min: 0.05, max: 20, step: 0.1 }), get: (v) => bg(v).scale ?? 1, set: (v, x) => patch(v, { background: { ...bg(v), scale: Number(x) } }) });
      }
    }
    if (GROUP_KINDS.has(k)) out.push({ ...textOption('group', 'Group', '1', { hint: 'The group id of the things it acts on (give things the same id with their Group option).' }), get: (v) => norm(v).group ?? '' });
    if (k === 'move') {
      out.push(num('dx', 'Move right', 0, { min: -9999, max: 9999, step: 16, unit: 'units' }), num('dy', 'Move up', 256, { min: -9999, max: 9999, step: 16, unit: 'units' }));
      out.push(num('time', 'Seconds', 1, { min: 0, max: 600, step: 0.1, unit: 's' }), boolOption('back', 'Back on leaving', false));
    }
    if (MARKER_KINDS.has(k)) out.push(num('tx', 'Marker right', 512, { min: -9999, max: 9999, step: 16, unit: 'units', hint: 'The circle is where the player ends up.' }), num('ty', 'Marker up', 0, { min: -9999, max: 9999, step: 16, unit: 'units' }));
    if (k === 'zoom') out.push(num('size', 'Zoom', 1.5, { min: 0.1, max: 10, step: 0.1, hint: '1 = normal, 2 = see twice as far.' }));
    if (k === 'message') out.push(textOption('text', 'Text', 'Hello!'), num('seconds', 'Seconds on screen', 3, { min: 0.5, max: 600, step: 0.5, unit: 's' }));
    if (k !== 'zoom' && k !== 'kill') out.push(boolOption('once', 'Only the first time', false));
    out.push(num('w', 'Width', 256, { min: 16, max: 9999, step: 16, unit: 'units' }), num('h', 'Height', 256, { min: 16, max: 9999, step: 16, unit: 'units' }));
    return out;
  },
  draw(env: DrawEnv, _map, _x, _y, value, sx, sy, size) {
    const t = norm(value), d = TRIGGER_KINDS[kindOf(t)], ctx = env.ctx, k = size / CELL;
    const cx = sx + size / 2, cy = sy + size / 2, w = t.w * k, h = t.h * k;
    ctx.save();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color + '22';
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    if (MARKER_KINDS.has(kindOf(t))) {
      const mx = cx + (t.tx || 0) * k, my = cy - (t.ty || 0) * k;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx, my); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(mx, my, Math.max(4, 24 * k), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (size >= 6) {
      // the badge: the kind's glyph and, when there is room, its label
      const label = size >= 14 ? triggerLabel(t) : '';
      const fs = Math.max(9, Math.min(15, size * 0.6));
      ctx.font = '700 ' + fs + 'px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const text = label ? (label.startsWith(d.glyph) ? label : d.glyph + '  ' + label) : d.glyph;
      const bw = Math.min(w - 4, ctx.measureText(text).width + 12), bh = fs + 8;
      const bx = cx - w / 2 + 3, by = cy - h / 2 + 3;
      ctx.fillStyle = 'rgba(12,16,12,0.82)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = d.color;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = d.color;
      ctx.save();
      ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
      ctx.fillText(text, bx + 6, by + bh / 2 + 0.5);
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  },
  toJson(map, sink: JsonSink) {
    for (const { data } of eachLayer(map, TRIGGERS)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const c = parseKey(key);
        sink.objects.push({ ...triggerJson(norm(value), c.x * CELL + CELL / 2, c.y * CELL + CELL / 2), amp: true });
      }
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, TRIGGERS);
    if (pairs) for (const [k, v] of pairs) if (v && typeof v === 'object') map.layer(TRIGGERS).set(k, v);
  },
};
