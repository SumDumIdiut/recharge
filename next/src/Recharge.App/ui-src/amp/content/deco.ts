/** Scenery: the game's own plant and decoration sprites, placed as non-colliding art. They save as `gameSprite` objects. One per cell, centred on it. */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, parseKey, type Json } from '../core/types.js';
import { DECO_SPRITES } from '../deco-index.js';
import { decoSprite, drawDeco } from '../deco-art.js';
import type { JsonSink } from './sink.js';
import { ampLayer, boolOption, numberOption, type Brush, type ContentType, type DrawEnv, type OptionDef } from './types.js';

export const DECO = 'deco';

/** `an`: where the sprite sits on its cell - c: centred, t: hanging from the cell's top edge, b: standing on its bottom edge. */
export type Anchor = 'c' | 't' | 'b';
export interface Deco { s: string; an?: Anchor; fx?: boolean; fy?: boolean; sc?: number; r?: number; a?: number }

/** Drawing order of a scenery layer in the game: back = behind the walls, main = behind the ground (the game's default for scenery), front = over everything on the ground. */
export const FRONT_ORDER = 20;

/** Hanging plants hang from the cell; everything else stands on it. */
const defaultAnchor = (sprite: string): Anchor => (decoSprite(sprite)?.kind.startsWith('Hanging') ? 't' : 'b');

/** The sprite's centre in level units (y up) for the cell it is in. */
export function decoCentre(d: Deco, cx: number, cy: number): { x: number; y: number } {
  const sp = decoSprite(d.s);
  const H = (sp?.h ?? CELL) * (d.sc ?? 1);
  const x = cx * CELL + CELL / 2;
  return { x, y: d.an === 't' ? (cy + 1) * CELL - H / 2 : d.an === 'b' ? cy * CELL + H / 2 : cy * CELL + CELL / 2 };
}

const choices = DECO_SPRITES.map((d) => ({ value: d.sprite, label: d.label }));

export const deco: ContentType = {
  id: 'deco',
  label: 'Scenery',
  layer: DECO,
  roles: ['back', 'main', 'front'],
  exclusive: false,
  live: true,
  behind: true,
  brushes: DECO_SPRITES.map((d): Brush => ({ id: d.sprite, label: d.label, group: d.kind, thumb: { deco: d.sprite } })),
  place: (brush) => ({ s: brush.id, an: defaultAnchor(brush.id) }),
  brushOf: (value) => {
    const d = value as Deco | undefined;
    const b = d && deco.brushes.find((x) => x.id === d.s);
    return b ? { brush: b } : null;
  },
  options(): OptionDef[] {
    return [
      { key: 's', label: 'Sprite', type: 'select', choices, hint: 'Which of the game’s scenery sprites.', get: (v) => (v as Deco).s, set: (v, x) => ({ ...(v as Deco), s: String(x) }) },
      { key: 'an', label: 'Sits', type: 'select', choices: [{ value: 'b', label: 'On the cell (standing)' }, { value: 't', label: 'From the cell (hanging)' }, { value: 'c', label: 'Centred on the cell' }], hint: 'Hanging plants hang from the cell they are in; mounds and rocks stand on it.', get: (v) => (v as Deco).an ?? 'c', set: (v, x) => ({ ...(v as Deco), an: String(x) as Anchor }) },
      boolOption('fx', 'Flip left-right', false),
      boolOption('fy', 'Flip up-down', false),
      numberOption('sc', 'Scale', 1, { min: 0.2, max: 4, step: 0.1, hint: 'Size relative to the game’s own (1 = as in the level).' }),
      numberOption('r', 'Rotation', 0, { min: -180, max: 180, step: 15, unit: 'deg' }),
      numberOption('a', 'Opacity', 1, { min: 0.1, max: 1, step: 0.1 }),
    ];
  },
  rotate(value, by) {
    const d = value as Deco;
    return { ...d, r: ((((d.r ?? 0) + by * 90 + 180) % 360) + 360) % 360 - 180 };
  },
  draw(env: DrawEnv, _map, x, y, value, sx, sy, size) {
    const d = value as Deco;
    const sprite = decoSprite(d.s);
    if (!sprite) return;
    // the centre in level units, turned into pixels relative to the cell's own corner (y up -> y down)
    const c = decoCentre(d, x, y), k = size / CELL;
    const ok = drawDeco(env.ctx, sprite, sx + (c.x - x * CELL) * k, sy + size - (c.y - y * CELL) * k, k, { scale: d.sc, flipX: d.fx, flipY: d.fy, rotation: d.r, alpha: d.a });
    if (!ok) { env.ctx.fillStyle = 'rgba(123,182,82,0.4)'; env.ctx.fillRect(sx + size * 0.2, sy + size * 0.2, size * 0.6, size * 0.6); }
  },
  toJson(map, sink: JsonSink) {
    let order = 0;
    for (const { layer, data } of eachLayer(map, DECO)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const d = value as Deco;
        const c = parseKey(key);
        const sc = d.sc ?? 1;
        const at = decoCentre(d, c.x, c.y);
        sink.objects.push({
          type: 'gameSprite', sprite: d.s, x: at.x, y: at.y, scaleX: sc, scaleY: sc, rotation: d.r ?? 0,
          ...(d.a !== undefined && d.a !== 1 ? { alpha: d.a } : {}), ...(d.fx ? { flipX: true } : {}), ...(d.fy ? { flipY: true } : {}),
          ...(layer.role === 'back' ? { behind: true, depth: 2 } : layer.role === 'front' ? { drawOrder: FRONT_ORDER + order } : {}),
          amp: true,
        });
      }
      order++;
    }
  },
  fromJson(json: Json, map: AmpMap) {
    const pairs = ampLayer(json, DECO);
    if (pairs) for (const [k, v] of pairs) if (v && typeof v === 'object' && decoSprite((v as Deco).s)) map.layer(DECO).set(k, v);
  },
};
