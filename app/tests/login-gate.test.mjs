// Upload buttons always show; logged-out clicks explain why. Stale tokens are cleared on a 401.
// node tests/login-gate.test.mjs
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const events = [];
class El {
  constructor() { this.children = []; this.listeners = {}; this.className = ''; this._html = ''; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  remove() { this.removed = true; }
  addEventListener(t, f) { this.listeners[t] = f; }
  querySelector(sel) { const k = sel.match(/data-act="(\w+)"/)[1]; return (this.btns ??= {})[k] ??= new El(); }
}
const body = new El();
globalThis.document = { body, createElement: () => new El() };
globalThis.window = { dispatchEvent: (e) => events.push(e), navigate: (t) => events.push(['navigate', t]) };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

const auth = await import('../src/auth.js');
const { requireLogin, openAccount } = await import('../src/login-prompt.js');

// logged out: gate says no and shows the prompt with the right text and an Open Account button
assert.equal(requireLogin('a mod'), false);
const overlay = body.children[0];
assert.match(overlay.innerHTML, /Log in to upload a mod/);
assert.match(overlay.innerHTML, /Open Account/);
// Open Account opens the login dialog (home.js hook) when present
let opened = 0;
window.__homeAccountBadgeClick = () => { opened++; };
overlay.btns['open'].listeners.click();
assert.equal(opened, 1);
assert.ok(overlay.removed);
// without the hook it falls back to the Account tab
delete window.__homeAccountBadgeClick;
openAccount();
assert.deepEqual(events.pop(), ['navigate', 'account']);

// logged in: no prompt
auth.setSession('tok', 'bob', false);
body.children.length = 0;
assert.equal(requireLogin('a skin'), true);
assert.equal(body.children.length, 0);

// startup validation: network error keeps the session, 200 refreshes, 401 clears + flags + announces
assert.equal(await auth.refreshSession(async () => { throw new Error('offline'); }), 'unchecked');
assert.equal(auth.isLoggedIn(), true);
let seen;
assert.equal(await auth.refreshSession(async (url, init) => { seen = [url, init.headers.Authorization]; return { ok: true, status: 200, json: async () => ({ username: 'bob', admin: true }) }; }), 'ok');
assert.deepEqual(seen, ['https://codecade.co.za/recharge/api/me', 'Bearer tok']);
assert.equal(auth.isAdmin(), true);
assert.equal(await auth.refreshSession(async () => ({ ok: false, status: 401 })), 'expired');
assert.equal(auth.isLoggedIn(), false);
assert.equal(auth.sessionExpired(), true);
assert.equal(events.at(-1).type, 'session-expired');
assert.match(events.at(-1).detail, /login expired/);
auth.clearExpiredNote();
assert.equal(auth.sessionExpired(), false);
assert.equal(await auth.refreshSession(), 'none', 'no token: nothing to validate');
console.log('login-gate: all checks passed');
