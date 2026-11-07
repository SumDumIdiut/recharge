/** The one place content types are registered. Adding a kind of thing to maps means writing a module and adding it here. */
import { arrows } from './arrows.js';
import { blocks } from './blocks.js';
import { course } from './course.js';
import { deco } from './deco.js';
import { moss } from './moss.js';
import { movers } from './mover.js';
import { objects } from './objects.js';
import { triggers } from './triggers.js';
import { spikes } from './spikes.js';
import { vines } from './vines.js';
import { contentLayerOf } from '../core/layers.js';
import type { Brush, ContentType } from './types.js';

/** Drawn in this order within a layer (later on top); the course draws last as an overlay. */
export const CONTENT: ContentType[] = [blocks, spikes, vines, moss, arrows, objects, movers, deco, triggers, course];
/** The ones with cells and picker entries. */
export const PAINTABLE: ContentType[] = CONTENT.filter((c) => c.brushes.length > 0);

export const contentById = (id: string): ContentType | undefined => CONTENT.find((c) => c.id === id);
export const contentOfLayer = (layer: string): ContentType | undefined => CONTENT.find((c) => c.layer === contentLayerOf(layer));

export interface BrushRef { content: string; brush: string }
export function brushOf(ref: BrushRef): { content: ContentType; brush: Brush } | null {
  const content = contentById(ref.content);
  const brush = content?.brushes.find((b) => b.id === ref.brush);
  return content && brush ? { content, brush } : null;
}
