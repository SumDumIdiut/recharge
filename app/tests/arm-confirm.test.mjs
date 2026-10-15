// The two-step delete button (armConfirm): the first click turns the button into "Delete?", the second click confirms,
// and it goes back to its icon by itself when left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { armConfirm } from '../src/ui.js';

const fakeButton = () => {
  const classes = new Set(), listeners = {};
  return {
    innerHTML: '<svg>trash</svg>', title: 'Delete',
    set textContent(v) { this.innerHTML = v; },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) },
    addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: (t) => { delete listeners[t]; },
    fire: (t) => listeners[t]?.(),
  };
};

test('first click arms, second click confirms and restores the icon', () => {
  const b = fakeButton();
  assert.equal(armConfirm(b), false);
  assert.equal(b.innerHTML, 'Delete?');
  assert.ok(b.classList.has('is-armed'));
  assert.equal(armConfirm(b), true);
  assert.equal(b.innerHTML, '<svg>trash</svg>');
  assert.ok(!b.classList.has('is-armed'));
});

test('left alone it disarms, so a later click arms again instead of deleting', async () => {
  const b = fakeButton();
  armConfirm(b);
  b.fire('mouseleave');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(b.innerHTML, '<svg>trash</svg>');
  assert.equal(armConfirm(b), false, 'arms again');
  armConfirm(b); // confirm, clears the timer
});

test('no button: never confirms', () => {
  assert.equal(armConfirm(null), false);
});
