/**
 * Node manifests: the declarative definition of a placeable item, read by both the editor and the game.
 * `parseManifest` validates and NORMALISES an untrusted node file into a safe NodeManifest - it drops unknown
 * behaviours and params, clamps numbers to each behaviour's range, and rejects option bindings that point nowhere.
 * A node file is data only; nothing here (or in the game) runs code from it. See docs/node-system.md.
 */
import { behaviorDef, clampParam, isBehavior, type ParamSpec } from './behaviors.js';

export const PLACEMENTS = ['cell', 'zone', 'point', 'path'] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const NODE_EVENTS = ['onLoad', 'enter', 'stay', 'exit'] as const;
export type NodeEvent = (typeof NODE_EVENTS)[number];

export type OptionType = 'number' | 'bool' | 'select' | 'text' | 'color';

export interface NodeOption {
  key: string;
  label: string;
  type: OptionType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  choices?: Array<{ value: string; label: string }>;
  hint?: string;
  default: unknown;
}

/** A behaviour param value: a literal, or a binding to one of the node's options. */
export type ParamValue = number | string | boolean | { option: string };

export interface AppearanceSpec {
  sprite?: string;
  glyph?: string;
  color?: string;
  tileset?: string;
  zone?: boolean;
}

export interface BehaviorSpec {
  behavior: string;
  event: NodeEvent;
  params: Record<string, ParamValue>;
}

export interface BuildSpec {
  visual?: { sprite?: string; tiled?: boolean };
  collider?: { shape: 'box' | 'none'; trigger: boolean };
  behaviors: BehaviorSpec[];
}

export interface NodeManifest {
  id: string;
  label: string;
  category: string;
  icon: string;
  version: number;
  place: Placement;
  options: NodeOption[];
  appearance: AppearanceSpec[];
  build: BuildSpec;
  assets: { sprites: Record<string, string>; sounds: Record<string, string> };
}

export interface ParseResult {
  manifest: NodeManifest | null;
  errors: string[];
}

// ---- helpers ----
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-zA-Z0-9][\w-]{0,63}$/;
const OPTION_TYPES: OptionType[] = ['number', 'bool', 'select', 'text', 'color'];

export function parseManifest(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { manifest: null, errors: ['node is not an object'] };

  const id = str(raw.id);
  if (!ID_RE.test(id)) return { manifest: null, errors: ['missing or invalid node id'] };

  const label = str(raw.label) || id;
  const category = str(raw.category) || 'Custom';
  const icon = str(raw.icon).slice(0, 8) || '◆';
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1;
  const place: Placement = PLACEMENTS.includes(raw.place as Placement) ? (raw.place as Placement) : 'cell';

  const options = parseOptions(raw.options, errors);
  const optionKeys = new Set(options.map((o) => o.key));
  const appearance = parseAppearance(raw.appearance, errors);
  const build = parseBuild(raw.build, optionKeys, errors);
  const assets = parseAssets(raw.assets, errors);

  return { manifest: { id, label, category, icon, version, place, options, appearance, build, assets }, errors };
}

function parseOptions(raw: unknown, errors: string[]): NodeOption[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push('options is not a list'); return []; }
  const out: NodeOption[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isObj(r)) { errors.push('an option is not an object'); continue; }
    const key = str(r.key);
    if (!ID_RE.test(key)) { errors.push(`invalid option key "${key}"`); continue; }
    if (seen.has(key)) { errors.push(`duplicate option key "${key}"`); continue; }
    const type = (OPTION_TYPES as string[]).includes(str(r.type)) ? (r.type as OptionType) : 'number';
    seen.add(key);
    const o: NodeOption = { key, label: str(r.label) || key, type, default: coerceDefault(type, r.default) };
    if (typeof r.min === 'number') o.min = r.min;
    if (typeof r.max === 'number') o.max = r.max;
    if (typeof r.step === 'number') o.step = r.step;
    if (typeof r.unit === 'string') o.unit = r.unit.slice(0, 16);
    if (typeof r.hint === 'string') o.hint = r.hint.slice(0, 240);
    if (type === 'select' && Array.isArray(r.choices)) {
      o.choices = r.choices
        .filter((c): c is Record<string, unknown> => isObj(c))
        .map((c) => ({ value: str(c.value), label: str(c.label) || str(c.value) }))
        .slice(0, 64);
    }
    out.push(o);
  }
  return out;
}

function coerceDefault(type: OptionType, v: unknown): unknown {
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  if (type === 'bool') return typeof v === 'boolean' ? v : false;
  if (type === 'color') return HEX.test(str(v)) ? str(v).toUpperCase() : '#FFFFFF';
  return str(v);
}

function parseAppearance(raw: unknown, errors: string[]): AppearanceSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push('appearance is not a list'); return []; }
  const out: AppearanceSpec[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const a: AppearanceSpec = {};
    if (typeof r.sprite === 'string') a.sprite = r.sprite.slice(0, 128);
    if (typeof r.glyph === 'string') a.glyph = r.glyph.slice(0, 8);
    if (HEX.test(str(r.color))) a.color = str(r.color).toUpperCase();
    if (typeof r.tileset === 'string') a.tileset = r.tileset.slice(0, 64);
    if (r.zone === true) a.zone = true;
    if (Object.keys(a).length) out.push(a);
  }
  return out;
}

function parseBuild(raw: unknown, optionKeys: Set<string>, errors: string[]): BuildSpec {
  const build: BuildSpec = { behaviors: [] };
  if (raw === undefined) return build;
  if (!isObj(raw)) { errors.push('build is not an object'); return build; }

  if (isObj(raw.visual)) {
    const v: { sprite?: string; tiled?: boolean } = {};
    if (typeof raw.visual.sprite === 'string') v.sprite = raw.visual.sprite.slice(0, 128);
    if (raw.visual.tiled === true) v.tiled = true;
    if (Object.keys(v).length) build.visual = v;
  }
  if (isObj(raw.collider)) {
    const shape = raw.collider.shape === 'box' ? 'box' : 'none';
    build.collider = { shape, trigger: raw.collider.trigger !== false };
  }
  if (Array.isArray(raw.behaviors)) {
    for (const r of raw.behaviors) {
      const b = parseBehavior(r, optionKeys, errors);
      if (b) build.behaviors.push(b);
    }
  }
  return build;
}

function parseBehavior(raw: unknown, optionKeys: Set<string>, errors: string[]): BehaviorSpec | null {
  if (!isObj(raw)) { errors.push('a behaviour is not an object'); return null; }
  const id = str(raw.behavior);
  if (!isBehavior(id)) { errors.push(`unknown behaviour "${id}" (skipped)`); return null; }
  const def = behaviorDef(id)!;
  const event: NodeEvent = NODE_EVENTS.includes(raw.event as NodeEvent) ? (raw.event as NodeEvent) : 'enter';
  const rawParams = isObj(raw.params) ? raw.params : {};
  const params: Record<string, ParamValue> = {};
  for (const spec of def.params) {
    params[spec.key] = coerceParam(spec, rawParams[spec.key], id, optionKeys, errors);
  }
  return { behavior: id, event, params };
}

function coerceParam(spec: ParamSpec, v: unknown, behavior: string, optionKeys: Set<string>, errors: string[]): ParamValue {
  if (isObj(v) && typeof v.option === 'string') {
    if (optionKeys.has(v.option)) return { option: v.option };
    errors.push(`behaviour "${behavior}" binds unknown option "${v.option}" for "${spec.key}"`);
    return spec.def;
  }
  if (spec.type === 'number') return typeof v === 'number' && Number.isFinite(v) ? clampParam(spec, v) : spec.def;
  if (spec.type === 'bool') return typeof v === 'boolean' ? v : spec.def;
  return typeof v === 'string' ? v.slice(0, 256) : spec.def;
}

function parseAssets(raw: unknown, errors: string[]): { sprites: Record<string, string>; sounds: Record<string, string> } {
  return { sprites: assetMap(isObj(raw) ? raw.sprites : undefined), sounds: assetMap(isObj(raw) ? raw.sounds : undefined) };
}

function assetMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (count >= 64) break;
    if (ID_RE.test(k) && typeof v === 'string' && v.length <= 256) { out[k] = v; count++; }
  }
  return out;
}
