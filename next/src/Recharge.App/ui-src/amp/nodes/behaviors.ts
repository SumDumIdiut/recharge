/**
 * The behaviour registry: the whitelist of effects a node may compose. A node manifest references these by `id`
 * and binds their params to its own options. The GAME holds the real implementations (Recharge.Module.Maps);
 * the editor uses this list only to validate manifests and to clamp params. Adding a genuinely new mechanic
 * means registering a behaviour here AND implementing it game-side — after that, any node can use it by id.
 *
 * Security: a node file is data, never code. Nothing here runs arbitrary logic; the game only ever composes
 * these named behaviours with validated, range-clamped params. An unknown behaviour id is skipped, not run.
 */

export type ParamType = 'number' | 'bool' | 'string';

export interface ParamSpec {
  key: string;
  type: ParamType;
  /** For numbers: the clamp range applied to literal values and (game-side) to option-bound values. */
  min?: number;
  max?: number;
  /** When the param is omitted. */
  def: number | boolean | string;
}

export interface BehaviorDef {
  id: string;
  label: string;
  /** Applied on enter and undone on exit (zone effects), vs. a one-shot on the trigger event. */
  whileInside?: boolean;
  params: ParamSpec[];
}

const n = (key: string, def: number, min?: number, max?: number): ParamSpec => ({ key, type: 'number', def, min, max });
const b = (key: string, def = false): ParamSpec => ({ key, type: 'bool', def });
const s = (key: string, def = ''): ParamSpec => ({ key, type: 'string', def });

/** Seeded from the trigger effects already shipped. Order is stable; ids are the contract with the game. */
export const BEHAVIORS: readonly BehaviorDef[] = [
  { id: 'setVelocity', label: 'Set velocity', params: [n('vx', 0, -5000, 5000), n('vy', 0, -5000, 5000)] },
  { id: 'wind', label: 'Push (while inside)', whileInside: true, params: [n('vx', 0, -5000, 5000), n('vy', 0, -5000, 5000)] },
  { id: 'scaleStats', label: 'Scale stats (while inside)', whileInside: true, params: [n('speed', 1, 0, 10), n('jump', 1, 0, 10), n('gravity', 1, 0, 10), n('dash', 1, 0, 10)] },
  { id: 'setAbilities', label: 'Set abilities', params: [b('setJumps'), n('airJumps', 1, 0, 20), b('setDashes'), n('airDashes', 1, 0, 20), b('giveDash'), b('giveDoubleJump'), b('giveWallJump')] },
  { id: 'refill', label: 'Refill air jumps/dashes', params: [] },
  { id: 'moveGroup', label: 'Move group', params: [s('group'), n('dx', 0, -99999, 99999), n('dy', 0, -99999, 99999), n('time', 1, 0, 600), b('back')] },
  { id: 'showGroup', label: 'Show group', params: [s('group')] },
  { id: 'hideGroup', label: 'Hide group', params: [s('group')] },
  { id: 'toggleGroup', label: 'Toggle group', params: [s('group')] },
  { id: 'swapBlocks', label: 'Swap block colours', params: [] },
  { id: 'teleport', label: 'Teleport', params: [n('tx', 0, -99999, 99999), n('ty', 0, -99999, 99999)] },
  { id: 'setRespawn', label: 'Set respawn', params: [n('tx', 0, -99999, 99999), n('ty', 0, -99999, 99999)] },
  { id: 'kill', label: 'Kill', params: [] },
  { id: 'zoom', label: 'Camera zoom (while inside)', whileInside: true, params: [n('size', 1.5, 0.1, 10)] },
  { id: 'slowmo', label: 'Time scale (while inside)', whileInside: true, params: [n('timeScale', 0.5, 0.05, 10)] },
  { id: 'message', label: 'Show message', params: [s('text', 'Hello!'), n('seconds', 3, 0.5, 600)] },
  { id: 'playMusic', label: 'Play music', params: [s('music')] },
  { id: 'playSfx', label: 'Play sound', params: [s('sound'), n('volume', 1, 0, 1)] },
];

const BY_ID = new Map(BEHAVIORS.map((d) => [d.id, d]));
export const behaviorDef = (id: string): BehaviorDef | undefined => BY_ID.get(id);
export const isBehavior = (id: string): boolean => BY_ID.has(id);

/** Clamp a numeric literal to a param's range (the game clamps too; the editor clamps authored values). */
export function clampParam(spec: ParamSpec, v: number): number {
  let x = v;
  if (typeof spec.min === 'number' && x < spec.min) x = spec.min;
  if (typeof spec.max === 'number' && x > spec.max) x = spec.max;
  return x;
}
