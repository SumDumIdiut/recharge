import test from 'node:test';
import assert from 'node:assert/strict';
import { isActive, onActivity, setWindowBackground } from '../src/activity.js';

test('activity follows the window state and tells subscribers once per change', () => {
  const seen = [];
  const off = onActivity((on) => seen.push(on));
  assert.equal(isActive(), true);
  setWindowBackground(true);
  setWindowBackground(true); // no change, no second call
  assert.equal(isActive(), false);
  setWindowBackground(false);
  assert.equal(isActive(), true);
  assert.deepEqual(seen, [false, true]);
  off();
  setWindowBackground(true);
  assert.deepEqual(seen, [false, true]);
  setWindowBackground(false);
});
