/** The course overlay: gates, resets, the course screen, spawns and checkpoint boxes, drawn over the map the way the old editor's drawCourses / drawGate did. */
import type { Camera } from './core/camera.js';
import type { AmpMap } from './core/map.js';
import { dataLayer } from './core/layers.js';
import { CELL, parseKey, type Cell } from './core/types.js';
import {
  END_BOX, RESET_BOX, SCREEN_BOX, SPAWN_BOX, START_BOX, courseColor, courseById, courseNumber, courseScreen, courses, endPoint, extraSpawns, gate, resetPoint, spawnPoint, startPoint, type World,
} from './content/coursedata.js';
import { LIFT, OBJECTS, isCheckpoint, trigOf, type PlacedObject } from './content/objects.js';

const COLORS = { spawn: '#5ec8f0', reset: '#f0a040', checkpoint: '#5ec8f0', courseCheckpoint: '#ffb347' };

// ---- the course screen's board: the game's board image, 9-sliced as its UI stretches it ----
let board: HTMLImageElement | null = null, boardAsked = false;
let listeners: Array<() => void> = [];
/** Called when the board picture has loaded (the editor repaints). */
export function onCourseArtLoaded(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}
function boardImage(): HTMLImageElement | null {
  if (board || boardAsked || typeof Image === 'undefined') return board;
  boardAsked = true;
  const img = new Image();
  img.onload = () => { board = img; for (const l of listeners) l(); };
  img.src = 'amp/art/course-screen.png';
  return null;
}
const BOARD_SLICE = 30, BOARD_EDGE = [(30 / 1.2) * 1.1, (30 / 1.2) * 1.15];
function drawBoard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, zoom: number): void {
  const img = boardImage();
  if (!img) { ctx.fillStyle = 'rgba(40,52,60,0.9)'; ctx.fillRect(x, y, w, h); return; }
  const iw = img.naturalWidth, ih = img.naturalHeight, b = BOARD_SLICE;
  const ex = Math.min(BOARD_EDGE[0] * zoom, w / 2), ey = Math.min(BOARD_EDGE[1] * zoom, h / 2);
  const sx = [0, b, iw - b, iw], sy = [0, b, ih - b, ih];
  const dx = [x, x + ex, x + w - ex, x + w], dy = [y, y + ey, y + h - ey, y + h];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (dx[i + 1] - dx[i] <= 0 || dy[j + 1] - dy[j] <= 0) continue;
    ctx.drawImage(img, sx[i], sy[j], sx[i + 1] - sx[i], sy[j + 1] - sy[j], dx[i], dy[j], dx[i + 1] - dx[i], dy[j + 1] - dy[j]);
  }
}

interface Box { dx: number; dy: number; w: number; h: number }

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(16,18,20,0.78)';
  ctx.fillRect(x - w / 2, y - 12, w, 16);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** A trigger box at a gate (the old drawGate): tinted, outlined, named above when zoomed in enough. */
function drawGate(ctx: CanvasRenderingContext2D, cam: Camera, g: World, box: Box, color: string, text: string): void {
  const z = cam.zoom;
  const [cx, cy] = cam.toScreen(g.x + box.dx, g.y + box.dy);
  const w = Math.max(4, box.w * z), h = Math.max(3, box.h * z);
  if (cx + w / 2 < -320 || cx - w / 2 > cam.width + 320 || cy + h / 2 < -60 || cy - h / 2 > cam.height + 60) return;
  ctx.save();
  ctx.globalAlpha *= 0.18;
  ctx.fillStyle = color;
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
  if (z >= 0.2) label(ctx, text, cx, cy - h / 2 - 6, color);
}

const centre = (cam: Camera, g: World, b: Box): [number, number] => cam.toScreen(g.x + b.dx, g.y + b.dy);

export function drawCourse(ctx: CanvasRenderingContext2D, cam: Camera, map: AmpMap): void {
  const z = cam.zoom;
  const cs = courses(map);
  ctx.save();
  cs.forEach((c, i) => {
    const n = i + 1, col = courseColor(map, c.id);
    if (c.start && c.end) {
      const [ax, ay] = centre(cam, startPoint(c.start), START_BOX), [bx, by] = centre(cam, endPoint(c.end), END_BOX);
      ctx.strokeStyle = col; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      // the screen (reward, best time and clones in the game)
      const at = courseScreen(c);
      if (at) {
        const [sx, sy] = cam.toScreen(at.x + SCREEN_BOX.dx - SCREEN_BOX.w / 2, at.y + SCREEN_BOX.dy + SCREEN_BOX.h / 2);
        drawBoard(ctx, sx, sy, SCREEN_BOX.w * z, SCREEN_BOX.h * z, z);
        if (z >= 0.12) label(ctx, 'COURSE ' + n + ' SCREEN', sx + (SCREEN_BOX.w * z) / 2, sy - 2, col);
        ctx.font = '700 ' + Math.max(8, Math.round(22 * z)) + 'px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(230,240,250,0.85)';
        ctx.textAlign = 'center';
        if (z >= 0.12) ctx.fillText(c.reward.amount + ' ' + (c.reward.currency === 'Cash' ? 'cash' : c.reward.currency), sx + (SCREEN_BOX.w * z) / 2, sy + (SCREEN_BOX.h * z) / 2 + 6 * z);
      }
    }
    if (c.start) drawGate(ctx, cam, startPoint(c.start), START_BOX, col, 'START ' + n);
    if (c.end) drawGate(ctx, cam, endPoint(c.end), END_BOX, col, 'END ' + n);
    if (z >= 0.15) for (const r of c.resets) drawGate(ctx, cam, resetPoint(r.cell), RESET_BOX, COLORS.reset, 'TIMER RESET');
  });
  ctx.restore();

  // checkpoints: the trigger box (the flag and respawn stand at the object), and a thin line to the course one is filed under
  for (const layer of map.layerDefs) {
    if (!layer.visible) continue;
    const data = map.layers[dataLayer(OBJECTS, layer.id)];
    if (!data) continue;
    for (const [key, v] of data) {
      const o = v as PlacedObject;
      if (!isCheckpoint(o?.t)) continue;
      const cell = parseKey(key), pos: World = { x: cell.x * CELL + CELL / 2, y: cell.y * CELL + LIFT[o.t] };
      const link = o.course ? courseById(map, o.course) : undefined, cc = o.t === 'courseCheckpoint';
      const col = link ? courseColor(map, link.id) : cc ? COLORS.courseCheckpoint : COLORS.checkpoint;
      const t = trigOf(o);
      drawGate(ctx, cam, pos, t, col, (cc ? 'COURSE CHECKPOINT' : 'CHECKPOINT') + (link ? ' · COURSE ' + courseNumber(map, link.id) : cc ? ' · ANY COURSE' : ''));
      const g = link && (link.start ? { p: startPoint(link.start), b: START_BOX } : link.end ? { p: endPoint(link.end), b: END_BOX } : null);
      if (g) {
        const [ax, ay] = cam.toScreen(pos.x, pos.y), [bx, by] = centre(cam, g.p, g.b);
        ctx.save();
        ctx.strokeStyle = col; ctx.globalAlpha = 0.4; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.restore();
      }
    }
  }

  const spawn = gate(map, 'spawn');
  if (spawn) drawGate(ctx, cam, spawnPoint(spawn), SPAWN_BOX, COLORS.spawn, 'SPAWN');
  for (const s of extraSpawns(map)) drawGate(ctx, cam, spawnPoint(s.cell as Cell), SPAWN_BOX, COLORS.spawn, 'SPAWN ' + s.i);
}
