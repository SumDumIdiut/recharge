/**
 * The player's movement constants: ALL of them live here, nothing else in the simulation hard-codes a number.
 *
 * SOURCE AND CONFIDENCE. The game's movement code and its values are compiled into IGTAP and are not exported anywhere
 * in this repo, so none of these could be read from the game. They are the course-solver prototype's constants
 * (Recharge/tools/course-solver/physics.mjs, documented in the vault: "Solver Physics Model"), which are plausible
 * platformer values chosen to run the model, NOT measured. The only values that come from the real game are the
 * ability counts (airJumps, dashes, wallJump), which are taken from the map's own `player` block - the same fields
 * the game reads. Everything marked `uncalibrated` should be tuned against a recorded real run.
 *
 * Units: level units (a cell is 32) and fixed frames (60 per second); y is up.
 */
export const DT = 1 / 60;

export interface Physics {
  gravity: number;
  fallMax: number;
  runAccel: number;
  runMax: number;
  friction: number;
  airAccel: number;
  airDrag: number;
  jumpVel: number;
  jumpCut: number;
  coyote: number;
  jumpBuffer: number;
  wallJumpX: number;
  wallJumpY: number;
  wallSlide: number;
  dashSpeed: number;
  dashFrames: number;
  dashCooldown: number;
  width: number;
  height: number;
  /** from the map's player rules (real) */
  airJumps: number;
  airDashes: number;
  dashUnlocked: boolean;
  wallJumpUnlocked: boolean;
}

/** Per-constant provenance, shown in the playtest HUD and kept honest. */
export const CONFIDENCE: Record<string, 'map-rules' | 'plausible' | 'uncalibrated'> = {
  airJumps: 'map-rules', airDashes: 'map-rules', dashUnlocked: 'map-rules', wallJumpUnlocked: 'map-rules',
  coyote: 'plausible', jumpBuffer: 'plausible', width: 'uncalibrated', height: 'uncalibrated',
  gravity: 'uncalibrated', fallMax: 'uncalibrated', runAccel: 'uncalibrated', runMax: 'uncalibrated', friction: 'uncalibrated',
  airAccel: 'uncalibrated', airDrag: 'uncalibrated', jumpVel: 'uncalibrated', jumpCut: 'uncalibrated',
  wallJumpX: 'uncalibrated', wallJumpY: 'uncalibrated', wallSlide: 'uncalibrated',
  dashSpeed: 'uncalibrated', dashFrames: 'uncalibrated', dashCooldown: 'uncalibrated',
};

export const BASE_PHYSICS: Physics = {
  gravity: 0.9,
  fallMax: 14,
  runAccel: 0.6,
  runMax: 6.0,
  friction: 1.2,
  airAccel: 0.4,
  airDrag: 0.02,
  jumpVel: 12.5,
  jumpCut: 0.45,
  coyote: 5,
  jumpBuffer: 5,
  wallJumpX: 9,
  wallJumpY: 11,
  wallSlide: 3.0,
  dashSpeed: 16,
  dashFrames: 10,
  dashCooldown: 6,
  width: 20,
  height: 44,
  airJumps: 0,
  airDashes: 0,
  dashUnlocked: false,
  wallJumpUnlocked: false,
};

/** The map's `player` block (MapDefinition.Player): what the game reads for abilities. */
export interface PlayerRules { dashes?: number; airJumps?: number; wallJump?: boolean; [k: string]: unknown }

/** Constants for one map: the base values with the map's ability rules applied. */
export function physicsFor(rules: PlayerRules | null | undefined): Physics {
  const r = rules || {};
  const dashes = typeof r.dashes === 'number' ? Math.max(0, r.dashes) : 0;
  return {
    ...BASE_PHYSICS,
    airJumps: typeof r.airJumps === 'number' ? Math.max(0, r.airJumps) : 0,
    airDashes: dashes,
    dashUnlocked: dashes > 0,
    wallJumpUnlocked: r.wallJump === true,
  };
}
