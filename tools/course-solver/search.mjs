// The search: fastest input sequence through a course.
//
// Three modes, all over the same `step`:
//   uniform  breadth-first over the quantised state graph — exact, the literal brute force
//   astar    the same graph with an admissible heuristic — exact, and much faster
//   brute    iterative-deepening enumeration of input sequences, for tiny courses, as ground truth
//
// See amplifier-vault/Solver/Search Algorithm.

import { DT, PHYSICS, ACTIONS, startState, step, stateKey } from './physics.mjs';

// ---- a tiny binary heap keyed on `f` -------------------------------------
function push(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p].f <= h[i].f) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function pop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l].f < h[m].f) m = l;
      if (r < h.length && h[r].f < h[m].f) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

function reconstruct(node) {
  const inputs = [];
  const states = [];
  for (let cur = node; cur; cur = cur.parent) {
    inputs.push(cur.input);
    states.push(cur.s);
  }
  inputs.reverse();
  states.reverse();
  inputs.shift(); // the root has no input
  return { inputs, states };
}

function pack(result, opts) {
  return { dt: opts.dt ?? DT, ...result };
}

/**
 * Best-first search over the quantised state graph.
 *
 * `opts`: mode ('astar' | 'uniform'), nodes, qx/qy/qv, actions, start, P, dt.
 */
export function solve(world, opts = {}) {
  const P = opts.P || PHYSICS;
  const mode = opts.mode || 'astar';
  if (mode === 'brute') return brute(world, opts);
  if (mode === 'beam') return beam(world, opts);

  const q = { x: opts.qx ?? 4, y: opts.qy ?? 4, v: opts.qv ?? 1 };
  const actions = opts.actions || ACTIONS;
  const budget = opts.nodes ?? 400000;
  const start = opts.start || startState(world.start.x, world.start.y, opts);
  const goal = world.end;
  const gc = { x: goal.x + goal.w / 2, y: goal.y + goal.h / 2 };

  // An admissible heuristic: straight-line distance over an upper bound on speed. Never overshoots
  // the true remaining frames, so A* stays exact.
  const h = (s) => Math.max(0, Math.hypot(s.x - gc.x, s.y + P.height / 2 - gc.y) / P.maxSpeed);

  const heap = [];
  const seen = new Map();
  const root = { s: start, key: stateKey(start, q), parent: null, input: 0, g: 0 };
  seen.set(root.key, 0);
  push(heap, { n: root, f: mode === 'astar' ? h(start) : 0 });

  let expansions = 0;
  let bounded = false;
  let closest = root;
  let closestH = h(start);

  while (heap.length) {
    if (expansions >= budget) { bounded = true; break; }
    const { n } = pop(heap);
    if (n.g > (seen.get(n.key) ?? Infinity)) continue; // a better route to this state exists
    expansions++;

    if (n.s.won) {
      const { inputs, states } = reconstruct(n);
      return pack({ solved: true, bounded, mode, expansions, frames: n.g, inputs, states, time: n.g * (opts.dt ?? DT) }, opts);
    }
    if (n.s.dead) continue;

    const hn = h(n.s);
    if (hn < closestH) { closestH = hn; closest = n; }

    for (const a of actions) {
      const ns = step(n.s, a, world, P);
      const k = stateKey(ns, q);
      const prev = seen.get(k);
      if (prev !== undefined && prev <= ns.f) continue;
      seen.set(k, ns.f);
      const child = { s: ns, key: k, parent: n, input: a, g: ns.f };
      push(heap, { n: child, f: ns.f + (mode === 'astar' ? h(ns) : 0) });
    }
  }

  const { inputs, states } = reconstruct(closest);
  return pack({
    solved: false, bounded, mode, expansions, frames: closest.g, inputs, states,
    time: closest.g * (opts.dt ?? DT),
    note: bounded ? 'node budget exhausted' : 'the end box is unreachable',
  }, opts);
}

/**
 * A bounded, frame-synchronous beam search.
 *
 * Exact search cannot touch a real course: one is thousands of units long, and A* would need
 * millions of expansions. Beam search keeps only the `beam` most promising states at each frame,
 * so it finds *a* route in a predictable time. It does NOT prove the route is the fastest, and the
 * result says so (`optimal: false`).
 */
export function beam(world, opts = {}) {
  const P = opts.P || PHYSICS;
  const q = { x: opts.qx ?? 8, y: opts.qy ?? 8, v: opts.qv ?? 1 };
  const actions = opts.actions || ACTIONS;
  const width = opts.beam ?? 600;
  const maxFrames = opts.maxFrames ?? 6000;
  const budget = opts.nodes ?? 1500000;
  const start = opts.start || startState(world.start.x, world.start.y, opts);
  const goal = world.end;
  const gc = { x: goal.x + goal.w / 2, y: goal.y + goal.h / 2 };
  const h = (s) => Math.hypot(s.x - gc.x, s.y + P.height / 2 - gc.y);

  const seen = new Set([stateKey(start, q)]);
  let layer = [{ s: start, parent: null, input: 0, g: 0, h: h(start) }];
  let expansions = 0;
  let bounded = false;

  for (let f = 0; f < maxFrames; f++) {
    const next = [];
    for (const n of layer) {
      for (const a of actions) {
        if (expansions >= budget) { bounded = true; break; }
        expansions++;
        const ns = step(n.s, a, world, P);
        if (ns.dead) continue;
        const k = stateKey(ns, q);
        if (seen.has(k)) continue;
        seen.add(k);
        const child = { s: ns, parent: n, input: a, g: ns.f, h: h(ns) };
        if (ns.won) {
          const { inputs, states } = reconstruct(child);
          return pack({
            solved: true, bounded, optimal: false, mode: 'beam', expansions,
            frames: child.g, inputs, states, time: child.g * (opts.dt ?? DT),
            note: 'beam search: a valid route, not proven fastest',
          }, opts);
        }
        next.push(child);
      }
      if (bounded) break;
    }
    if (bounded || !next.length) break;
    // Keep the frames whose states are closest to the goal; the frame count is the cost, so it is
    // a tie-break rather than the primary key.
    next.sort((a, b) => a.h - b.h || a.g - b.g);
    layer = next.length > width ? next.slice(0, width) : next;
  }

  // Nothing reached the goal: hand back the closest state reached, so its trail can still be drawn.
  let closest = null;
  for (const n of layer) if (!closest || n.h < closest.h) closest = n;
  const { inputs, states } = closest ? reconstruct(closest) : { inputs: [], states: [start] };
  return pack({
    solved: false, bounded, optimal: false, mode: 'beam', expansions,
    frames: inputs.length, inputs, states, time: inputs.length * (opts.dt ?? DT),
    note: bounded ? 'beam budget exhausted' : `beam search did not reach the end within ${maxFrames} frames`,
  }, opts);
}

/**
 * Iterative-deepening enumeration of input sequences. Exact for the depth it reaches, and the
 * ground truth the fast modes are checked against. Only viable on small courses.
 */
export function brute(world, opts = {}) {
  const P = opts.P || PHYSICS;
  const q = { x: opts.qx ?? 4, y: opts.qy ?? 4, v: opts.qv ?? 1 };
  const actions = opts.actions || ACTIONS;
  const start = opts.start || startState(world.start.x, world.start.y, opts);
  const maxDepth = opts.maxDepth ?? 120;
  const budget = opts.nodes ?? 2000000;
  let expansions = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const seen = new Map();
    const inputs = [];
    const path = [start];
    let found = null;

    const dfs = (s, d) => {
      if (expansions >= budget) return false;
      if (s.won) { found = { inputs: inputs.slice(), states: path.slice() }; return true; }
      if (d >= depth || s.dead) return false;
      const k = stateKey(s, q);
      const prev = seen.get(k);
      if (prev !== undefined && prev <= d) return false;
      seen.set(k, d);
      for (const a of actions) {
        expansions++;
        const ns = step(s, a, world, P);
        inputs.push(a);
        path.push(ns);
        if (dfs(ns, d + 1)) return true;
        inputs.pop();
        path.pop();
      }
      return false;
    };

    if (dfs(start, 0)) {
      return pack({
        solved: true, bounded: false, mode: 'brute', expansions,
        frames: found.inputs.length, inputs: found.inputs, states: found.states,
        time: found.inputs.length * (opts.dt ?? DT),
      }, opts);
    }
    if (expansions >= budget) {
      return pack({ solved: false, bounded: true, mode: 'brute', expansions, frames: 0, time: 0, inputs: [], states: [start], note: `node budget exhausted at depth ${depth}` }, opts);
    }
  }
  return pack({ solved: false, bounded: false, mode: 'brute', expansions, frames: 0, time: 0, inputs: [], states: [start], note: `no route within ${maxDepth} frames` }, opts);
}
