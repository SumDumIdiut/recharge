/** The integrator: step(state, input, world) -> state, exactly one fixed frame, pure and deterministic. No DOM, no clocks. */
import { BASE_PHYSICS, type Physics } from './physics.js';

const CELL = 32;

/** Buttons as a bitmask. */
export const BUTTON = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, JUMP: 16, DASH: 32 } as const;

export interface Box { x: number; y: number; w: number; h: number }

/** A platform that moves on a timetable (a mover). `boxAt(clock)` is where it is `clock` frames into its trip; `cycle` is one whole trip. */
export interface Platform { boxAt(clock: number): Box; auto: boolean; cycle: number; /** What the content type draws it from. */ look?: unknown }

export interface World {
  /** Moving platforms: solid, and they carry a player standing on them. */
  platforms?: Platform[];
  /** Whether the box overlaps any solid cell. */
  solidHits(x: number, y: number, w: number, h: number): boolean;
  hazards: Box[];
  end: Box | null;
  /** Falling below this is death. */
  deathY?: number;
}

export interface SimState {
  x: number; y: number; vx: number; vy: number;
  onGround: boolean;
  coyote: number; jumpBuffer: number; jumpHeld: boolean;
  airDashes: number; airJumps: number;
  dashFrames: number; dashCooldown: number;
  wall: -1 | 0 | 1;
  facing: -1 | 1;
  dead: boolean; won: boolean;
  /** Frames since the run began. */
  f: number;
  /** Where each moving platform is in its trip, in frames (an on-touch one rests at 0 until touched). */
  mt: number[];
}

export function startState(x: number, y: number, P: Physics = BASE_PHYSICS): SimState {
  return {
    x, y, vx: 0, vy: 0, onGround: false, coyote: 0, jumpBuffer: 0, jumpHeld: false,
    airDashes: P.airDashes, airJumps: P.airJumps, dashFrames: 0, dashCooldown: 0, wall: 0, facing: 1, dead: false, won: false, f: 0, mt: [],
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** What the player is doing (colours the trail). */
export type Tag = 'ground' | 'jump' | 'air' | 'wall' | 'dash';
export function stateTag(s: SimState): Tag {
  if (s.dashFrames > 0) return 'dash';
  if (s.onGround) return 'ground';
  if (s.vy > 0) return 'jump';
  if (s.wall !== 0) return 'wall';
  return 'air';
}

export const playerBox = (s: SimState, P: Physics = BASE_PHYSICS): Box => ({ x: s.x - P.width / 2, y: s.y, w: P.width, h: P.height });

export function step(s: SimState, input: number, world: World, P: Physics = BASE_PHYSICS): SimState {
  const n: SimState = { ...s, f: s.f + 1 };
  if (s.dead || s.won) return n;

  const left = !!(input & BUTTON.LEFT), right = !!(input & BUTTON.RIGHT), up = !!(input & BUTTON.UP), down = !!(input & BUTTON.DOWN);
  const jump = !!(input & BUTTON.JUMP), dash = !!(input & BUTTON.DASH);
  const jumpPressed = jump && !s.jumpHeld;
  const jumpReleased = s.jumpHeld && !jump;
  n.jumpHeld = jump;
  n.jumpBuffer = jumpPressed ? P.jumpBuffer : Math.max(0, s.jumpBuffer - 1);
  n.coyote = s.onGround ? P.coyote : Math.max(0, s.coyote - 1);

  const dir = (right ? 1 : 0) - (left ? 1 : 0);
  if (dir) n.facing = dir as -1 | 1;

  // dash: a timed burst; the ground dash needs the ability, an air dash needs a charge
  if (n.dashCooldown > 0) n.dashCooldown--;
  const startedDash = dash && P.dashUnlocked && s.dashCooldown === 0 && s.dashFrames === 0 && (s.onGround || s.airDashes > 0);
  if (startedDash) {
    n.dashCooldown = P.dashFrames + P.dashCooldown;
    if (!s.onGround) n.airDashes = s.airDashes - 1;
    const ay = (up ? 1 : 0) - (down ? 1 : 0);
    if (dir === 0 && ay === 0) { n.vx = n.facing * P.dashSpeed; n.vy = 0; }
    else { const m = Math.hypot(dir, ay); n.vx = (dir / m) * P.dashSpeed; n.vy = (ay / m) * P.dashSpeed; }
  }

  if (startedDash || s.dashFrames > 0) {
    n.dashFrames = (startedDash ? P.dashFrames : s.dashFrames) - 1;
  } else {
    if (dir) {
      const acc = s.onGround ? P.runAccel : P.airAccel;
      n.vx = clamp(s.vx + dir * acc, -P.runMax, P.runMax);
    } else {
      const f = Math.sign(s.vx) * (s.onGround ? P.friction : P.airDrag);
      n.vx = Math.abs(s.vx) <= Math.abs(f) ? 0 : s.vx - f;
    }
    // a dash's burst does not outlive the dash
    if (Math.abs(s.vx) > P.runMax) n.vx = clamp(n.vx, -P.runMax, P.runMax);

    n.vy = Math.max(-P.fallMax, s.vy - P.gravity);
    if (P.wallJumpUnlocked && !s.onGround && s.wall !== 0 && s.vy < 0 && ((s.wall < 0 && left) || (s.wall > 0 && right))) n.vy = Math.max(n.vy, -P.wallSlide);

    if (n.jumpBuffer > 0) {
      if (s.onGround || s.coyote > 0) { n.vy = P.jumpVel; n.jumpBuffer = 0; n.coyote = 0; n.onGround = false; }
      else if (P.wallJumpUnlocked && s.wall !== 0) { n.vy = P.wallJumpY; n.vx = -s.wall * P.wallJumpX; n.facing = (-s.wall) as -1 | 1; n.jumpBuffer = 0; }
      else if (s.airJumps > 0) { n.vy = P.jumpVel * 0.9; n.airJumps = s.airJumps - 1; n.jumpBuffer = 0; }
    }
    if (jumpReleased && n.vy > 0) n.vy *= P.jumpCut;
  }

  // refill on the ground
  if (s.onGround) { n.airJumps = P.airJumps; n.airDashes = P.airDashes; }

  // moving platforms: advance their clocks, then carry a player who stands on one
  const plats = world.platforms ?? [];
  const hw = P.width / 2, H = P.height;
  let bx = s.x, by = s.y;
  let pb: Box[] = [];
  if (plats.length) {
    const old = s.mt || [];
    const mt: number[] = [];
    const before = plats.map((p, i) => p.boxAt(old[i] || 0));
    plats.forEach((p, i) => {
      let c = old[i] || 0;
      const riding = s.onGround && Math.abs(s.y - (before[i].y + before[i].h)) <= 1.5 && s.x + hw > before[i].x && s.x - hw < before[i].x + before[i].w;
      if (p.auto) c = (c + 1) % p.cycle;
      else if (c > 0) c = c + 1 >= p.cycle ? 0 : c + 1;
      else if (riding) c = 1;
      mt.push(c);
    });
    n.mt = mt;
    pb = plats.map((p, i) => p.boxAt(mt[i]));
    for (let i = 0; i < plats.length; i++) {
      const b = before[i];
      if (!(s.onGround && Math.abs(s.y - (b.y + b.h)) <= 1.5 && s.x + hw > b.x && s.x - hw < b.x + b.w)) continue;
      const cx = s.x + (pb[i].x - b.x), cy = pb[i].y + pb[i].h;
      if (!world.solidHits(cx - hw, cy, P.width, H)) { bx = cx; by = cy; }
      break;
    }
  }
  const platHit = (x: number, y: number, w: number, h: number): Box | null => {
    for (const b of pb) if (x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h) return b;
    return null;
  };

  // move one axis at a time; on a hit, rest flush against the cell edge (falling short of it would leave a gap that grows with speed)
  let nx = bx + n.vx;
  if (world.solidHits(nx - hw, by, P.width, H)) {
    const cand = n.vx > 0 ? Math.floor((nx + hw) / CELL) * CELL - hw : (Math.floor((nx - hw) / CELL) + 1) * CELL + hw;
    nx = !world.solidHits(cand - hw, by, P.width, H) && Math.abs(cand - bx) <= Math.abs(n.vx) ? cand : bx;
    n.vx = 0;
  }
  const side = platHit(nx - hw, by, P.width, H);
  if (side) {
    const toLeft = n.vx > 0 || (n.vx === 0 && nx < side.x + side.w / 2);
    nx = toLeft ? side.x - hw : side.x + side.w + hw;
    if (n.vx !== 0 && (n.vx > 0) === toLeft) n.vx = 0;
  }
  let ny = by + n.vy;
  let onGround = false;
  if (world.solidHits(nx - hw, ny, P.width, H)) {
    const cand = n.vy <= 0 ? (Math.floor(ny / CELL) + 1) * CELL : Math.floor((ny + H) / CELL) * CELL - H;
    if (n.vy <= 0) onGround = true;
    ny = !world.solidHits(nx - hw, cand, P.width, H) && Math.abs(cand - by) <= Math.abs(n.vy) ? cand : by;
    n.vy = 0;
  }
  const hit = platHit(nx - hw, ny, P.width, H);
  if (hit) {
    if (n.vy <= 0 && by >= hit.y + hit.h - 1.5) { ny = hit.y + hit.h; onGround = true; n.vy = 0; }
    else if (n.vy > 0 || by + H <= hit.y + 1.5) { ny = hit.y - H; if (n.vy > 0) n.vy = 0; }
    else { ny = hit.y + hit.h; onGround = true; n.vy = 0; }
  }
  n.x = nx; n.y = ny; n.onGround = onGround;

  const box = playerBox(n, P);
  n.wall = world.solidHits(box.x - 1, box.y, 1, box.h) || platHit(box.x - 1, box.y, 1, box.h) ? -1 : world.solidHits(box.x + box.w, box.y, 1, box.h) || platHit(box.x + box.w, box.y, 1, box.h) ? 1 : 0;

  if (world.hazards.some((h) => overlaps(box, h))) n.dead = true;
  if (world.end && overlaps(box, world.end)) n.won = true;
  if (world.deathY !== undefined && n.y < world.deathY) n.dead = true;
  return n;
}
