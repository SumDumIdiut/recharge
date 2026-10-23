// Turning a map (or a small level spec) into a world the solver can search.
//
// The world is: `{ solid, hazards, start, end, deathY }` — see physics.mjs for what step() needs.
//
// Two inputs:
//   worldFromLevel(level)        a small hand-written spec, for tests and --demo
//   worldFromMap(map, n, opts)   a real map.json (MapDefinition.cs), course n

import { SolidGrid, CELL } from './geom.mjs';

/** Tilemaps that collide by default. Anything vine/moss/deco-like is walk-through. */
const SOLID_NAME = /ground|blue|orange/i;
const NOT_SOLID_NAME = /vine|moss|deco|background|illusory|spike|hazard/i;

export function isSolidTilemap(name, overrides = {}) {
  if (name in overrides) return overrides[name];
  if (NOT_SOLID_NAME.test(name)) return false;
  return SOLID_NAME.test(name);
}

/**
 * A world from a hand-written level:
 *   { cell, solids: [[x,y,w,h]…], hazards: [[x,y,w,h]…], start: [x,y], end: [x,y,w,h], deathY }
 */
export function worldFromLevel(level) {
  const cell = level.cell || CELL;
  const solid = new SolidGrid(cell);
  for (const [x, y, w, h] of level.solids || []) solid.addRect(x, y, w, h);
  const hazards = (level.hazards || []).map(([x, y, w, h]) => ({ x, y, w, h }));
  const [ex, ey, ew, eh] = level.end;
  return {
    cell,
    solid,
    hazards,
    start: { x: level.start[0], y: level.start[1] },
    end: { x: ex, y: ey, w: ew, h: eh },
    deathY: level.deathY,
    source: level.name || 'level',
  };
}

/**
 * A world from a real map.json, around course `index` of group `opts.group ?? 0`.
 *
 * Two shapes of map.json exist and both are accepted:
 *   - `tileLayers` — every tile as runs of cells (the "rebuilt" form).
 *   - `groups[].objects` — the object list, where geometry arrives as `{type:'tile', tilemap,
 *     cellX, cellY}` entries. This is the form the Hub actually stores and the form the game's
 *     MapWorld.CellOf reads, so it is the common one.
 *
 * COORDINATES. Everything stays in the map file's own frame. The game positions a tile at
 * `((cellX+0.5)*32, (cellY+0.5)*32)` and an object at `(x, y)`, through the same `LevelPoint`, so
 * in that frame a tile's box is simply `(cellX*32, cellY*32, 32, 32)` and an object's `x`/`y` need
 * no adjustment. (`levelOrigin` only matters for placing the map in the world, which the solver
 * does not care about.)
 *
 * The grid is clipped to a box around the course, so a map with 90,000 tiles does not become a
 * 90,000-cell grid.
 */
export function worldFromMap(map, index = 0, opts = {}) {
  const group = (map.groups || [])[opts.group ?? 0];
  if (!group) throw new Error('map has no group ' + (opts.group ?? 0));
  return (map.tileLayers || []).length
    ? worldFromTileLayers(map, group, index, opts)
    : worldFromObjects(map, group, index, opts);
}

function courseAndBox(group, index, opts) {
  const courses = group.courses || [];
  const course = courses[index];
  if (!course) throw new Error('course ' + index + ' does not exist (this map has ' + courses.length + ')');
  const start = { x: course.startX, y: course.startY };
  const endHalf = (opts.endSize ?? 96) / 2;
  const end = { x: course.endX - endHalf, y: course.endY - endHalf, w: endHalf * 2, h: endHalf * 2 };
  // The box we care about: the course plus a margin, so a route may leave the straight line and
  // still have geometry. Not the whole map.
  const margin = opts.margin ?? 2048;
  return {
    course,
    start,
    end,
    box: {
      minX: Math.min(start.x, end.x) - margin,
      minY: Math.min(start.y, end.y) - margin,
      maxX: Math.max(start.x, end.x + end.w) + margin,
      maxY: Math.max(start.y, end.y + end.h) + margin,
    },
  };
}

const inBox = (box, x, y, w = 0, h = 0) => !(x + w < box.minX || x > box.maxX || y + h < box.minY || y > box.maxY);

/** Spike tiles are hazards, wherever they live. */
const HAZARD_TILEMAP = /spike|hazard/i;

function worldFromTileLayers(map, group, index, opts) {
  const cell = opts.cell || CELL;
  const { start, end, box } = courseAndBox(group, index, opts);
  const solid = new SolidGrid(cell);
  const overrides = opts.prim || {};
  for (const layer of map.tileLayers || []) {
    // A layer is solid or it is not; whether an individual tile has a "solid-looking" name is
    // unreliable (a ground layer's tiles are named groundTop/groundLeft/...). The layer decides.
    if (!isSolidTilemap(layer.tilemap, overrides)) continue;
    const runs = layer.runs || [];
    for (let i = 0; i + 4 < runs.length; i += 5) {
      const [ry, rx, count] = [runs[i], runs[i + 1], runs[i + 2]];
      if (!inBox(box, rx * cell, ry * cell, count * cell, cell)) continue;
      for (let k = 0; k < count; k++) if (inBox(box, (rx + k) * cell, ry * cell, cell, cell)) solid.add(rx + k, ry);
    }
  }
  return {
    cell, solid, hazards: objectHazards(group, box, opts),
    start, end, deathY: opts.deathY, source: map.name || 'map',
  };
}

function worldFromObjects(map, group, index, opts) {
  const cell = opts.cell || CELL;
  const { start, end, box } = courseAndBox(group, index, opts);
  const solid = new SolidGrid(cell);
  const overrides = opts.prim || {};
  for (const o of group.objects || []) {
    if (o.type !== 'tile') continue;
    if (o.cellX === undefined || o.cellY === undefined) continue;
    const x = o.cellX * cell, y = o.cellY * cell;
    if (!inBox(box, x, y, cell, cell)) continue;
    if (isSolidTilemap(o.tilemap || '', overrides)) solid.add(o.cellX, o.cellY);
  }
  return {
    cell, solid, hazards: objectHazards(group, box, opts),
    start, end, deathY: opts.deathY, source: map.name || 'map',
  };
}

/** The boxes that kill: spike objects and spike tiles, clipped to the course's box. */
function objectHazards(group, box, opts) {
  const cell = opts.cell || CELL;
  const out = [];
  for (const o of group.objects || []) {
    const type = o.type || '';
    let box2 = null;
    if (/^(trueSpike|freeSpike|spike)$/.test(type)) {
      const hb = o.hitbox;
      box2 = hb
        ? { x: o.x + hb[0], y: o.y + hb[1], w: hb[2] - hb[0], h: hb[3] - hb[1] }
        : { x: (o.x ?? 0) - cell / 2, y: (o.y ?? 0) - cell / 2, w: cell, h: cell };
    } else if (type === 'tile' && HAZARD_TILEMAP.test(o.tilemap || '') && o.cellX !== undefined) {
      box2 = { x: o.cellX * cell, y: o.cellY * cell, w: cell, h: cell };
    }
    if (box2 && inBox(box, box2.x, box2.y, box2.w, box2.h)) out.push(box2);
  }
  return out;
}

/**
 * A small built-in course: a floor, a spike to jump, a gap, a raised platform, the end.
 * Fast to solve and small enough to brute-force, so it is the sanity check for a change.
 */
export function demoWorld() {
  const level = {
    name: 'demo',
    cell: 32,
    solids: [
      [0, 0, 384, 32],       // the floor
      [448, 64, 256, 32],    // the platform after the gap
      [0, 0, 32, 256],       // a back wall so you cannot run off the left
    ],
    hazards: [[192, 32, 32, 32]],   // one spike on the floor
    start: [48, 40],
    end: [560, 96, 64, 64],
    deathY: -256,
  };
  return worldFromLevel(level);
}

/**
 * A minimal course: run right along a floor into the end. A few dozen frames, so `brute` can find
 * the exact optimum and the fast modes can be checked against it.
 */
export function tinyWorld() {
  return worldFromLevel({
    name: 'tiny',
    cell: 32,
    solids: [[0, 0, 256, 32], [0, 0, 32, 256]],
    hazards: [],
    start: [48, 40],
    end: [160, 32, 48, 48],
    deathY: -256,
  });
}
