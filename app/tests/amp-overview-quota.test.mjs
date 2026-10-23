// The far-out overview cache when the origin's storage is full: the reason says so (quota, not a
// broken database), because a full disk is the author's problem to fix, not a silent slow open.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };

const { __test: T } = await import('../src/maps/editor.js');

test('a full storage is told apart from a broken one', () => {
  assert.equal(T.ovReason({ name: 'QuotaExceededError' }), 'quota', 'the storage is full');
  assert.equal(T.ovReason({ name: 'QuotaExceededError', message: 'The quota has been exceeded.' }), 'quota');
  assert.equal(T.ovReason(new Error('out of quota')), 'quota', 'and the message counts too');
  assert.equal(T.ovReason({ name: 'InvalidStateError', message: 'the store is gone' }), 'io', 'anything else is a plain error');
  assert.equal(T.ovReason(null), 'io');
});
