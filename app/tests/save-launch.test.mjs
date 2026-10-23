import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };
globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('404'); } });

const { __test: T } = await import('../src/maps/editor.js');
const ec = T.errorCode;

assert.equal(ec('unsupported: no command'), 'unsupported');
assert.equal(ec('io: disk full'), 'io');
assert.equal(ec('unknown command: save_map'), 'unsupported');
assert.equal(ec('not found'), 'unsupported');
assert.equal(ec('{"code":"navigator_missing"}'), 'navigator_missing');
assert.equal(ec('too_large: big'), 'too_large');
assert.equal(ec('random error'), '');

console.log('ok - save-launch errorCode');
