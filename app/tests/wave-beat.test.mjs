import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBeat, BEAT_ANIMATIONS } from '../src/wave-beat.js';

const units = [
  { peakX: 500, shape: 'single' },
  { peakX: 900, shape: 'double' },
  { peakX: 100, shape: 'sharp' }, // left of the pulse line: never crosses
];

test('nextBeat picks the nearest peak to reach the pulse line', () => {
  const b = nextBeat(units, 2000, 400, 100, 0);
  assert.equal(b.shape, 'single');
  assert.equal(Math.round(b.delayMs), 1000); // peak at 500, line at 400 -> offset 100 -> 1 s at 100 px/s
});

test('nextBeat moves on to the next peak and wraps around', () => {
  assert.equal(nextBeat(units, 2000, 400, 100, 100).shape, 'double'); // single just fired
  const w = nextBeat(units, 2000, 400, 100, 500); // both done: wraps to single next lap
  assert.equal(w.shape, 'single');
  assert.equal(Math.round(w.delayMs), 1600 / 100 * 1000);
});

test('nextBeat returns null when nothing can cross or speed is zero', () => {
  assert.equal(nextBeat([{ peakX: 10, shape: 'single' }], 2000, 400, 100, 0), null);
  assert.equal(nextBeat(units, 2000, 400, 0, 0), null);
});

test('beat animations start and end at the resting stroke width', () => {
  for (const def of Object.values(BEAT_ANIMATIONS)) {
    assert.equal(def.keyframes[0].strokeWidth, 2);
    assert.equal(def.keyframes.at(-1).strokeWidth, 2);
  }
});
