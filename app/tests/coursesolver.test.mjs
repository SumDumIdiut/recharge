// Tests for the course route solver (tools/course-solver/).
//
// Run: node --test app/tests/coursesolver.test.mjs
//
// The point of most of these is that the three ways of finding a route agree. If they ever
// disagree, the search or the model is wrong, and that is the bug worth catching.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { overlaps, contains, SolidGrid, unionBox, CELL } from '../../tools/course-solver/geom.mjs';
import {
  PHYSICS, BUTTON, ACTIONS, DT,
  startState, step, simulate, stateTag, buttonNames,
} from '../../tools/course-solver/physics.mjs';
import {
  isSolidTilemap, worldFromLevel, worldFromMap, demoWorld, tinyWorld,
} from '../../tools/course-solver/course.mjs';
import { solve, brute } from '../../tools/course-solver/search.mjs';
import { buildTrail, replay, makeReplay, verify, formatInputs, mask } from '../../tools/course-solver/replay.mjs';
import { renderSVG, STATE_COLOR } from '../../tools/course-solver/render.mjs';

// ---- shared fixtures ------------------------------------------------------
// Solving the demo is the most expensive thing here, so it happens once and every test reuses it.

const DEMO = { world: demoWorld(), result: null, file: null };
function demoResult() {
  return (DEMO.result ??= solve(DEMO.world, { mode: 'astar' }));
}
function demoReplay() {
  return (DEMO.file ??= makeReplay(DEMO.world, demoResult(), {}));
}

// ---- geometry ------------------------------------------------------------

test('overlaps counts a real intersection, not a touch', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(overlaps(a, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(overlaps(a, { x: 10, y: 0, w: 10, h: 10 }), false, 'shared edge is not an overlap');
  assert.equal(overlaps(a, { x: -20, y: 0, w: 10, h: 10 }), false);
});

test('contains is bottom/left inclusive, top/right exclusive', () => {
  const r = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(contains(r, 0, 0), true);
  assert.equal(contains(r, 9.999, 9.999), true);
  assert.equal(contains(r, 10, 5), false);
  assert.equal(contains(r, 5, -0.001), false);
});

test('SolidGrid fills every cell a box touches, and reports bounds', () => {
  const g = new SolidGrid(32);
  assert.equal(g.size, 0);
  assert.equal(g.bounds(), null);
  g.addRect(0, 0, 64, 32);            // exactly two cells
  assert.equal(g.size, 2);
  assert.equal(g.hits(0, 0, 1, 1), true);
  assert.equal(g.hits(64, 0, 1, 1), false);
  g.addRect(10, 10, 20, 20);          // an unaligned box still marks the cells it touches
  assert.equal(g.hits(10, 10, 1, 1), true);
  const b = g.bounds();
  assert.equal(b.minX, 0);
  assert.equal(b.minY, 0);
  assert.equal(b.maxX, 64);
  assert.equal(b.maxY, 32);
});

test('unionBox pads and handles empties', () => {
  assert.equal(unionBox([]), null);
  const u = unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 10, h: 10 }], 2);
  assert.deepEqual(u, { minX: -2, minY: -7, maxX: 32, maxY: 12 });
});

test('CELL is the editor cell', () => {
  assert.equal(CELL, 32);
});

// ---- physics -------------------------------------------------------------

const air = () => worldFromLevel({
  cell: 32,
  solids: [[-4096, -64, 8192, 32]],          // a floor far below; the player is airborne
  hazards: [],
  start: [0, 0],
  end: [1e6, 1e6, 1, 1],
  deathY: -1e6,
});

test('step is pure: the same state and input give the same result', () => {
  const w = air();
  const s = startState(0, 0);
  const a = step(s, BUTTON.RIGHT | BUTTON.JUMP, w, PHYSICS);
  const b = step(s, BUTTON.RIGHT | BUTTON.JUMP, w, PHYSICS);
  assert.deepEqual(a, b);
  assert.deepEqual(s, startState(0, 0), 'the input state was not mutated');
});

test('step never mutates the state it is given', () => {
  const w = air();
  const s = startState(0, 0);
  const before = JSON.stringify(s);
  step(s, 0, w, PHYSICS);
  assert.equal(JSON.stringify(s), before);
});

test('simulate is deterministic', () => {
  const w = demoWorld();
  const inputs = [0, BUTTON.RIGHT, BUTTON.RIGHT, BUTTON.RIGHT | BUTTON.JUMP, BUTTON.RIGHT];
  const a = simulate(w, inputs).map((s) => stateTag(s));
  const b = simulate(w, inputs).map((s) => stateTag(s));
  assert.deepEqual(a, b);
});

test('a dash is a burst: it lasts dashFrames and does not persist', () => {
  const w = air();
  let s = startState(0, 0);
  s = step(s, BUTTON.DASH, w, PHYSICS);          // no direction: dashes the way it faces
  assert.equal(s.dashFrames, PHYSICS.dashFrames - 1, 'the start frame counts as the first');
  assert.equal(s.vx, PHYSICS.dashSpeed);
  assert.equal(s.vy, 0, 'a horizontal dash ignores gravity while it runs');

  let frames = 1;
  while (s.dashFrames > 0) { s = step(s, 0, w, PHYSICS); frames++; }
  assert.equal(frames, PHYSICS.dashFrames, 'the dash lasted exactly dashFrames');
  assert.equal(s.vx, PHYSICS.dashSpeed, 'velocity is held for the whole dash');

  s = step(s, 0, w, PHYSICS);
  assert.ok(Math.abs(s.vx) <= PHYSICS.runMax, `vx fell back to the run cap, got ${s.vx}`);
});

test('an air dash is only available airDashes times', () => {
  const w = air();
  let s = startState(0, 0);
  s = step(s, BUTTON.DASH, w, PHYSICS);
  assert.equal(s.airDashes, PHYSICS.airDashes - 1);
  // Drain the dash, then immediately try again while still airborne.
  while (s.dashFrames > 0) s = step(s, 0, w, PHYSICS);
  s = step(s, BUTTON.DASH, w, PHYSICS);
  assert.equal(s.dashFrames, 0, 'no second air dash');
});

test('buttonNames and stateTag are total', () => {
  assert.deepEqual(buttonNames(BUTTON.RIGHT | BUTTON.JUMP).sort(), ['jump', 'right']);
  assert.deepEqual(buttonNames(0), []);
  assert.equal(stateTag({ dashFrames: 3, onGround: true, vy: 0, wall: 0 }), 'dash');
  assert.equal(stateTag({ dashFrames: 0, onGround: true, vy: 0, wall: 0 }), 'ground');
  assert.equal(stateTag({ dashFrames: 0, onGround: false, vy: 2, wall: 0 }), 'jump');
  assert.equal(stateTag({ dashFrames: 0, onGround: false, vy: -2, wall: 1 }), 'wall');
  assert.equal(stateTag({ dashFrames: 0, onGround: false, vy: -2, wall: 0 }), 'air');
});

// ---- course extraction ---------------------------------------------------

test('isSolidTilemap knows ground from vines, and honours overrides', () => {
  assert.equal(isSolidTilemap('ground'), true);
  assert.equal(isSolidTilemap('orangeBlocks'), true);
  assert.equal(isSolidTilemap('vines'), false);
  assert.equal(isSolidTilemap('backgroundDeco'), false);
  assert.equal(isSolidTilemap('mystery'), false);
  assert.equal(isSolidTilemap('mystery', { mystery: true }), true);
  assert.equal(isSolidTilemap('ground', { ground: false }), false);
});

test('worldFromLevel builds the world the spec describes', () => {
  const w = worldFromLevel({ cell: 32, solids: [[0, 0, 64, 32]], hazards: [[0, 32, 32, 32]], start: [8, 40], end: [32, 32, 16, 16] });
  assert.equal(w.solid.size, 2);
  assert.equal(w.hazards.length, 1);
  assert.deepEqual(w.start, { x: 8, y: 40 });
  assert.deepEqual(w.end, { x: 32, y: 32, w: 16, h: 16 });
});

test('worldFromMap reads a course, its solids and its spikes', () => {
  const map = {
    name: 'm',
    groups: [{
      courses: [{ startX: 48, startY: 40, endX: 160, endY: 40 }],
      objects: [{ type: 'trueSpike', x: 96, y: 32, w: 32, h: 32 }, { type: 'spring', x: 0, y: 0 }],
    }],
    tileLayers: [
      { tilemap: 'ground', names: ['floor'], runs: [0, 0, 8, 0, 0] },          // 8 cells, row 0
      { tilemap: 'vines', names: ['v'], runs: [1, 0, 8, 0, 0] },               // not solid
    ],
  };
  const w = worldFromMap(map, 0, { margin: 512 });
  assert.equal(w.cell, 32);
  assert.equal(w.solid.size, 8, 'only the ground layer contributed');
  assert.equal(w.hazards.length, 1, 'only the spike is a hazard');
  assert.deepEqual(w.start, { x: 48, y: 40 });
  assert.equal(w.end.w, 96, 'the end box has the requested size');
});

test('worldFromMap throws a clear error for a missing course', () => {
  assert.throws(() => worldFromMap({ groups: [] }, 0), /no group/);
  assert.throws(() => worldFromMap({ groups: [{}] }, 3), /course 3 does not exist/);
});

test('the built-in demo and tiny worlds are non-empty', () => {
  for (const w of [demoWorld(), tinyWorld()]) {
    assert.ok(w.solid.size > 0);
    assert.ok(w.start && w.end);
    assert.equal(typeof w.deathY, 'number');
  }
});

// ---- search --------------------------------------------------------------

test('all three modes find the same optimum on a tiny course', () => {
  const w = tinyWorld();
  const astar = solve(w, { mode: 'astar' });
  const uniform = solve(w, { mode: 'uniform' });
  const exact = brute(w, { maxDepth: 60 });

  assert.equal(astar.solved, true);
  assert.equal(uniform.solved, true);
  assert.equal(exact.solved, true, 'brute solved it too');
  assert.equal(uniform.frames, astar.frames, 'uniform and A* agree');
  assert.equal(exact.frames, astar.frames, 'brute and A* agree');
  assert.equal(astar.inputs.length, astar.frames);
  assert.equal(astar.states.length, astar.frames + 1);
  assert.ok(Math.abs(astar.time - astar.frames * DT) < 1e-9);
});

test('the route never walks through a wall or a spike', () => {
  const w = DEMO.world;
  const r = demoResult();
  assert.equal(r.solved, true);
  for (const s of r.states) {
    assert.equal(w.solid.hits(s.x - PHYSICS.width / 2, s.y, PHYSICS.width, PHYSICS.height), false, 'the player is never inside a solid');
    assert.equal(w.hazards.some((h) => overlaps({ x: s.x - PHYSICS.width / 2, y: s.y, w: PHYSICS.width, h: PHYSICS.height }, h)), false, 'the player never touches a hazard');
  }
});

test('A* expands fewer states than uniform search for the same answer', () => {
  const w = tinyWorld();
  const a = solve(w, { mode: 'astar' });
  const u = solve(w, { mode: 'uniform' });
  assert.equal(a.solved, true);
  assert.equal(u.solved, true);
  assert.equal(a.frames, u.frames, 'same answer');
  assert.ok(a.expansions < u.expansions, `A* ${a.expansions} should beat uniform ${u.expansions}`);
});

test('on the bigger demo course, uniform search exhausts its budget and A* does not', () => {
  const w = demoWorld();
  const a = demoResult();
  assert.equal(a.solved, true);
  assert.equal(a.bounded, false);
  const u = solve(w, { mode: 'uniform', nodes: 100000 });
  assert.equal(u.solved, false, 'uniform needs more than 100k expansions here');
  assert.equal(u.bounded, true);
  assert.match(u.note, /budget/);
});

test('the demo course has a pinned optimum under the current model', () => {
  // Not a claim about the game: a claim about this model. A physics change should fail this on
  // purpose, so the change is reviewed rather than absorbed.
  const r = demoResult();
  assert.equal(r.solved, true);
  assert.equal(r.frames, 60);
  assert.ok(Math.abs(r.time - 60 * DT) < 1e-9);
});

test('the node budget is reported, never hidden', () => {
  const r = solve(tinyWorld(), { mode: 'astar', nodes: 1 });
  assert.equal(r.solved, false);
  assert.equal(r.bounded, true);
  assert.match(r.note, /budget/);
  assert.deepEqual(r.inputs, []);
});

test('an unreachable end is reported as unreachable', () => {
  // The player is sealed in a one-cell-wide shaft; the end lives inside the right wall.
  const w = worldFromLevel({
    cell: 32,
    solids: [
      [0, 0, 96, 32],      // floor
      [0, 0, 32, 96],      // left wall
      [64, 32, 32, 64],    // the wall the end is buried in
      [0, 96, 96, 32],     // ceiling, so you cannot jump out
    ],
    hazards: [],
    start: [44, 40],
    end: [72, 48, 24, 24],
    deathY: -256,
  });
  const r = solve(w, { mode: 'uniform', nodes: 200000 });
  assert.equal(r.solved, false);
  assert.equal(r.bounded, false, 'the search exhausted rather than hitting its budget');
  assert.match(r.note, /unreachable/);
});

test('every action is a distinct input inside the declared bit range', () => {
  const seen = new Set(ACTIONS);
  assert.equal(seen.size, ACTIONS.length, 'no duplicate actions');
  for (const a of ACTIONS) assert.ok(a >= 0 && a < 128);
  assert.ok(ACTIONS.includes(0));
});

// ---- replay --------------------------------------------------------------

test('the input log replays to the same trail and time', () => {
  const w = DEMO.world;
  const result = demoResult();
  const file = makeReplay(w, result, { course: 3 });
  assert.equal(file.version, 1);
  assert.equal(file.course, 3);
  assert.equal(file.frames, result.frames);
  assert.equal(file.inputs.length, file.frames, 'one input per frame');

  const v = verify(file, w, {});
  assert.equal(v.ok, true);
  assert.equal(v.sameFrames, true);
  assert.equal(v.sameTime, true);
  assert.equal(v.sameTrail, true);
});

test('the trail is in frame order, starts at 0 and ends on the last frame', () => {
  const file = demoReplay();
  assert.equal(file.trail[0].f, 0);
  assert.equal(file.trail.at(-1).f, file.frames);
  for (let i = 1; i < file.trail.length; i++) {
    assert.ok(file.trail[i].f > file.trail[i - 1].f, 'frames strictly increase');
    assert.ok(file.trail[i].s in STATE_COLOR, 'every point has a known state tag');
  }
});

test('buildTrail samples and always keeps the final point', () => {
  const r = demoResult();
  const coarse = buildTrail(r.states, 5);
  assert.ok(coarse.length < r.states.length);
  assert.equal(coarse[0].f, 0);
  assert.equal(coarse.at(-1).f, r.frames);
  assert.equal(coarse.at(-1).s, stateTag(r.states.at(-1)));
});

test('an empty input log is a valid (degenerate) replay', () => {
  const w = demoWorld();
  const run = replay(w, []);
  assert.equal(run.frames, 0);
  assert.equal(run.trail.length, 1);
  assert.equal(run.won, false);
});

test('an unsolved result still produces a well-formed replay file', () => {
  const w = tinyWorld();
  const file = makeReplay(w, solve(w, { mode: 'astar', nodes: 1 }), {});
  assert.equal(file.solved, false);
  assert.equal(file.bounded, true);
  assert.deepEqual(file.inputs, []);
  assert.equal(file.trail[0].f, 0);
});

test('formatInputs and mask render the log readably', () => {
  assert.equal(mask(BUTTON.RIGHT | BUTTON.JUMP), '·R··J··');
  assert.equal(mask(0), '·······');
  const text = formatInputs([0, 0, BUTTON.RIGHT, BUTTON.RIGHT, BUTTON.RIGHT | BUTTON.JUMP]);
  assert.match(text, /frame 0/);
  assert.match(text, /right \+ jump/);
  assert.ok(!text.includes('frame 1'), 'unchanged frames are not repeated by default');
  assert.match(formatInputs([0, 0], { every: true }), /frame 1/);
});

// ---- rendering -----------------------------------------------------------

test('the trail renders as an SVG with geometry and a polyline', () => {
  const w = DEMO.world;
  const file = demoReplay();
  const svg = renderSVG(w, file);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes('<polyline'), 'the trail is drawn as a polyline');
  assert.ok(svg.includes('#0b1220'), 'background wash');
  assert.ok(svg.includes('#334155'), 'solid geometry');
  assert.ok(svg.includes('#22c55e'), 'jump colour / start marker');
  assert.ok(svg.trimEnd().endsWith('</svg>'));
});

test('rendering the same replay twice is byte-identical', () => {
  const w = DEMO.world;
  const file = demoReplay();
  assert.equal(renderSVG(w, file), renderSVG(w, file), 'determinism is the whole point');
});

test('the SVG frames the trail, not just the geometry', () => {
  const w = tinyWorld();
  const file = makeReplay(w, solve(w, { mode: 'astar' }), {});
  const svg = renderSVG(w, file, { pad: 0 });
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  assert.ok(m, 'the SVG declares a size');
  assert.ok(Number(m[1]) >= 160 && Number(m[2]) >= 32);
});

test('a hand-authored input log (a playtest) replays and draws, with no solver involved', () => {
  // This is the playtesting path: a human produces inputs frame by frame; the same replay format,
  // the same trail, the same renderer as a solved route.
  const w = tinyWorld();
  const inputs = [];
  for (let f = 0; f < 60; f++) inputs.push(BUTTON.RIGHT);
  const run = replay(w, inputs);
  assert.equal(run.won, true, 'holding right on the tiny course reaches the end');
  assert.ok(run.frames <= 60, `the run stops at the goal, got ${run.frames} frames`);
  assert.equal(run.trail[0].f, 0);
  assert.ok(run.trail.length > 1);
  const file = { version: 1, course: 0, mode: 'playtest', dt: DT, time: run.time, frames: run.frames, solved: run.won, inputs, trail: run.trail };
  const svg = renderSVG(w, file);
  assert.ok(svg.includes('<polyline'), 'a playtest trail draws exactly like a solved one');
  assert.equal(verify(file, w, {}).ok, true, 'a playtest log replays exactly');
  assert.match(formatInputs(inputs), /frame\s+0/);
  assert.match(formatInputs(inputs), /right/);
});

test('every trail state has a distinct colour', () => {
  const colors = Object.values(STATE_COLOR);
  assert.equal(new Set(colors).size, colors.length);
});

// ---- the real map.json shapes --------------------------------------------
// The Hub stores the object-list form, not tileLayers: geometry arrives as
// {type:'tile', tilemap, cellX, cellY} entries and spikes as objects with a hitbox.

test('worldFromMap reads the object-list form', () => {
  const map = {
    name: 'objects-map',
    levelOrigin: [0, 9],
    groups: [{
      courses: [{ startX: 64, startY: 96, endX: 224, endY: 96 }],
      objects: [
        ...[0, 1, 2, 3].map((cx) => ({ type: 'tile', tilemap: 'ground', tileName: 'g', cellX: cx, cellY: 0, matrix: [1, 0, 0, 1] })),
        { type: 'tile', tilemap: 'Spikes', tileName: 's', cellX: 5, cellY: 0, matrix: [1, 0, 0, 1] },
        { type: 'tile', tilemap: 'moss', tileName: 'm', cellX: 6, cellY: 0, matrix: [1, 0, 0, 1] },
        { type: 'trueSpike', x: 160, y: 32, hitbox: [-12, -16, 12, 22], rotation: 0 },
        { type: 'sign', x: 8, y: 8 },
      ],
    }],
  };
  const w = worldFromMap(map, 0, { margin: 64 });
  // A tile sits at (cellX*32, cellY*32) in the file's own frame — the same frame the object
  // x/y live in, because the game puts both through LevelPoint.
  assert.equal(w.solid.has(0, 0), true);
  assert.equal(w.solid.has(3, 0), true);
  assert.equal(w.solid.has(4, 0), false, 'the spike tile is not a wall');
  assert.equal(w.solid.has(6, 0), false, 'moss is not solid');
  assert.deepEqual(w.start, { x: 64, y: 96 });
  assert.equal(w.end.w, 96);
  assert.equal(w.hazards.length, 2, 'one spike object and one spike tile');
  assert.ok(w.hazards.some((h) => h.x === 148 && h.y === 16 && h.w === 24 && h.h === 38), 'the spike object uses its hitbox');
  assert.ok(w.hazards.some((h) => h.x === 160 && h.y === 0 && h.w === 32 && h.h === 32), 'the spike tile is a cell');
});

test('objects outside the course box are dropped, so a huge map stays a small grid', () => {
  const far = [];
  for (let cx = 0; cx < 8; cx++) far.push({ type: 'tile', tilemap: 'ground', cellX: cx, cellY: 0 });
  far.push({ type: 'tile', tilemap: 'ground', cellX: 5000, cellY: 5000 });
  const map = {
    groups: [{ courses: [{ startX: 64, startY: 96, endX: 224, endY: 96 }], objects: far }],
  };
  const w = worldFromMap(map, 0, { margin: 64 });
  assert.equal(w.solid.has(5000, 5000), false, 'far-away geometry is not built');
  assert.equal(w.solid.size, 8);
});

// ---- beam search ---------------------------------------------------------

test('beam search finds a route on a small course and admits it is not optimal', () => {
  const w = tinyWorld();
  const b = solve(w, { mode: 'beam', beam: 50 });
  const a = solve(w, { mode: 'astar' });
  assert.equal(b.solved, true);
  assert.equal(b.optimal, false, 'beam never claims optimality');
  assert.ok(b.frames >= a.frames, `beam ${b.frames} cannot beat the optimum ${a.frames}`);
  const file = makeReplay(w, b, {});
  assert.equal(file.optimal, false, 'the flag survives into the replay file');
  assert.equal(verify(file, w, {}).ok, true, 'a beam route is still exactly replayable');
});

test('beam search reports honestly when it cannot reach the end', () => {
  const w = worldFromLevel({
    cell: 32,
    solids: [[0, 0, 96, 32], [0, 0, 32, 96], [64, 32, 32, 64], [0, 96, 96, 32]],
    hazards: [],
    start: [44, 40],
    end: [72, 48, 24, 24],
    deathY: -256,
  });
  const r = solve(w, { mode: 'beam', beam: 50, maxFrames: 200 });
  assert.equal(r.solved, false);
  assert.match(r.note, /did not reach/);
});
