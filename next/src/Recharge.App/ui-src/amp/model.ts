/**
 * The map file: conversion between the AmpMap document and the JSON the game's map loader reads (MapDefinition.cs).
 * Each content type writes and reads its own layer (content/*); this assembles the file around them.
 *
 * Coordinates: a cell (cx, cy) covers level x in [cx*32, cx*32+32) and y in [cy*32, cy*32+32), y up; the game paints
 * a map's tiles at exactly those cells.
 */
import { CONTENT } from './content/index.js';
import { JsonSink } from './content/sink.js';
import { AmpMap } from './core/map.js';
import { contentLayerOf, type EditorLayer } from './core/layers.js';
import type { Json } from './core/types.js';
import { BACKDROPS } from './backdrop.js';

export { CELL, cellKey, parseKey } from './core/types.js';
export { GATE_LIFT, SPAWN_LIFT, END_LIFT, START_LIFT } from './content/course.js';
export { AmpMap } from './core/map.js';

export const FORMAT = 3;
const DEFAULT_PLAYER: Json = { dashes: 0, airJumps: 0, wallJump: false, blockSwap: false, omniDash: false, zipMovers: false, refreshers: false, teleporters: true, cash: 100 };

export function emptyMap(name = 'Untitled map'): AmpMap { return new AmpMap(name); }

/**
 * The map as the game's JSON. Plain tiles go to `tileLayers` (runs of [y, x, n, name index, matrix index]); anything a name
 * alone cannot carry goes in the group's objects. `amp` holds each layer's own values so a reload is exact.
 */
export function toMapJson(map: AmpMap): Json {
  const raw: Json = map.raw ? (JSON.parse(JSON.stringify(map.raw)) as Json) : {};
  const sink = new JsonSink();
  for (const c of CONTENT) c.toJson(map, sink);

  const out: Json = { formatVersion: 1, ...raw, name: map.name, description: map.description };
  out.images = Array.isArray(raw.images) ? raw.images : [];
  out.customImages = Array.isArray(raw.customImages) ? raw.customImages : [];
  out.levelOrigin = Array.isArray(raw.levelOrigin) ? raw.levelOrigin : [0, 9];
  out.player = { ...((raw.player as Json | undefined) ?? DEFAULT_PLAYER), ...sink.player };
  out.music = raw.music ?? 'level';
  out.background = raw.background ?? 'level';
  const { layers, mats } = sink.tileLayers();
  out.tileLayers = layers;
  out.mats = mats;
  out.startZone = typeof raw.startZone === 'number' ? raw.startZone : 0;

  const groups = Array.isArray(raw.groups) ? (raw.groups as Json[]) : [];
  const group: Json = { ...(groups[0] || {}) };
  const keep = Array.isArray(group.objects) ? (group.objects as Json[]).filter((o) => !(o && o.amp === true)) : [];
  group.objects = [...keep, ...sink.objects];
  // the fields the course writes are rewritten in a fixed order, so the same map always writes the same file
  // (the first complete course's reward when there is one, else the file's own)
  const reward = sink.group.reward ?? group.reward ?? { currency: 'Cash', amount: 10 };
  for (const k of ['startX', 'startY', 'endX', 'endY', 'spawnX', 'spawnY', 'spawns', 'gates', 'reward', 'courses']) delete group[k];
  const { courses: courseList, reward: _reward, ...fields } = sink.group;
  Object.assign(group, fields);
  group.reward = reward;
  group.courses = courseList ?? [];
  out.groups = [group, ...groups.slice(1)];

  // every data layer as [key, value] pairs, sorted so the same map always writes the same file
  const ampLayers: Record<string, Array<[string, unknown]>> = {};
  for (const [id, data] of Object.entries(map.layers)) {
    if (data.size === 0) continue;
    ampLayers[id] = [...data.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  out.amp = { version: FORMAT, layerDefs: map.layerDefs, backdrop: map.backdrop, parallax: map.parallax, layers: ampLayers };
  return out;
}

/** Read a map file back. A file with no `amp` block (made elsewhere) loads the ground tiles it names. */
export function fromMapJson(json: Json): AmpMap {
  const map = new AmpMap(typeof json.name === 'string' ? json.name : 'Untitled map');
  map.description = typeof json.description === 'string' ? json.description : '';
  map.raw = json;
  const amp = json.amp as { layerDefs?: EditorLayer[]; backdrop?: string; parallax?: boolean; layers?: Record<string, Array<[string, unknown]>> } | undefined;
  if (amp && typeof amp.backdrop === 'string' && BACKDROPS.some((b) => b.id === amp.backdrop)) map.backdrop = amp.backdrop;
  if (amp && typeof amp.parallax === 'boolean') map.parallax = amp.parallax;
  if (amp?.layers && typeof amp.layers === 'object') {
    // version 2 and 3: every data layer of a known content type, as saved
    if (Array.isArray(amp.layerDefs) && amp.layerDefs.length) map.layerDefs = amp.layerDefs.map((l) => ({ ...l }));
    const known = new Set(CONTENT.map((c) => c.layer));
    for (const [id, pairs] of Object.entries(amp.layers)) {
      if (!known.has(contentLayerOf(id)) || !Array.isArray(pairs)) continue;
      const data = map.layer(id);
      for (const [k, v] of pairs) data.set(k, v);
    }
  } else {
    for (const c of CONTENT) c.fromJson(json, map);
  }
  return map;
}

/** Same values in every layer (the round-trip check). */
export function sameMap(a: AmpMap, b: AmpMap): boolean {
  const ids = new Set([...Object.keys(a.layers), ...Object.keys(b.layers)]);
  for (const id of ids) {
    const x = a.layers[id], y = b.layers[id];
    const sx = x?.size ?? 0, sy = y?.size ?? 0;
    if (sx !== sy) return false;
    if (x) for (const [k, v] of x) if (JSON.stringify(y?.get(k)) !== JSON.stringify(v)) return false;
  }
  return true;
}

/** The cell bounds (x1/y1 exclusive) of everything painted and the course, or null for an empty map. */
export function mapBounds(map: AmpMap): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [id, data] of Object.entries(map.layers)) {
    const course = id === 'course';
    for (const [k, v] of data) {
      let cx: number, cy: number;
      if (course) { const g = v as { x?: number; y?: number }; if (!Number.isFinite(g?.x) || !Number.isFinite(g?.y)) continue; cx = g.x as number; cy = g.y as number; }
      else { const i = k.indexOf(','); cx = +k.slice(0, i); cy = +k.slice(i + 1); }
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx + 1); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy + 1);
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
