/**
 * Editor layers: an ordered stack (bottom first), each with a role that says how it saves into the game.
 *   back  - behind the playfield: background tiles (the game's `Background` tilemap, walk-through) and scenery drawn behind
 *   main  - the playfield: solid blocks, spikes, objects, movers
 *   front - scenery drawn in front
 * A content type keeps one data layer per editor layer: `dataLayer(content, layer)`.
 */
import type { AmpMap } from './map.js';

export type Role = 'back' | 'main' | 'front';
export interface EditorLayer { id: string; name: string; role: Role; visible: boolean; locked: boolean }

export const DEFAULT_LAYERS = (): EditorLayer[] => [
  { id: 'back', name: 'Background', role: 'back', visible: true, locked: false },
  { id: 'main', name: 'Main', role: 'main', visible: true, locked: false },
  { id: 'front', name: 'Foreground', role: 'front', visible: true, locked: false },
];

/** The map-layer id that holds a content type's values for an editor layer ("main" keeps the plain id, so older files read the same). */
export const dataLayer = (contentLayer: string, layerId: string): string => (layerId === 'main' ? contentLayer : contentLayer + '@' + layerId);

/** The editor layer a map-layer id belongs to ("blocks@back" -> "back"). */
export function layerIdOf(data: string): string {
  const at = data.indexOf('@');
  return at < 0 ? 'main' : data.slice(at + 1);
}
export const contentLayerOf = (data: string): string => (data.indexOf('@') < 0 ? data : data.slice(0, data.indexOf('@')));

/** Each editor layer (bottom first) with the content type's data in it. Empty layers are skipped when `onlyFilled`. */
export function eachLayer(map: AmpMap, contentLayer: string, onlyFilled = true): Array<{ layer: EditorLayer; data: Map<string, unknown>; id: string }> {
  const out: Array<{ layer: EditorLayer; data: Map<string, unknown>; id: string }> = [];
  for (const layer of map.layerDefs) {
    const id = dataLayer(contentLayer, layer.id);
    const data = map.layers[id];
    if (onlyFilled && (!data || data.size === 0)) continue;
    out.push({ layer, data: data || map.layer(id), id });
  }
  return out;
}

export function addLayer(map: AmpMap, name: string, role: Role): EditorLayer {
  let n = 1;
  let id = role + n;
  while (map.layerDefs.some((l) => l.id === id)) id = role + ++n;
  const layer: EditorLayer = { id, name, role, visible: true, locked: false };
  // new layers go just above the topmost layer of the same role
  let at = map.layerDefs.length;
  for (let i = map.layerDefs.length - 1; i >= 0; i--) if (map.layerDefs[i].role === role) { at = i + 1; break; }
  map.layerDefs.splice(at, 0, layer);
  return layer;
}

/** Remove a layer and everything in it (the last layer of a role cannot go: saves need one). */
export function removeLayer(map: AmpMap, id: string): boolean {
  const layer = map.layerDefs.find((l) => l.id === id);
  if (!layer || map.layerDefs.filter((l) => l.role === layer.role).length < 2) return false;
  map.layerDefs = map.layerDefs.filter((l) => l.id !== id);
  for (const key of Object.keys(map.layers)) if (layerIdOf(key) === id) delete map.layers[key];
  return true;
}

export function moveLayer(map: AmpMap, id: string, by: number): boolean {
  const i = map.layerDefs.findIndex((l) => l.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= map.layerDefs.length) return false;
  const [l] = map.layerDefs.splice(i, 1);
  map.layerDefs.splice(j, 0, l);
  return true;
}
