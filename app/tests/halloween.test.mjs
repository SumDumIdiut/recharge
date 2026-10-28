// Halloweencharge 2026: theme decision table, event fetch/cache, early paint script, admin-only event switch.
// node --test tests/halloween.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const attrs = {}, classes = new Set();
globalThis.document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, classList: { add: (c) => classes.add(c) } } };
const H = await import('../src/halloween.js');
const { setSession, clearSession, isAdmin } = await import('../src/auth.js');
const reset = () => { for (const k of Object.keys(store)) delete store[k]; for (const k of Object.keys(attrs)) delete attrs[k]; classes.clear(); };

for (const eventOn of [false, true]) for (const choice of [null, 'classic', 'halloween']) {
  test(`decision event=${eventOn} choice=${choice}`, () => {
    const want = eventOn && choice !== 'classic' ? 'halloween' : 'classic';
    assert.equal(H.effectiveTheme(eventOn, choice), want);
    reset();
    if (choice) store.rechargeTheme = choice;
    H.setEventOn(eventOn);
    assert.equal(H.currentTheme(), want);
    assert.equal(attrs['data-theme'], want === 'halloween' ? 'halloween' : undefined);
  });
}

test('choice is kept while the event is off, and comes back with it', () => {
  reset();
  H.setThemeChoice('halloween');
  H.setEventOn(false);
  assert.equal(H.getThemeChoice(), 'halloween');
  assert.equal(attrs['data-theme'], undefined);
  H.setEventOn(true);
  assert.equal(attrs['data-theme'], 'halloween');
});

test('listeners hear about a change, not about a repeat', () => {
  reset();
  H.setEventOn(false);
  const seen = [];
  const off = H.onThemeChange((t) => seen.push(t));
  H.setEventOn(true); H.setEventOn(true); H.setThemeChoice('classic');
  off();
  assert.deepEqual(seen, ['halloween', 'classic']);
});

test('refreshEvent caches the hub answer and keeps it when offline', async () => {
  reset();
  const ok = (v) => async () => ({ ok: true, json: async () => ({ halloween2026: v }) });
  assert.equal(await H.refreshEvent(ok(true)), true);
  assert.equal(store.rechargeEvent, '1');
  assert.equal(await H.refreshEvent(async () => { throw new Error('offline'); }), true);
  assert.equal(await H.refreshEvent(async () => ({ ok: false, status: 500 })), true);
  assert.equal(await H.refreshEvent(ok(false)), false);
  assert.equal(store.rechargeEvent, '0');
});

test('pushEvent sends the bearer token, refreshes, and surfaces a 403', async () => {
  reset();
  setSession('tok', 'someone', false);
  const calls = [];
  const fetchFn = async (url, opt = {}) => {
    calls.push([url, opt.method || 'GET', opt.headers?.Authorization, opt.body]);
    if (opt.method === 'PUT') return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ halloween2026: true }) };
  };
  assert.equal(await H.pushEvent(true, fetchFn), true);
  assert.match(calls[0][0], /\/api\/admin\/event$/);
  assert.deepEqual(calls[0].slice(1), ['PUT', 'Bearer tok', '{"halloween2026":true}']);
  assert.match(calls[1][0], /\/api\/event$/);
  await assert.rejects(H.pushEvent(false, async () => ({ ok: false, status: 403, json: async () => ({}) })), /Only admins/);
  await assert.rejects(H.pushEvent(false, async () => ({ ok: false, status: 403, json: async () => ({ error: 'nope' }) })), /nope/);
});

// The inline script in index.html runs before first paint; run the real text against fake storage.
function earlyPaint(local) {
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const a = {}, c = new Set(), props = {};
  const ctx = {
    localStorage: { getItem: (k) => local[k] ?? null, removeItem() {} },
    document: { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } }, setAttribute: (k, v) => { a[k] = v; }, classList: { add: (x) => c.add(x) } } },
  };
  vm.runInNewContext(code, ctx);
  return { a, c, props };
}
for (const eventOn of [false, true]) for (const choice of [null, 'classic', 'halloween']) {
  test(`early paint event=${eventOn} choice=${choice} matches effectiveTheme`, () => {
    const local = {};
    if (eventOn) local.rechargeEvent = '1';
    if (choice) local.rechargeTheme = choice;
    local.rechargeBgTexture = 'data:x';
    const { a, c, props } = earlyPaint(local);
    const on = H.effectiveTheme(eventOn, choice) === 'halloween';
    assert.equal(a['data-theme'], on ? 'halloween' : undefined);
    assert.equal(c.has('has-bg'), on);
    assert.equal(props['--bg-image'], 'url("data:x")'); // the user's texture is still set; CSS overrides it
  });
}
test('early paint survives unavailable storage', () => {
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(code, { localStorage: { getItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }, document: {} });
});

test('the admin event switch no longer lives in Settings; isAdmin follows the session', () => {
  const view = fs.readFileSync(new URL('../src/settings/view.html', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /event-admin-row|event-toggle/);
  clearSession();
  assert.equal(isAdmin(), false);
  setSession('t', 'u', false);
  assert.equal(isAdmin(), false);
  setSession('t', 'Flipped', true);
  assert.equal(isAdmin(), true);
});

// Test build: live_status managed_reason 'env' forces the event on locally, without ever storing it.
test('detectTestBuild: only managed_reason env forces on', async () => {
  for (const [reason, want] of [['launcher', false], ['none', false]]) {
    reset();
    assert.equal(await H.detectTestBuild(async () => ({ managedReason: reason })), want);
    assert.equal(H.getEventOn(), false);
  }
  reset();
  assert.equal(await H.detectTestBuild(async () => { throw new Error('no tauri'); }), false);
  assert.equal(await H.detectTestBuild(undefined), false);
  assert.equal(H.getEventOn(), false);
  assert.equal(await H.detectTestBuild(async () => ({ managedReason: 'env' })), true);
  assert.equal(H.getEventOn(), true);
  assert.equal(attrs['data-theme'], 'halloween');
});

test('forced on never writes rechargeEvent, even when the hub says off; Classic choice still wins', async () => {
  // forcedOn is now set from the previous test
  reset();
  await H.refreshEvent(async () => ({ ok: true, json: async () => ({ halloween2026: false }) }));
  assert.equal(store.rechargeEvent, undefined);
  assert.equal(H.getEventOn(), true);
  assert.equal(H.currentTheme(), 'halloween');
  H.setThemeChoice('classic');
  assert.equal(H.currentTheme(), 'classic');
  assert.equal(attrs['data-theme'], undefined);
  assert.equal(store.rechargeEvent, undefined);
});

test('test build: local override gives classic / halloween, session only', async () => {
  reset();
  const ss = {};
  globalThis.sessionStorage = { getItem: (k) => ss[k] ?? null, setItem: (k, v) => { ss[k] = String(v); }, removeItem: (k) => { delete ss[k]; } };
  await H.detectTestBuild(async () => ({ managedReason: 'env' }));
  assert.equal(H.isForcedOn(), true);
  assert.equal(H.getEventOn(), true);
  H.setLocalEvent(false);
  assert.equal(H.currentTheme(), 'classic');
  assert.equal(attrs['data-theme'], undefined);
  H.setLocalEvent(true);
  assert.equal(H.currentTheme(), 'halloween');
  assert.equal(attrs['data-theme'], 'halloween');
  assert.equal(ss.rechargeEventLocal, '1');
  assert.deepEqual(Object.keys(store).filter((k) => /event/i.test(k)), []);
});

test('pushEvent 404 explains the hub lacks the switch', async () => {
  await assert.rejects(H.pushEvent(true, async () => ({ ok: false, status: 404, json: async () => ({}) })),
    /The hub doesn't have the event switch yet \(needs the hub update\)\./);
});

test('hubEventState: true/false, 404 is missing, errors are null; updates while forced without touching localStorage', async () => {
  reset();
  await H.detectTestBuild(async () => ({ managedReason: 'env' }));
  assert.equal(H.isForcedOn(), true);
  const json = (v) => async () => ({ ok: true, status: 200, json: async () => ({ halloween2026: v }) });
  await H.refreshEvent(json(false));
  assert.equal(H.getHubEvent(), false);
  await H.refreshEvent(json(true));
  assert.equal(H.getHubEvent(), true);
  await H.refreshEvent(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(H.getHubEvent(), 'missing');
  await H.refreshEvent(json(true));
  await H.refreshEvent(async () => { throw new Error('offline'); });
  assert.equal(H.getHubEvent(), null);
  await H.refreshEvent(json(true));
  await H.refreshEvent(async () => ({ ok: false, status: 500 }));
  assert.equal(H.getHubEvent(), null);
  assert.equal(store.rechargeEvent, undefined);
  assert.equal(H.getEventOn(), true);
});
