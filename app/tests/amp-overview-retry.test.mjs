// The far-out overview cache when another window holds the database for good: the editor gives up on
// the blocked database after a while (saying so once), but tries again later - the other window may close.
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

test('a database blocked for good is given up on, and tried again later', async () => {
  const p = T.ovDb();
  await null; // the open is blocked
  for (let i = 0; i < 8; i++) { mock.timers.tick(2000); await null; } // every retry is blocked too
  const r = await p;
  assert.equal(r.db, undefined, 'no database while the other window holds it');
  assert.equal(r.reason, 'blocked', 'and the reason is named');
  assert.equal(T.ov().reports, 1, 'said once');
  held = false; // the other window closes
  const again = T.ovDb();
  await null;
  const r2 = await again;
  assert.ok(r2.db, 'the database opened on the later attempt');
  assert.equal(T.ov().reason, '', 'the cache is there, so nothing is reported');
});
