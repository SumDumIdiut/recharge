// Drawing the route. The first of the two requested outputs — see
// amplifier-vault/Solver/Route Trail Rendering.
//
// Pure: it returns an SVG string. No DOM, no canvas, viewable anywhere, diff-able.

import { unionBox } from './geom.mjs';

/** The colour of a trail segment, by the state it was drawn in. */
export const STATE_COLOR = {
  ground: '#3b82f6', // blue
  air: '#22d3ee',    // cyan
  jump: '#22c55e',   // green
  dash: '#a855f7',   // magenta
  wall: '#f59e0b',   // amber
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Render a world plus a replay's trail as one SVG.
 *
 * Layers, back to front: background wash, solids, hazards, start/end, the trail (colour-coded by
 * state), markers at jumps and dashes, labels.
 */
export function renderSVG(world, file, opts = {}) {
  const scale = opts.scale ?? 1;
  const pad = opts.pad ?? 64;
  const trail = file.trail || [];

  const boxes = [];
  if (world.end) boxes.push(world.end);
  if (world.start) boxes.push({ x: world.start.x - 10, y: world.start.y, w: 20, h: 44 });
  for (const h of world.hazards || []) boxes.push(h);
  const sb = world.solid.bounds();
  if (sb) boxes.push({ x: sb.minX, y: sb.minY, w: sb.maxX - sb.minX, h: sb.maxY - sb.minY });
  for (const p of trail) boxes.push({ x: p.x, y: p.y, w: 1, h: 1 });

  const b = unionBox(boxes, pad) || { minX: 0, minY: 0, maxX: 320, maxY: 320 };
  const W = Math.max(1, Math.ceil((b.maxX - b.minX) * scale));
  const H = Math.max(1, Math.ceil((b.maxY - b.minY) * scale));
  const sx = (x) => (x - b.minX) * scale;
  const sy = (y) => (b.maxY - y) * scale;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#0b1220"/>`);

  // Solid geometry.
  parts.push('<g fill="#334155">');
  for (const c of world.solid.iter()) {
    parts.push(`<rect x="${sx(c.x).toFixed(2)}" y="${sy(c.y + c.h).toFixed(2)}" width="${(c.w * scale).toFixed(2)}" height="${(c.h * scale).toFixed(2)}"/>`);
  }
  parts.push('</g>');

  // Hazards.
  parts.push('<g fill="#ef4444" fill-opacity="0.85">');
  for (const hz of world.hazards || []) {
    parts.push(`<rect x="${sx(hz.x).toFixed(2)}" y="${sy(hz.y + hz.h).toFixed(2)}" width="${(hz.w * scale).toFixed(2)}" height="${(hz.h * scale).toFixed(2)}"/>`);
  }
  parts.push('</g>');

  // Start and end.
  if (world.start) {
    parts.push(`<line x1="${sx(world.start.x).toFixed(2)}" y1="${sy(world.start.y).toFixed(2)}" x2="${sx(world.start.x).toFixed(2)}" y2="${sy(world.start.y + 44).toFixed(2)}" stroke="#22c55e" stroke-width="${(2 * scale).toFixed(2)}"/>`);
    parts.push(`<text x="${(sx(world.start.x) + 6).toFixed(2)}" y="${(sy(world.start.y + 44) - 6).toFixed(2)}" fill="#22c55e" font-family="monospace" font-size="${(14 * scale).toFixed(2)}">start</text>`);
  }
  if (world.end) {
    parts.push(`<rect x="${sx(world.end.x).toFixed(2)}" y="${sy(world.end.y + world.end.h).toFixed(2)}" width="${(world.end.w * scale).toFixed(2)}" height="${(world.end.h * scale).toFixed(2)}" fill="none" stroke="#facc15" stroke-width="${(2 * scale).toFixed(2)}"/>`);
    parts.push(`<text x="${(sx(world.end.x) + 6).toFixed(2)}" y="${(sy(world.end.y + world.end.h) - 6).toFixed(2)}" fill="#facc15" font-family="monospace" font-size="${(14 * scale).toFixed(2)}">end</text>`);
  }

  // The trail: a dark underlay for contrast, then one segment per step, coloured by state.
  const pts = trail.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`);
  if (pts.length > 1) {
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="${(5 * scale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (let i = 1; i < trail.length; i++) {
      const c = STATE_COLOR[trail[i].s] || '#94a3b8';
      parts.push(`<line x1="${sx(trail[i - 1].x).toFixed(2)}" y1="${sy(trail[i - 1].y).toFixed(2)}" x2="${sx(trail[i].x).toFixed(2)}" y2="${sy(trail[i].y).toFixed(2)}" stroke="${c}" stroke-width="${(3 * scale).toFixed(2)}" stroke-linecap="round"/>`);
    }
  }

  // Markers: a triangle where a jump starts, a diamond where a dash starts.
  for (let i = 0; i < trail.length; i++) {
    const was = i ? trail[i - 1].s : null;
    const p = trail[i];
    const x = sx(p.x), y = sy(p.y);
    if (p.s === 'jump' && was !== 'jump') {
      parts.push(`<polygon points="${x.toFixed(2)},${(y - 5 * scale).toFixed(2)} ${(x - 5 * scale).toFixed(2)},${(y + 4 * scale).toFixed(2)} ${(x + 5 * scale).toFixed(2)},${(y + 4 * scale).toFixed(2)}" fill="#22c55e" stroke="#000"/>`);
    } else if (p.s === 'dash' && was !== 'dash') {
      parts.push(`<polygon points="${x.toFixed(2)},${(y - 6 * scale).toFixed(2)} ${(x + 6 * scale).toFixed(2)},${y.toFixed(2)} ${x.toFixed(2)},${(y + 6 * scale).toFixed(2)} ${(x - 6 * scale).toFixed(2)},${y.toFixed(2)}" fill="#a855f7" stroke="#000"/>`);
    }
  }

  // Labels.
  const title = `course ${file.course} · ${file.time.toFixed(3)}s · ${file.frames} frames · ${file.mode}${file.bounded ? ' (bounded)' : ''}${file.optimal === false ? ' (route, not proven fastest)' : ''}`;
  const legend = 'trail: blue=ground cyan=air green=jump magenta=dash amber=wall';
  parts.push(`<text x="8" y="${(16 * scale + 4).toFixed(2)}" fill="#e2e8f0" font-family="monospace" font-size="${(13 * scale).toFixed(2)}">${esc(title)}</text>`);
  parts.push(`<text x="8" y="${(32 * scale + 4).toFixed(2)}" fill="#94a3b8" font-family="monospace" font-size="${(11 * scale).toFixed(2)}">${esc(legend)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}
