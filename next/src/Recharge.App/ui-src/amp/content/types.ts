/** A content type is one self-contained kind of thing in a map: its layers, picker entries, options, how it draws, and how it saves and loads. */
import type { Atlas } from '../atlas.js';
import type { Role } from '../core/layers.js';
import type { AmpMap } from '../core/map.js';
import type { Cell, Json } from '../core/types.js';
import type { JsonSink } from './sink.js';

export interface Brush {
  /** Unique within its content type. */
  id: string;
  label: string;
  /** Picker group heading. */
  group: string;
  /** What the picker thumbnail shows: the game's tiles, one sprite, a deco image, or a letter. */
  thumb: { vine?: string; moss?: boolean; set?: string; tile?: string; sprite?: string; deco?: string; matrix?: readonly number[]; glyph?: string; color?: string; arrow?: boolean };
}

/**
 * One configurable option of a placed thing (or of the brush that places it). A content type declares its options as data;
 * the Properties panel builds its controls from that, so no panel code knows any content type.
 */
export interface OptionDef {
  key: string;
  label: string;
  type: 'number' | 'bool' | 'select' | 'text' | 'color';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  choices?: Array<{ value: string; label: string }>;
  hint?: string;
  /** Read the option from a stored value (`ctx`: the map and the selected key, for options that live elsewhere in the map). */
  get(value: unknown, ctx?: OptionCtx): unknown;
  /** The value with the option changed (never mutates). */
  set(value: unknown, v: unknown, ctx?: OptionCtx): unknown;
  /** When the option is not part of the value (a course's reward): the map edits that changing it makes, in place of `set`. */
  edits?(value: unknown, v: unknown, ctx: OptionCtx): Array<{ layer: string; key: string; value: unknown }>;
}

/** What an option may look at beyond its own value: the map, and the selected thing's data layer and key (none for the brush). */
export interface OptionCtx { map: AmpMap; layer?: string; key?: string }

export interface PlaceOptions { text: string }

export interface DrawEnv { ctx: CanvasRenderingContext2D; atlas: Atlas }

export interface ContentType {
  id: string;
  label: string;
  /** The map layer id (per editor layer: `dataLayer`) this content stores values in (cell key -> value). */
  layer: string;
  /** The editor cell a thing covering editor cell (x, y) is stored under, when it is bigger than a cell (moss). Default: the cell itself. */
  cellOf?(x: number, y: number, map?: AmpMap, dl?: string): Cell;
  /** After a selected thing is deleted: tidy what depended on it (`edit` records the change in the same undo step). */
  cleanup?(map: AmpMap, edit: (layer: string, key: string, value: unknown) => void): void;
  /** The area a thing at editor cell (x, y) covers, in map units (y up), for the hover outline. Default: the cell. */
  outline?(x: number, y: number): { x0: number; y0: number; x1: number; y1: number };
  /** Which editor layer roles it can live in. */
  roles: Role[];
  /** One thing per cell in an editor layer: placing it replaces other exclusive things there. */
  exclusive: boolean;
  /** Drawn by its own pass (may spill over its cell) instead of the cell picture cache. */
  live?: boolean;
  /** A live content type that, in the main layer, sits behind the cell picture (scenery) instead of over it. */
  behind?: boolean;
  brushes: Brush[];
  /** The value a brush places (undefined: the brush does not apply). */
  place(brush: Brush, opts: PlaceOptions): unknown;
  /** The brush that placed a stored value (for the eyedropper). */
  brushOf(value: unknown): { brush: Brush } | null;
  /** The options a value has. */
  options(value: unknown, ctx?: OptionCtx): OptionDef[];
  /** Turn a value a quarter turn counter-clockwise (when it can turn). */
  rotate?(value: unknown, by: number): unknown;
  /** Draw the stored value of cell (x, y) into the square at (sx, sy) of side `size`; `dl` is the data layer it lives in. */
  draw(env: DrawEnv, map: AmpMap, x: number, y: number, value: unknown, sx: number, sy: number, size: number, dl: string): void;
  /** Write the layers into a file being saved. */
  toJson(map: AmpMap, sink: JsonSink): void;
  /** Read from a file that has no `amp` layers (made elsewhere, or an older version). */
  fromJson(json: Json, map: AmpMap): void;
}

/** The `amp` block's layer pairs of a file: [key, value] lists by data-layer id. */
export function ampLayer(json: Json, id: string): Array<[string, unknown]> | null {
  const amp = json.amp as { layers?: Record<string, Array<[string, unknown]>> } | undefined;
  const pairs = amp?.layers?.[id];
  return Array.isArray(pairs) ? pairs : null;
}

// ---- option builders ----
export const numberOption = (key: string, label: string, def: number, extra: Partial<OptionDef> = {}): OptionDef => ({
  key, label, type: 'number', min: 0, max: 999, step: 1, ...extra,
  get: (v) => { const x = (v as Record<string, unknown>)?.[key]; return typeof x === 'number' ? x : def; },
  set: (v, x) => ({ ...(v as Record<string, unknown>), [key]: Number(x) }),
});
export const boolOption = (key: string, label: string, def: boolean, extra: Partial<OptionDef> = {}): OptionDef => ({
  key, label, type: 'bool', ...extra,
  get: (v) => { const x = (v as Record<string, unknown>)?.[key]; return typeof x === 'boolean' ? x : def; },
  set: (v, x) => ({ ...(v as Record<string, unknown>), [key]: !!x }),
});
export const textOption = (key: string, label: string, def: string, extra: Partial<OptionDef> = {}): OptionDef => ({
  key, label, type: 'text', ...extra,
  get: (v) => { const x = (v as Record<string, unknown>)?.[key]; return typeof x === 'string' ? x : def; },
  set: (v, x) => ({ ...(v as Record<string, unknown>), [key]: String(x) }),
});
export const selectOption = (key: string, label: string, def: string, choices: Array<{ value: string; label: string }>, extra: Partial<OptionDef> = {}): OptionDef => ({
  key, label, type: 'select', choices, ...extra,
  get: (v) => { const x = (v as Record<string, unknown>)?.[key]; return typeof x === 'string' ? x : def; },
  set: (v, x) => ({ ...(v as Record<string, unknown>), [key]: String(x) }),
});

/** The group id a placed thing belongs to (a trigger shows / hides / moves a group). Empty removes it. */
export const groupOption = (): OptionDef => ({
  key: 'group', label: 'Group', type: 'text', hint: 'A name that trigger zones can act on (show, hide, toggle or move the group).',
  get: (v) => { const x = (v as Record<string, unknown>)?.group; return typeof x === 'string' ? x : ''; },
  set: (v, x) => { const { group: _g, ...rest } = (v as Record<string, unknown>) || {}; return String(x) ? { ...rest, group: String(x) } : rest; },
});
