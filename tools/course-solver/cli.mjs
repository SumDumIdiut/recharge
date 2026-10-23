// Shared CLI plumbing for solve.mjs and replay.mjs.

import { readFileSync } from 'node:fs';
import { worldFromMap, worldFromLevel, demoWorld } from './course.mjs';

const FLAGS = new Set(['verbose', 'verify', 'demo', 'every']);

/** A dead-simple `--key value` / `--flag` parser. */
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2).toLowerCase();
    if (FLAGS.has(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

/** Build the world the CLI asked for. One of --demo, --level or --map is required. */
export function loadWorld(o) {
  if (o.demo) return demoWorld();
  if (o.level) return worldFromLevel(JSON.parse(readFileSync(o.level, 'utf8')));
  if (o.map) {
    const map = JSON.parse(readFileSync(o.map, 'utf8'));
    const prim = o.prim ? JSON.parse(readFileSync(o.prim, 'utf8')) : undefined;
    return worldFromMap(map, Number(o.course ?? 0), {
      prim,
      endSize: o.endsize ? Number(o.endsize) : undefined,
      margin: o.margin ? Number(o.margin) : undefined,
    });
  }
  throw new Error('one of --map, --level or --demo is required');
}
