/**
 * The generic `nodes` content type: one brush per registered node manifest, properties built from the manifest's
 * options, drawing from its appearance, serialised as { type:"node", nodeId, x, y, ...options } objects the game
 * reads - plus every used node's manifest into the file's `amp.nodeDefs` so a map carries its custom nodes.
 */
import type { AmpMap } from '../core/map.js';
import { eachLayer } from '../core/layers.js';
import { CELL, parseKey, type Cell, type Json } from '../core/types.js';
import type { JsonSink } from '../content/sink.js';
import { boolOption, numberOption, selectOption, textOption, type Brush, type ContentType, type DrawEnv, type OptionDef } from '../content/types.js';
import { allNodes, loadCustomNodes, nodeById, registerNode } from './registry.js';
import { parseManifest, type NodeManifest, type NodeOption } from './manifest.js';
import './examples.js';

loadCustomNodes(); // built-ins (examples) registered above; add this browser's saved custom nodes

export const NODES = 'nodes';
const DEFAULT_COLOR = '#8fd0ff';

interface NodeValue { nodeId: string; w?: number; h?: number; [k: string]: unknown }
const val = (v: unknown): NodeValue => (v && typeof v === 'object' ? (v as NodeValue) : { nodeId: '' });
const isZone = (m?: NodeManifest): boolean => m?.place === 'zone';
const colorOf = (m?: NodeManifest): string => m?.appearance.find((a) => a.color)?.color ?? DEFAULT_COLOR;
const glyphOf = (m?: NodeManifest): string => m?.appearance.find((a) => a.glyph)?.glyph ?? m?.icon ?? '?';
const brushOfNode = (m: NodeManifest): Brush => ({ id: m.id, label: m.label, group: m.category, thumb: { glyph: glyphOf(m), color: colorOf(m) } });

const colorOption = (key: string, label: string, def: string, hint?: string): OptionDef => ({
  key, label, type: 'color', hint,
  get: (v) => { const x = (v as Record<string, unknown>)?.[key]; return typeof x === 'string' ? x : def; },
  set: (v, x) => ({ ...(v as Record<string, unknown>), [key]: String(x) }),
});

function optionDef(o: NodeOption): OptionDef {
  const extra: Partial<OptionDef> = {};
  if (typeof o.min === 'number') extra.min = o.min;
  if (typeof o.max === 'number') extra.max = o.max;
  if (typeof o.step === 'number') extra.step = o.step;
  if (o.unit) extra.unit = o.unit;
  if (o.hint) extra.hint = o.hint;
  if (o.type === 'bool') return boolOption(o.key, o.label, o.default as boolean, extra);
  if (o.type === 'text') return textOption(o.key, o.label, o.default as string, extra);
  if (o.type === 'select') return selectOption(o.key, o.label, o.default as string, o.choices ?? [], extra);
  if (o.type === 'color') return colorOption(o.key, o.label, (o.default as string) || '#FFFFFF', o.hint);
  return numberOption(o.key, o.label, o.default as number, extra);
}

/** Register any node manifests a map file carries (amp.nodeDefs), so custom nodes draw and edit on load. */
export function registerNodeDefs(defs: unknown): void {
  if (!defs || typeof defs !== 'object') return;
  for (const raw of Object.values(defs as Record<string, unknown>)) {
    const { manifest } = parseManifest(raw);
    if (manifest) registerNode(manifest);
  }
}

export const nodes: ContentType = {
  id: 'nodes',
  label: 'Nodes',
  layer: NODES,
  roles: ['main'],
  exclusive: false,
  live: true,
  get brushes(): Brush[] { return allNodes().map(brushOfNode); },
  place(brush) {
    const m = nodeById(brush.id);
    if (!m) return undefined;
    const v: NodeValue = { nodeId: m.id };
    for (const o of m.options) v[o.key] = o.default;
    if (isZone(m)) { v.w = 192; v.h = 192; }
    return v;
  },
  brushOf(value) {
    const m = nodeById(val(value).nodeId);
    return m ? { brush: brushOfNode(m) } : null;
  },
  /** Zone nodes are picked anywhere their rectangle covers (like triggers); others by their own cell. */
  cellOf(x, y, map, dl): Cell {
    if (!map || !dl) return { x, y };
    const data = map.layers[dl];
    if (!data) return { x, y };
    const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
    let best: { key: string; dist: number } | null = null;
    for (const [key, v] of data) {
      const nv = val(v), m = nodeById(nv.nodeId), c = parseKey(key);
      const w = isZone(m) ? (nv.w ?? 192) : CELL, h = isZone(m) ? (nv.h ?? 192) : CELL;
      const cx = c.x * CELL + CELL / 2, cy = c.y * CELL + CELL / 2;
      const hw = w / 2 + CELL / 2, hh = h / 2 + CELL / 2;
      const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
      if (dx <= hw && dy <= hh) { const dist = Math.hypot(dx, dy); if (!best || dist < best.dist) best = { key, dist }; }
    }
    return best ? parseKey(best.key) : { x, y };
  },
  options(value): OptionDef[] {
    const m = nodeById(val(value).nodeId);
    if (!m) return [];
    const out = m.options.map(optionDef);
    if (isZone(m)) out.push(
      numberOption('w', 'Width', 192, { min: 16, max: 9999, step: 16, unit: 'units' }),
      numberOption('h', 'Height', 192, { min: 16, max: 9999, step: 16, unit: 'units' }),
    );
    return out;
  },
  draw(env: DrawEnv, _map, _x, _y, value, sx, sy, size) {
    const nv = val(value), m = nodeById(nv.nodeId), ctx = env.ctx, k = size / CELL;
    const color = colorOf(m), glyph = glyphOf(m);
    const cx = sx + size / 2, cy = sy + size / 2;
    ctx.save();
    if (isZone(m)) {
      const w = (nv.w ?? 192) * k, h = (nv.h ?? 192) * k;
      ctx.fillStyle = color + '22';
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = color;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      ctx.setLineDash([]);
    } else {
      const r = size * 0.4;
      ctx.fillStyle = color + '33'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
    }
    if (size >= 8) {
      const fs = Math.max(10, Math.min(20, size * 0.5));
      ctx.font = '700 ' + fs + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(glyph, cx, cy + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  },
  toJson(map: AmpMap, sink: JsonSink) {
    for (const { data } of eachLayer(map, NODES)) {
      for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const nv = val(value), m = nodeById(nv.nodeId);
        if (!m) continue;
        const c = parseKey(key);
        const obj: Json = { type: 'node', nodeId: m.id, x: Math.round(c.x * CELL + CELL / 2), y: Math.round(c.y * CELL + CELL / 2), amp: true };
        for (const o of m.options) obj[o.key] = nv[o.key] ?? o.default;
        if (isZone(m)) { obj.w = nv.w ?? 192; obj.h = nv.h ?? 192; }
        sink.objects.push(obj);
        sink.nodeDefs[m.id] = m as unknown as Json;
      }
    }
  },
  fromJson(json, map) {
    void map;
    registerNodeDefs((json.amp as { nodeDefs?: unknown } | undefined)?.nodeDefs);
  },
};
