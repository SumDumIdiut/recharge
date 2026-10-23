// The replay: the frame-indexed input log and the trail. Both come out of one run, and both are
// for playback. See amplifier-vault/Solver/Replay Format.

import { DT, simulate, stateTag, buttonNames, BUTTON } from './physics.mjs';

const r2 = (n) => Math.round(n * 100) / 100;

/** A sampled polyline from a run's states. */
export function buildTrail(states, sample = 1) {
  const out = [];
  const step = Math.max(1, Math.floor(sample));
  for (let i = 0; i < states.length; i += step) {
    const s = states[i];
    out.push({ f: s.f, x: r2(s.x), y: r2(s.y), s: stateTag(s) });
  }
  const last = states[states.length - 1];
  if (!out.length || out[out.length - 1].f !== last.f) {
    out.push({ f: last.f, x: r2(last.x), y: r2(last.y), s: stateTag(last) });
  }
  return out;
}

/** Run an input log and collect the trail. */
export function replay(world, inputs, opts = {}) {
  const states = simulate(world, inputs, opts);
  const last = states[states.length - 1];
  return {
    states,
    trail: buildTrail(states, opts.sample ?? 1),
    frames: states.length - 1,
    time: (states.length - 1) * (opts.dt ?? DT),
    won: !!last.won,
    dead: !!last.dead,
  };
}

/** Turn a search result into the replay file. Works for an unsolved result too (empty inputs). */
export function makeReplay(world, result, opts = {}) {
  const inputs = result.inputs || [];
  const run = replay(world, inputs, { ...opts, start: result.states?.[0] });
  return {
    version: 1,
    course: opts.course ?? 0,
    mode: result.mode,
    dt: opts.dt ?? DT,
    time: result.time ?? 0,
    frames: result.frames ?? inputs.length,
    solved: !!result.solved,
    bounded: !!result.bounded,
    optimal: result.optimal,
    expansions: result.expansions,
    note: result.note,
    inputs: inputs.slice(),
    trail: run.trail,
  };
}

/**
 * Re-run a replay file's inputs and check they reproduce the same trail and time.
 * A replay that does not reproduce is always a bug.
 */
export function verify(file, world, opts = {}) {
  const run = replay(world, file.inputs, { ...opts, sample: opts.sample ?? 1 });
  const sameFrames = run.frames === file.frames;
  const sameTime = Math.abs(run.time - file.time) < 1e-6;
  const sameTrail =
    run.trail.length === file.trail.length &&
    run.trail.every((p, i) => p.f === file.trail[i].f && p.x === file.trail[i].x && p.y === file.trail[i].y && p.s === file.trail[i].s);
  return { ok: sameFrames && sameTime && sameTrail, run, sameFrames, sameTime, sameTrail };
}

/** A human-readable listing of the inputs, frame by frame — only the frames that change. */
export function formatInputs(inputs, opts = {}) {
  const width = String(inputs.length - 1).length;
  const lines = [];
  let prev = -1;
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] === prev && !opts.every) continue;
    const names = buttonNames(inputs[i]);
    lines.push(
      `frame ${String(i).padStart(width)}  ${mask(inputs[i])}  ${names.length ? names.join(' + ') : '(idle)'}`,
    );
    prev = inputs[i];
  }
  return lines.join('\n');
}

/** The mask as a row of dots with a letter per held button — a compact visual. */
export function mask(m) {
  const order = [['L', BUTTON.LEFT], ['R', BUTTON.RIGHT], ['U', BUTTON.UP], ['D', BUTTON.DOWN], ['J', BUTTON.JUMP], ['X', BUTTON.DASH], ['S', BUTTON.SWAP]];
  return order.map(([c, bit]) => (m & bit ? c : '·')).join('');
}

// ---- CLI: replay an input log and redraw its trail ------------------------
// Run as: node replay.mjs --map map.json --replay route.json [--out base] [--verbose]
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { parseArgs, loadWorld } = await import('./cli.mjs');
  const { renderSVG } = await import('./render.mjs');

  const o = parseArgs(process.argv.slice(2));
  const world = loadWorld(o);
  if (!o.replay) throw new Error('--replay <file.json> is required');
  const file = JSON.parse(readFileSync(o.replay, 'utf8'));
  const run = replay(world, file.inputs, { sample: o.sample ? Number(o.sample) : 1 });
  const same = run.frames === file.frames && run.trail.length === file.trail.length;
  console.log(`replayed ${file.inputs.length} frames → ${run.time.toFixed(3)} s, won=${run.won}, dead=${run.dead}`);
  console.log(same ? 'trail reproduces' : 'trail DIFFERS from the file');
  if (o.verbose) console.log(formatInputs(file.inputs, { every: !!o.every }));
  if (o.out) {
    writeFileSync(o.out + '.svg', renderSVG(world, { ...file, trail: run.trail }, { scale: o.scale ? Number(o.scale) : 1 }));
    console.log(`wrote ${o.out}.svg`);
  }
}
