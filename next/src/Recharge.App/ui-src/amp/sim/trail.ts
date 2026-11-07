/** The path the player took: kept as points, drawn faded with age and coloured by what the player was doing. */
import type { Camera } from '../core/camera.js';
import type { Tag } from './step.js';

export interface TrailPoint { x: number; y: number; tag: Tag }

export const TAG_COLOR: Record<Tag, string> = { ground: '#41f88d', jump: '#ffd24a', air: '#8ec5ff', wall: '#ff9f5a', dash: '#dc72ec' };

export class Trail {
  points: TrailPoint[] = [];
  /** Where the player died, each marked with a cross. */
  deaths: Array<{ x: number; y: number }> = [];
  max = 8000;
  add(x: number, y: number, tag: Tag): void {
    this.points.push({ x, y, tag });
    if (this.points.length > this.max) this.points.splice(0, this.points.length - this.max);
  }
  die(x: number, y: number): void { this.deaths.push({ x, y }); }
  clear(): void { this.points = []; this.deaths = []; }

  /** `fade` is how many of the newest points stay fully visible before ageing out (the rest fade towards 0.12). */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, fade = 1500): void {
    const pts = this.points;
    if (pts.length < 2) return;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const age = pts.length - i;
      const a = age < fade ? 1 : Math.max(0.12, 1 - (age - fade) / (this.max - fade));
      const p = pts[i - 1], q = pts[i];
      const [x0, y0] = cam.toScreen(p.x, p.y + 22), [x1, y1] = cam.toScreen(q.x, q.y + 22);
      ctx.globalAlpha = a;
      ctx.strokeStyle = TAG_COLOR[q.tag];
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ff6a6a';
    ctx.lineWidth = 2;
    for (const d of this.deaths) {
      const [x, y] = cam.toScreen(d.x, d.y + 22);
      ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke();
    }
  }
}
