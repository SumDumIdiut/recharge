// The player physics model for the course solver.
//
//   step(state, input, world) -> state        pure, deterministic, one fixed frame
//
// Every constant lives in PHYSICS so it can be calibrated against the real game without touching
// the integrator (see amplifier-vault/Solver/Solver Physics Model). The search never looks inside
// here; it only calls step() and tests the goal.
//
// COORDINATES. One cell is 32 units. `y` is the player's FEET and up is +y, matching the editor's
// cells (editor.js CELL = 32, OFFSET_Y = 9).

import { overlaps } from './geom.mjs';

/** Seconds per fixed frame. The game runs on a fixed update; the model must match it. */
export const DT = 1 / 60;

/** Buttons, as a bitmask — the same shape the replay format stores. */
export const BUTTON = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, JUMP: 16, DASH: 32, SWAP: 64 };

/**
 * The constants. THESE ARE UNCALIBRATED: plausible platformer values, chosen so the model runs
 * and the search is correct. Calibrating them against the real game is its own task and the only
 * thing standing between the solver's answer and the truth.
 */
export const PHYSICS = {
  gravity: 0.9,      // units/frame² downward (subtracted from vy)
  fallMax: 14,       // terminal fall speed
  runAccel: 0.6,     // ground acceleration
  runMax: 6.0,       // ground and air top speed
  friction: 1.2,     // ground deceleration with no input
  airAccel: 0.4,     // air acceleration
  airDrag: 0.02,     // air deceleration with no input
  jumpVel: 12.5,     // initial upward velocity
  jumpCut: 0.45,     // vy multiplier on the frame jump is released
  coyote: 5,         // frames after leaving ground you may still jump
  jumpBuffer: 5,     // frames a jump press is remembered
  wallJumpX: 9,      // horizontal push away from a wall
  wallJumpY: 11,     // vertical push from a wall
  wallSlide: 3.0,    // max fall speed while sliding a wall
  dashSpeed: 16,     // dash velocity, any direction
  dashFrames: 10,    // dash duration
  dashCooldown: 6,   // frames after a dash before the next
  airDashes: 1,
  airJumps: 1,
  width: 20,
  height: 44,
  maxSpeed: 16,      // used by the A* heuristic; must be an upper bound on speed/frame
  confidence: 'uncalibrated',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The input combinations the search tries each frame. A held button is re-issued every frame, so
 * the search only has to choose one of these per frame. Kept small on purpose: every extra action
 * multiplies the search.
 */
export const ACTIONS = [
  0,
  BUTTON.LEFT,
  BUTTON.RIGHT,
  BUTTON.JUMP,
  BUTTON.LEFT | BUTTON.JUMP,
  BUTTON.RIGHT | BUTTON.JUMP,
  BUTTON.DASH,
  BUTTON.LEFT | BUTTON.DASH,
  BUTTON.RIGHT | BUTTON.DASH,
  BUTTON.UP | BUTTON.DASH,
  BUTTON.DOWN | BUTTON.DASH,
  BUTTON.RIGHT | BUTTON.DASH | BUTTON.JUMP,
  BUTTON.LEFT | BUTTON.DASH | BUTTON.JUMP,
];

/** Button names in a mask, for the human-readable input listing. */
export function buttonNames(mask) {
  const out = [];
  for (const [name, bit] of Object.entries(BUTTON)) if (mask & bit) out.push(name.toLowerCase());
  return out;
}

/** The state at the start of a run. `x` is the centre, `y` is the feet. */
export function startState(x, y, opts = {}) {
  return {
    x, y, vx: 0, vy: 0,
    onGround: false,
    coyote: 0,
    jumpBuffer: 0,
    jumpHeld: false,
    airDashes: opts.airDashes ?? PHYSICS.airDashes,
    airJumps: opts.airJumps ?? PHYSICS.airJumps,
    dashFrames: 0,
    dashCooldown: 0,
    wall: 0,           // -1 wall on the left, +1 on the right, 0 none
    facing: 1,
    dead: false,
    won: false,
    f: 0,
  };
}

/** The quantised key the search uses to decide two states are "the same". */
export function stateKey(s, q) {
  return (
    Math.round(s.x / q.x) + ',' +
    Math.round(s.y / q.y) + ',' +
    Math.round(s.vx / q.v) + ',' +
    Math.round(s.vy / q.v) + ',' +
    (s.onGround ? 1 : 0) + (s.dashFrames > 0 ? 1 : 0) + ',' +
    s.airDashes + ',' + s.airJumps
  );
}

/** Where the player is in the run, for colouring the trail. */
export function stateTag(s) {
  if (s.dashFrames > 0) return 'dash';
  if (s.onGround) return 'ground';
  if (s.vy > 0) return 'jump';
  if (s.wall !== 0) return 'wall';
  return 'air';
}

/** The player's box at a state. */
export function playerBox(s, P = PHYSICS) {
  return { x: s.x - P.width / 2, y: s.y, w: P.width, h: P.height };
}

/**
 * Advance one fixed frame. Pure: it never mutates `s`.
 *
 * `world` must provide: `solid` (a SolidGrid), `hazards` (an array of boxes), `end` (a box),
 * and optionally `deathY` (falling below this kills).
 */
export function step(s, input, world, P = PHYSICS) {
  const n = { ...s, f: s.f + 1 };
  if (s.dead || s.won) return n;

  const left = !!(input & BUTTON.LEFT);
  const right = !!(input & BUTTON.RIGHT);
  const up = !!(input & BUTTON.UP);
  const down = !!(input & BUTTON.DOWN);
  const jump = !!(input & BUTTON.JUMP);
  const dash = !!(input & BUTTON.DASH);

  const jumpPressed = jump && !s.jumpHeld;
  const jumpReleased = s.jumpHeld && !jump;
  n.jumpHeld = jump;

  // A jump press is remembered for a few frames, so a press just before landing still jumps.
  n.jumpBuffer = jumpPressed ? P.jumpBuffer : Math.max(0, s.jumpBuffer - 1);
  // ...and you may still jump for a few frames after walking off an edge.
  n.coyote = s.onGround ? P.coyote : Math.max(0, s.coyote - 1);

  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  if (dir) n.facing = dir;

  // Dash.
  if (n.dashCooldown > 0) n.dashCooldown--;
  const startedDash = dash && s.dashCooldown === 0 && s.dashFrames === 0 && (s.onGround || s.airDashes > 0);
  if (startedDash) {
    n.dashCooldown = P.dashFrames + P.dashCooldown;
    if (!s.onGround) n.airDashes = s.airDashes - 1;
    const ax = dir;
    const ay = (up ? 1 : 0) - (down ? 1 : 0);
    if (ax === 0 && ay === 0) {
      n.vx = n.facing * P.dashSpeed;
      n.vy = 0;
    } else {
      const m = Math.hypot(ax, ay);
      n.vx = (ax / m) * P.dashSpeed;
      n.vy = (ay / m) * P.dashSpeed;
    }
  }

  if (startedDash || s.dashFrames > 0) {
    // A dash holds its velocity; gravity and input are ignored until it ends. The frame it starts
    // counts as the first of its P.dashFrames.
    n.dashFrames = (startedDash ? P.dashFrames : s.dashFrames) - 1;
  } else {
    // Horizontal.
    if (dir) {
      const acc = s.onGround ? P.runAccel : P.airAccel;
      n.vx = clamp(s.vx + dir * acc, -P.runMax, P.runMax);
    } else if (s.onGround) {
      const f = Math.sign(s.vx) * P.friction;
      n.vx = Math.abs(s.vx) <= Math.abs(f) ? 0 : s.vx - f;
    } else {
      const f = Math.sign(s.vx) * P.airDrag;
      n.vx = Math.abs(s.vx) <= Math.abs(f) ? 0 : s.vx - f;
    }

    // The dash's burst does not outlive the dash: horizontal speed falls back to the run cap, so a
    // dash is a fixed burst rather than a permanent speed boost. (Only a dash can put |vx| above
    // runMax, so this test also identifies "the dash just ended".)
    if (Math.abs(s.vx) > P.runMax) n.vx = clamp(n.vx, -P.runMax, P.runMax);

    // Gravity, then a wall slide.
    n.vy = Math.max(-P.fallMax, s.vy - P.gravity);
    if (!s.onGround && s.wall !== 0 && s.vy < 0 && ((s.wall < 0 && left) || (s.wall > 0 && right))) {
      n.vy = Math.max(n.vy, -P.wallSlide);
    }

    // Jump, in priority order: ground/coyote, then wall, then an air jump.
    if (n.jumpBuffer > 0) {
      if (s.onGround || s.coyote > 0) {
        n.vy = P.jumpVel;
        n.jumpBuffer = 0;
        n.coyote = 0;
        n.onGround = false;
      } else if (s.wall !== 0) {
        n.vy = P.wallJumpY;
        n.vx = -s.wall * P.wallJumpX;
        n.facing = -s.wall;
        n.jumpBuffer = 0;
      } else if (s.airJumps > 0) {
        n.vy = P.jumpVel * 0.9;
        n.airJumps = s.airJumps - 1;
        n.jumpBuffer = 0;
      }
    }

    // Variable jump height: releasing jump early cuts the rise, once.
    if (jumpReleased && n.vy > 0) n.vy *= P.jumpCut;
  }

  // Move, one axis at a time, stopping at the first solid cell.
  let nx = s.x + n.vx;
  if (world.solid.hits(nx - P.width / 2, s.y, P.width, P.height)) {
    n.vx = 0;
    nx = s.x;
  }
  let ny = s.y + n.vy;
  let onGround = false;
  if (world.solid.hits(nx - P.width / 2, ny, P.width, P.height)) {
    if (n.vy <= 0) onGround = true;   // blocked moving down: we are standing on it
    n.vy = 0;
    ny = s.y;
  }
  n.x = nx;
  n.y = ny;
  n.onGround = onGround;

  // Which wall are we against?
  const box = { x: n.x - P.width / 2, y: n.y, w: P.width, h: P.height };
  const wallL = world.solid.hits(box.x - 1, box.y, 1, box.h);
  const wallR = world.solid.hits(box.x + box.w, box.y, 1, box.h);
  n.wall = wallL ? -1 : wallR ? 1 : 0;

  // Hazards, the goal, and the floor of the world.
  if (world.hazards && world.hazards.some((h) => overlaps(box, h))) n.dead = true;
  if (world.end && overlaps(box, world.end)) n.won = true;
  if (world.deathY !== undefined && n.y < world.deathY) n.dead = true;

  return n;
}

/** Run a whole input log. Returns every state, so a trail can be drawn from it. */
export function simulate(world, inputs, opts = {}) {
  const P = opts.P || PHYSICS;
  let s = opts.start || startState(world.start.x, world.start.y, opts);
  const states = [s];
  for (let i = 0; i < inputs.length; i++) {
    s = step(s, inputs[i], world, P);
    states.push(s);
    if (s.won || s.dead) break;
  }
  return states;
}
