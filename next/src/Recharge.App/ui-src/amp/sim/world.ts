/** Build the simulation world from the editor's map: solid cells, spike boxes, the end gate. */
import { solidAt } from '../content/blocks.js';
import { COURSE, END_BOX, END_LIFT, gate, gatePoint } from '../content/course.js';
import { MOVERS, cycleSeconds, moverBoxes, norm, progressAt } from '../content/mover.js';
import { eachLayer } from '../core/layers.js';
import { VINE, parseVine, vineBoxes } from '../content/vines.js';
import { SPIKES, parseSpike, spikeBox, spikeTurn } from '../content/spikes.js';
import type { AmpMap } from '../core/map.js';
import { CELL, parseKey } from '../core/types.js';
import { mapBounds } from '../model.js';
import type { Box, Platform, World } from './step.js';

/** The end gate's box: the game's own (END_BOX, a flat plate on the floor of its cell). */
export const END_HALF_WIDTH = END_BOX.w / 2;

export function buildWorld(map: AmpMap): World {
  const hazards: Box[] = [];
  for (const [key, value] of map.layer(SPIKES)) {
    const s = parseSpike(value);
    if (!s) continue;
    const c = parseKey(key);
    const b = spikeBox(spikeTurn(map, SPIKES, c.x, c.y, s));
    const mx = c.x * CELL + CELL / 2, my = c.y * CELL + CELL / 2;
    hazards.push({ x: mx + b.x0, y: my + b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  }
  // thorn vines are deadly inside their outline (boxes from the cell's middle)
  for (const { data } of eachLayer(map, VINE)) {
    for (const [key, value] of data) {
      const v = parseVine(value);
      if (!v) continue;
      const c = parseKey(key), mx = c.x * CELL + CELL / 2, my = c.y * CELL + CELL / 2;
      for (const b of vineBoxes(v.sprite, v.turn)) hazards.push({ x: mx + b.x0, y: my + b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
    }
  }
  const platforms: Platform[] = [];
  for (const { data } of eachLayer(map, MOVERS)) {
    for (const [key, value] of [...data].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const m = norm(value), { start, end } = moverBoxes(key, value);
      platforms.push({
        auto: m.auto, look: m,
        cycle: Math.max(1, Math.round(cycleSeconds(m) * 60)),
        boxAt(clock) {
          const k = progressAt(m, clock / 60);
          return { x: start.x + (end.x - start.x) * k, y: start.y + (end.y - start.y) * k, w: start.w, h: start.h };
        },
      });
    }
  }
  const endCell = gate(map, 'end');
  let end: Box | null = null;
  if (endCell) {
    const [ex, ey] = gatePoint(endCell, END_LIFT);
    end = { x: ex + END_BOX.dx - END_BOX.w / 2, y: ey + END_BOX.dy - END_BOX.h / 2, w: END_BOX.w, h: END_BOX.h };
  }
  const b = mapBounds(map);
  const deathY = b ? (b.y0 - 12) * CELL : -100 * CELL;
  return {
    hazards, end, deathY, platforms,
    solidHits(x, y, w, h) {
      const x0 = Math.floor(x / CELL), x1 = Math.floor((x + w - 1e-6) / CELL), y0 = Math.floor(y / CELL), y1 = Math.floor((y + h - 1e-6) / CELL);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (solidAt(map, cx, cy)) return true;
      return false;
    },
  };
}

export const hasCourse = (map: AmpMap): boolean => map.has(COURSE, 'spawn') || map.has(COURSE, 'start');
