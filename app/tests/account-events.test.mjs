// Account page Events card: admin-only, hidden for everyone else. node --test tests/account-events.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.document = { documentElement: { setAttribute() {}, removeAttribute() {}, classList: { add() {} } } };
const { setSession, clearSession } = await import('../src/auth.js');
const { renderEventsCard, toggleEvent } = await import('../src/account/events-card.js');
const H = await import('../src/halloween.js');

const els = {};
for (const id of ['account-events', 'account-events-state', 'account-events-toggle', 'account-events-status', 'account-events-error'])
  els[id] = { hidden: false, textContent: '', disabled: false };
const doc = { getElementById: (id) => els[id] };

test('card is hidden for a non-admin', () => {
  setSession('t', 'someone', false);
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, true);
  setSession('t', 'Admin', true);
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, true, 'admin who is not Flipped');
  setSession('t', 'flipped', true);
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, true, 'lowercase lookalike');
});

test('card shows for an admin; in the test build the toggle is local only', async () => {
  setSession('t', 'Flipped', true);
  globalThis.fetch = () => { throw new Error('hub must not be called'); };
  await H.detectTestBuild(async () => ({ managedReason: 'env' }));
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, false);
  assert.equal(els['account-events-state'].textContent, 'On');
  assert.equal(els['account-events-status'].textContent, 'Test build: local only');
  await toggleEvent(doc);
  assert.equal(els['account-events-state'].textContent, 'Off');
  assert.equal(els['account-events-toggle'].textContent, 'Turn on');
  assert.equal(H.currentTheme(), 'classic');
  await toggleEvent(doc);
  assert.equal(H.currentTheme(), 'halloween');
  assert.equal(els['account-events-error'].hidden, true);
  clearSession();
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, true);
  setSession('t', 'Admin', true);
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, true, 'admin who is not Flipped');
  setSession('t', 'flipped', true);
  renderEventsCard(doc);
  assert.equal(els['account-events'].hidden, true, 'lowercase lookalike');
});
