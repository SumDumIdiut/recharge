/** Playtest mode: drops a simulated player at the spawn and runs it at the fixed 60 Hz step, over the editor canvas. Decoupled from the editor's tools. */
import { COURSE, GATE_LIFT, SPAWN_LIFT, gate, gatePoint } from '../content/course.js';
import type { Camera } from '../core/camera.js';
import type { AmpMap } from '../core/map.js';
import { CELL } from '../core/types.js';
import type { Atlas } from '../atlas.js';
import { drawMoverBody, type Mover } from '../content/mover.js';
import { Controller } from './controller.js';
import { CONFIDENCE, DT, physicsFor, type Physics, type PlayerRules } from './physics.js';
import { playerBox, startState, step, stateTag, type SimState, type World } from './step.js';
import { Trail } from './trail.js';
import { buildWorld } from './world.js';

export class Playtest {
  active = false;
  state: SimState;
  trail = new Trail();
  physics: Physics;
  deaths = 0;
  /** Frames the finish took, once won. */
  finished: number | null = null;
  private map: AmpMap;
  private world: World;
  private spawn: { x: number; y: number };
  private ctl = new Controller();
  private acc = 0;
  private last = 0;
  private raf = 0;
  private follow = true;
  private camera: Camera;
  private redraw: () => void;
  private onStop: () => void;
  private listeners: Array<[string, (e: any) => void]> = [];

  constructor(map: AmpMap, camera: Camera, redraw: () => void, onStop: () => void) {
    this.map = map;
    this.camera = camera;
    this.redraw = redraw;
    this.onStop = onStop;
    this.physics = physicsFor(null);
    this.world = buildWorld(map);
    this.spawn = { x: 0, y: 0 };
    this.state = startState(0, 0);
  }

  /** Where a run begins: the spawn, else the start gate, else the world origin. */
  static spawnPoint(map: AmpMap): { x: number; y: number } {
    const sp = gate(map, 'spawn') || gate(map, 'start');
    if (!sp) return { x: CELL / 2, y: 2 * CELL };
    const [x, y] = gatePoint(sp, gate(map, 'spawn') ? SPAWN_LIFT : GATE_LIFT);
    // the spawn/gate heights are where the player's origin sits; the simulated player stands with its feet at the cell's bottom
    return { x, y: sp.y * CELL };
  }

  start(): void {
    if (this.active) return;
    this.world = buildWorld(this.map);
    this.physics = physicsFor((this.map.raw?.player as PlayerRules | undefined) ?? null);
    this.spawn = Playtest.spawnPoint(this.map);
    this.reset(true);
    this.active = true;
    const on = (type: string, fn: (e: any) => void): void => { window.addEventListener(type, fn, true); this.listeners.push([type, fn]); };
    on('keydown', (e: KeyboardEvent) => this.key(e, true));
    on('keyup', (e: KeyboardEvent) => this.key(e, false));
    on('blur', () => this.ctl.clear());
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    this.redraw();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    for (const [t, f] of this.listeners) window.removeEventListener(t, f, true);
    this.listeners = [];
    this.ctl.clear();
    this.onStop();
    this.redraw();
  }

  /** Back to the spawn. `clearTrail` also wipes the path. */
  reset(clearTrail = false): void {
    this.state = startState(this.spawn.x, this.spawn.y, this.physics);
    this.finished = null;
    if (clearTrail) { this.trail.clear(); this.deaths = 0; }
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.active) return;
    if (down) {
      if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stop(); return; }
      if (e.code === 'KeyR') { e.preventDefault(); e.stopPropagation(); this.reset(false); return; }
      if (e.code === 'KeyC') { e.preventDefault(); e.stopPropagation(); this.trail.clear(); this.redraw(); return; }
      if (e.code === 'KeyF') { e.preventDefault(); e.stopPropagation(); this.follow = !this.follow; return; }
      if (this.ctl.down(e.code)) { e.preventDefault(); e.stopPropagation(); }
    } else this.ctl.up(e.code);
  }

  private frame(now: number): void {
    if (!this.active) return;
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= DT) { this.tick(this.ctl.mask()); this.acc -= DT; }
    if (this.follow) {
      this.camera.x += (this.state.x - this.camera.x) * 0.12;
      this.camera.y += (this.state.y + 40 - this.camera.y) * 0.12;
    }
    this.redraw();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** One fixed frame with an input mask (also how tests and replays drive it). */
  tick(input: number): void {
    if (this.state.won) return;
    this.state = step(this.state, input, this.world, this.physics);
    this.trail.add(this.state.x, this.state.y, stateTag(this.state));
    if (this.state.dead) { this.trail.die(this.state.x, this.state.y); this.deaths++; this.reset(false); }
    else if (this.state.won && this.finished === null) this.finished = this.state.f;
  }

  /** The moving platforms where they are right now. */
  platformBoxes(): Array<{ x: number; y: number; w: number; h: number; look: unknown }> {
    return (this.world.platforms ?? []).map((p, i) => ({ ...p.boxAt(this.state.mt?.[i] || 0), look: p.look }));
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, atlas?: Atlas): void {
    if (atlas) {
      for (const b of this.platformBoxes()) {
        const [x0, y0] = cam.toScreen(b.x, b.y + b.h);
        drawMoverBody({ ctx, atlas }, x0, y0, b.look as Mover, CELL * cam.zoom, 1);
      }
    }
    this.trail.draw(ctx, cam);
    const b = playerBox(this.state, this.physics);
    const [x0, y0] = cam.toScreen(b.x, b.y + b.h), [x1, y1] = cam.toScreen(b.x + b.w, b.y);
    ctx.fillStyle = this.state.dashFrames > 0 ? '#dc72ec' : '#f9ffe4';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // HUD
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(16,18,20,0.8)';
    ctx.fillRect(12, cam.height - 70, 520, 58);
    ctx.fillStyle = '#f9ffe4';
    const t = ((this.finished ?? this.state.f) / 60).toFixed(2);
    ctx.fillText((this.finished !== null ? 'FINISHED ' : 'PLAYTEST ') + t + 's   deaths ' + this.deaths + '   air jumps ' + this.state.airJumps + '   dashes ' + this.state.airDashes, 22, cam.height - 48);
    ctx.fillStyle = 'rgba(249,255,228,0.65)';
    ctx.fillText('Arrows/WASD move · Space/Z jump · Shift/X dash · R reset · C clear trail · F follow · Esc stop', 22, cam.height - 28);
    ctx.fillText('physics: ' + (Object.values(CONFIDENCE).includes('uncalibrated') ? 'approximate (uncalibrated)' : 'calibrated') + '; abilities from the map rules', 22, cam.height - 14);
  }

  has(layer: string): boolean { return layer === COURSE; }
}
