// The far-out overview cache when another window holds the database: the open is blocked, and it is
// tried again once that window closes (instead of giving up on the cache for the session).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

mock.timers.enable({ apis: ['setTimeout'] });
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };

// A database another window holds open: the open is blocked until that window closes.
let held = true;
globalThis.indexedDB = {
  open: () => {
    const r = { result: { close() {} } };
    queueMicrotask(() => { if (held) r.onblocked?.(); else r.onsuccess?.(); });
    return r;
  },
};

const { __test: T } = await import('../src/maps/editor.js');

test('a blocked database is tried again, and opens when the other window closes', async () => {
  const p = T.ovDb();
  await null; // the open is blocked
  assert.equal(T.ov().reason, '', 'not given up on yet');
  held = false; // the other window closes
  mock.timers.tick(2000); // the retry
  await null;
  const r = await p;
  assert.ok(r.db, 'the database opened on the retry');
  assert.equal(T.ov().reason, '', 'the cache is available, so nothing is reported');
});
