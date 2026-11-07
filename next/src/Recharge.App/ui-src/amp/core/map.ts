/** The map document: named layers of keyed values (cell key -> value), plus identity. Every content type owns one layer. */
import { DEFAULT_LAYERS, type EditorLayer } from './layers.js';
import type { Json } from './types.js';

export type LayerData = Map<string, unknown>;
export type MapListener = (layer: string, key: string, before: unknown, after: unknown) => void;

export class AmpMap {
  name = 'Untitled map';
  description = '';
  layers: Record<string, LayerData> = {};
  /** The editor layers, bottom first. */
  layerDefs: EditorLayer[] = DEFAULT_LAYERS();
  /** The level background shown behind the map (a view aid: the game plays the level's own), and whether it drifts with the camera. Saved in the file's `amp` block. */
  backdrop = 'level';
  parallax = true;
  /** The loaded file, kept so what the Amplifier does not edit (player rules, music, other objects) is saved back untouched. */
  raw: Json | null = null;
  private listeners: MapListener[] = [];

  constructor(name = 'Untitled map') { this.name = name; }

  layer(id: string): LayerData { return (this.layers[id] ||= new Map()); }
  get(layer: string, key: string): unknown { return this.layers[layer]?.get(key); }
  has(layer: string, key: string): boolean { return !!this.layers[layer]?.has(key); }
  size(layer: string): number { return this.layers[layer]?.size ?? 0; }
  /** Entries in a content type's layer across every editor layer. */
  total(contentLayer: string): number {
    let n = 0;
    for (const [id, data] of Object.entries(this.layers)) if (id === contentLayer || id.startsWith(contentLayer + '@')) n += data.size;
    return n;
  }
  /** Change one value (undefined removes it). All edits go through here so views, undo and the unsaved flag see them. */
  set(layer: string, key: string, value: unknown): void {
    const data = this.layer(layer);
    const before = data.get(key);
    if (before === value || (before !== undefined && value !== undefined && JSON.stringify(before) === JSON.stringify(value))) return;
    if (value === undefined) data.delete(key); else data.set(key, value);
    for (const l of this.listeners) l(layer, key, before, value);
  }
  onChange(fn: MapListener): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }
}
