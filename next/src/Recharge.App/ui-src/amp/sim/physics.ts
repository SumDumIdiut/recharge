/**
 * The player's movement constants: ALL of them live here, nothing else in the simulation hard-codes a number.
 *
 * SOURCE. These are the REAL values from IGTAP's player controller, `Movement.cs` (type `Movement`, a Rigidbody2D
 * MonoBehaviour in Assembly-CSharp.dll). The integration/formulae were decompiled from the method IL (Mono.Cecil);
 * the magnitudes were read from the serialized Unity-6 scene (level0, via UnityPy + a generated TypeTree). So every
 * constant here traces to the game:
 *   'game-asset' - a magnitude serialized in the scene/prefab (gravity, run/jump/dash speed, wall-jump force, the
 *                  frame/second timings). Converted to the editor's convention below.
 *   'game-code'  - the shape/condition of a manoeuvre, or a size, read from the compiled method bodies.
 *   'map-rules'  - from the map's own `player` block, exactly what the game reads (ability counts).
 *   'plausible'  - a small approximation where the editor's single-body model can't reproduce the game 1:1
 *                  (the game's separate momentum vector; the exact variable-jump curve). Kept close and marked.
 *
 * UNIT / FRAMERATE CONVENTION. The editor sim integrates per frame at 60 fps (position `+= v` each frame), with 1 cell
 * = 32 units - the SAME spatial unit the game uses (its cell->world export multiplies by 32). The game runs physics at
 * a 50 Hz fixed step (fixedDeltaTime = 0.02) and stores `Velocity` as Unity units/SECOND (body.linearVelocity =
 * Velocity + momentum + movingPlatformVelocity). So:
 *   - a velocity (units/frame)  = game units/sec / 60.           e.g. jumpForce 780 -> 13.0
 *   - gravity (units/frame, subtracted each frame) = game's per-sec^2 accel / 3600. The game subtracts
 *     `50*dt*gravity` (= gravity, since 50*0.02 = 1) per 50 Hz frame, i.e. 50*gravity = 1250 u/s^2; /3600 = gravity/72.
 *   - a duration given in game fixed-frames @50 Hz -> editor frames @60 fps by the time it lasts (x 60/50 = x1.2);
 *     a duration given in seconds -> x60.
 *
 * WHAT THE GAME CODE PINS (reproduced in step.ts):
 *   - Horizontal: Velocity.x += dir * runSpeed*10 / framesToReachTopSpeed, clamped to +/- runSpeed*10; the SAME accel
 *     in the air (full air control). framesToReachTopSpeed = 2 (@50 Hz).
 *   - Gravity: Velocity.y -= (50*dt)*gravity*fastFallMod each frame; fastFallMod kicks in automatically once falling
 *     faster than -75 u/s; a lighter pull near the apex (Velocity.y in (-50,200) u/s adds 50*dt*jumpApexAntiGrav up);
 *     the terminal clamp targets maxDownwardsSpeed*8 (its soft-drag is disabled in this build: PostMaxDownwardsSpeedDrag = 0).
 *   - Jump: Velocity.y = jumpForce. Air jump: zero a downward Velocity.y, then toward airJumpForce (Lerp .5 if rising).
 *     Wall jump: Velocity.x = runSpeed*10 away from the wall, Velocity.y = wallJumpForce, with a 0.1 s input lock.
 *   - Apex horizontal bonus: Velocity.x += jumpApexSpeedBonus*dir*10 while at the apex.
 *   - Coyote 5 frames, dash 10 frames, dash cooldown 0.3 s, wall-jump lock 0.1 s (game values).
 *
 * The momentum vector (dash boosts, wall bounces, moving-platform carry; momentumDecay/flatMomentumDecay) is the one
 * system the editor folds into plain velocity rather than modelling separately - see the 'plausible' notes.
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
  wallLockFrames: number;
  wallSlide: number;
  dashSpeed: number;
  dashFrames: number;
  dashCooldown: number;
  airJumpVel: number;
  fastFallMod: number;
  fastFallThreshold: number;
  apexWindow: number;
  apexAntiGrav: number;
  apexSpeedBonus: number;
  width: number;
  height: number;
  /** from the map's player rules (real) */
  airJumps: number;
  airDashes: number;
  dashUnlocked: boolean;
  wallJumpUnlocked: boolean;
}

/** Per-constant provenance, shown in the playtest HUD. Every value traces to the real game; see the header.
 *  'game-asset' - a magnitude from the serialized Unity scene.  'game-code' - a shape/size from the method IL.
 *  'map-rules'  - from the map's `player` block.                'plausible' - a small, flagged approximation. */
export const CONFIDENCE: Record<string, 'map-rules' | 'plausible' | 'game-asset' | 'game-code'> = {
  airJumps: 'map-rules', airDashes: 'map-rules', dashUnlocked: 'map-rules', wallJumpUnlocked: 'map-rules',
  // magnitudes read from the serialized scene:
  gravity: 'game-asset', fallMax: 'game-asset', runAccel: 'game-asset', runMax: 'game-asset',
  jumpVel: 'game-asset', coyote: 'game-asset', wallJumpX: 'game-asset', wallJumpY: 'game-asset',
  wallLockFrames: 'game-asset', wallSlide: 'game-asset', dashSpeed: 'game-asset', dashFrames: 'game-asset',
  dashCooldown: 'game-asset', airJumpVel: 'game-asset', fastFallMod: 'game-asset', apexAntiGrav: 'game-asset',
  apexSpeedBonus: 'game-asset',
  // shapes, bands and sizes read from the compiled methods:
  friction: 'game-code', airAccel: 'game-code', fastFallThreshold: 'game-code', apexWindow: 'game-code',
  width: 'game-code', height: 'game-code',
  // approximations the single-body model can't match exactly:
  airDrag: 'plausible', jumpCut: 'plausible', jumpBuffer: 'plausible',
};

export const BASE_PHYSICS: Physics = {
  gravity: 0.3472,        // game-asset: gravity=25; 50*gravity = 1250 u/s^2 => /3600 = 25/72 per 60 fps frame
  fallMax: 17.33,         // game-asset: terminal targets maxDownwardsSpeed*8 = 1040 u/s => /60
  runAccel: 3.125,        // game-asset: runMax / framesToReachTopSpeed (2 @50 Hz = 0.04 s => 2.4 frames @60 fps)
  runMax: 7.5,            // game-asset: runSpeed*10 = 450 u/s => /60
  friction: 3.125,        // game-code: the game stops on the ground at the acceleration rate (reach 0 in ~2.4 frames)
  airAccel: 3.125,        // game-code: the game accelerates in the air at the same rate (full air control)
  airDrag: 0.05,          // plausible: stands in for the game's slow momentum-vector coast (not modelled here)
  jumpVel: 13.0,          // game-asset: jumpForce=780 u/s => /60
  jumpCut: 0.45,          // plausible: variable-jump cut; the game shapes the release differently, this reads the same
  coyote: 6,              // game-asset: maxCoyoteFrames=5 @50 Hz (0.1 s) => 6 frames @60 fps
  jumpBuffer: 5,          // plausible: ~0.08 s of jump buffering
  wallJumpX: 7.5,         // game-asset: Velocity.x = runSpeed*10 away from the wall = runMax
  wallJumpY: 11.67,       // game-asset: wallJumpForce=700 u/s => /60
  wallLockFrames: 6,      // game-asset: wallJumpMovementLockFrames = 0.1 s => 6 frames @60 fps
  wallSlide: 5.83,        // game-asset: maxWallSlideSpeed=350 u/s => /60
  dashSpeed: 20.83,       // game-asset: Velocity = dir * dashSpeed*10 = 1250 u/s => /60
  dashFrames: 12,         // game-asset: dashFrames=10 @50 Hz (0.2 s) => 12 frames @60 fps
  dashCooldown: 18,       // game-asset: defaultDashCooldown = 0.3 s => 18 frames @60 fps (after the dash ends)
  airJumpVel: 12.0,       // game-asset: airJumpForce=720 u/s => /60
  fastFallMod: 1.35,      // game-asset: gravity x1.35 once descending faster than fastFallThreshold
  fastFallThreshold: -1.25, // game-code: fast fall engages below -75 u/s (= -1.25 units/frame)
  apexWindow: 3.33,       // game-code: apex band is Velocity.y in (-50,200) u/s; upper bound 200/60 (lower = -0.25x)
  apexAntiGrav: 0.2,      // game-asset: jumpApexAntiGrav=5 against gravity=25 => gravity is 0.2 lighter near the apex
  apexSpeedBonus: 1.0,    // game-asset: jumpApexSpeedBonus=6, added as *10 => 60 u/s => /60 extra top speed at the apex
  width: 30,              // game-code: the controller's side probes span +/-15 units
  height: 37,             // game-code: the controller's probes span y -18..+19
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
