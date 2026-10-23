#!/usr/bin/env node
// Solve one course for its fastest possible time, then write the replay and draw the trail.
// See amplifier-vault/Solver/Running the Solver.

import { writeFileSync } from 'node:fs';
import { parseArgs, loadWorld } from './cli.mjs';
import { solve } from './search.mjs';
import { PHYSICS } from './physics.mjs';
import { makeReplay, verify, formatInputs } from './replay.mjs';
import { renderSVG } from './render.mjs';

function main(argv) {
  const o = parseArgs(argv);
  const world = loadWorld(o);
  const opts = {
    mode: o.mode || 'astar',
    nodes: o.nodes ? Number(o.nodes) : undefined,
    qx: o.qx ? Number(o.qx) : undefined,
    qy: o.qy ? Number(o.qy) : undefined,
    qv: o.qv ? Number(o.qv) : undefined,
    maxDepth: o.maxdepth ? Number(o.maxdepth) : undefined,
    beam: o.beam ? Number(o.beam) : undefined,
    maxFrames: o.maxframes ? Number(o.maxframes) : undefined,
    sample: o.sample ? Number(o.sample) : 1,
    course: Number(o.course ?? 0),
  };

  const result = solve(world, opts);
  const file = makeReplay(world, result, opts);

  const status = result.solved ? 'solved' : result.bounded ? 'bounded' : 'unsolved';
  const line = [
    `course ${file.course}:`,
    `${file.time.toFixed(3)} s`,
    `(${file.frames} frames)`,
    opts.mode,
    status,
    `${file.trail.length} trail pts`,
    `model: ${PHYSICS.confidence}`,
  ].join(' ');
  console.log(line);
  if (result.optimal === false) console.log('note: this is a valid route, NOT proven fastest (beam search)');
  if (file.note) console.log('note: ' + file.note);

  if (o.out) {
    writeFileSync(o.out + '.json', JSON.stringify(file, null, 1) + '\n');
    writeFileSync(o.out + '.svg', renderSVG(world, file, { scale: o.scale ? Number(o.scale) : 1 }));
    console.log(`wrote ${o.out}.json and ${o.out}.svg`);
  }
  if (o.verbose) console.log(formatInputs(file.inputs, { every: !!o.every }));
  if (o.verify) {
    const v = verify(file, world, opts);
    console.log(v.ok ? 'verify: replay reproduces the trail exactly' : `verify: MISMATCH frames=${v.sameFrames} time=${v.sameTime} trail=${v.sameTrail}`);
    if (!v.ok) process.exitCode = 1;
  }
  return file;
}

main(process.argv.slice(2));
