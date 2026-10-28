// Settings theme picker + removed controls. node --test tests/settings-theme.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.document = { documentElement: { setAttribute() {}, removeAttribute() {}, classList: { add() {} } } };
const H = await import('../src/halloween.js');
const { renderThemePicker, initThemePicker } = await import('../src/settings/theme-picker.js');

const mkCard = (kind) => { const tag = { textContent: '' }; return { dataset: { themeChoice: kind }, disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => tag, tag }; };
const cards = [mkCard('classic'), mkCard('halloween')];
const note = { hidden: true, textContent: '' };
const picker = { querySelectorAll: () => cards };
const doc = { getElementById: (id) => (id === 'theme-picker' ? picker : note) };

test('picker has two cards in the real markup', () => {
  const html = fs.readFileSync(new URL('../src/settings/view.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-theme-choice=/g) || []).length, 2);
  for (const id of ['texture-input', 'wave-enabled', 'event-toggle', 'theme-select']) assert.ok(!html.includes(`id="${id}"`), id);
});

test('Halloween card disabled when the event is off, enabled when forced', async () => {
  H.setEventOn(false);
  renderThemePicker(doc);
  assert.equal(cards[1].disabled, true);
  assert.equal(cards[1].tag.textContent, 'Event not running');
  assert.equal(cards[0].attrs['aria-checked'], 'true');
  await H.detectTestBuild(async () => ({ managedReason: 'env' }));
  renderThemePicker(doc);
  assert.equal(cards[1].disabled, false);
  assert.equal(note.textContent, 'Test build: event forced on locally.');
  assert.equal(cards[1].attrs['aria-checked'], 'true');
});

test('selecting a card sets the theme choice', () => {
  initThemePicker(doc);
  picker.onclick({ target: { closest: () => cards[0] } });
  assert.equal(H.getThemeChoice(), 'classic');
  assert.equal(cards[0].attrs['aria-checked'], 'true');
  picker.onclick({ target: { closest: () => cards[1] } });
  assert.equal(H.getThemeChoice(), 'halloween');
});

// ---- admin "Event for everyone" section ----
const { renderEventAdmin, initEventAdmin } = await import('../src/settings/event-admin.js');
const { setSession, clearSession } = await import('../src/auth.js');

const el = () => ({ hidden: false, disabled: false, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
const ids = ['event-admin', 'event-admin-status', 'event-admin-error', 'event-admin-note'];
for (const k of ['off', 'on']) ids.push(`event-card-${k}`, `event-tag-${k}`, `event-main-${k}`, `event-confirm-${k}`, `event-yes-${k}`, `event-no-${k}`);
const els = Object.fromEntries(ids.map((i) => [i, el()]));
const edoc = { getElementById: (i) => els[i] };
const hubJson = (v) => async () => ({ ok: true, status: 200, json: async () => ({ halloween2026: v }) });

test('event section markup: hidden attribute really hides, previews are cloned not duplicated', () => {
  const html = fs.readFileSync(new URL('../src/settings/view.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/settings/style.css', import.meta.url), 'utf8');
  assert.match(html, /id="event-admin" hidden/);
  assert.match(css, /\.event-admin\[hidden\][^{]*\{ display: none; \}/);
  assert.equal((html.match(/theme-preview-halloween/g) || []).length, 1);
  assert.match(css, /#theme-note \{ margin-top: 10px; \}/);
});

test('event section is hidden for non-admins and visible for admins', async () => {
  clearSession();
  initEventAdmin(edoc);
  assert.equal(els['event-admin'].hidden, true);
  setSession('tok', 'Admin', true);
  renderEventAdmin(edoc);
  assert.equal(els['event-admin'].hidden, true, 'admin who is not Flipped');
  setSession('tok', 'flipped', true);
  renderEventAdmin(edoc);
  assert.equal(els['event-admin'].hidden, true, 'lowercase lookalike');
  setSession('tok', 'Flipped', false);
  renderEventAdmin(edoc);
  assert.equal(els['event-admin'].hidden, true, 'Flipped without admin flag');
  setSession('tok', 'Flipped', true);
  await H.refreshEvent(hubJson(false));
  renderEventAdmin(edoc);
  assert.equal(els['event-admin'].hidden, false);
});

test('Live marker follows the hub state, status text too', async () => {
  initEventAdmin(edoc);
  await H.refreshEvent(hubJson(false));
  assert.equal(els['event-tag-off'].textContent, 'Live');
  assert.equal(els['event-tag-on'].textContent, '');
  assert.equal(els['event-main-off'].disabled, true);
  assert.equal(els['event-admin-status'].textContent, 'Hub: off');
  await H.refreshEvent(hubJson(true));
  assert.equal(els['event-tag-on'].textContent, 'Live');
  assert.equal(els['event-tag-off'].textContent, '');
  assert.equal(els['event-admin-status'].textContent, 'Hub: on for everyone');
  await H.refreshEvent(async () => { throw new Error('x'); });
  assert.equal(els['event-admin-status'].textContent, "Hub: can't reach it");
  assert.equal(els['event-tag-on'].textContent, '');
  assert.equal(els['event-admin-note'].hidden, !H.isForcedOn());
});

test('a 404 on GET shows the needs-update text', async () => {
  initEventAdmin(edoc);
  await H.refreshEvent(async () => ({ ok: false, status: 404 }));
  assert.equal(H.getHubEvent(), 'missing');
  assert.equal(els['event-admin-status'].textContent, "The hub doesn't have the event switch yet (needs the hub update).");
});

test('non-live card asks to confirm; Cancel does not push; Confirm pushes the right boolean', async () => {
  initEventAdmin(edoc);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (opt?.method === 'PUT') { calls.push(JSON.parse(opt.body).halloween2026); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ halloween2026: calls.at(-1) ?? false }) };
  };
  try {
    await H.refreshEvent(hubJson(false));
    els['event-main-on'].onclick();
    assert.equal(els['event-confirm-on'].hidden, false);
    assert.equal(els['event-confirm-off'].hidden, true);
    els['event-no-on'].onclick();
    assert.equal(els['event-confirm-on'].hidden, true);
    assert.deepEqual(calls, []);
    els['event-main-off'].onclick(); // live card: nothing
    assert.equal(els['event-confirm-off'].hidden, true);
    els['event-main-on'].onclick();
    const p = els['event-yes-on'].onclick();
    assert.equal(els['event-yes-on'].disabled, true); // in flight
    assert.equal(els['event-main-off'].disabled, true);
    await p;
    assert.deepEqual(calls, [true]);
    assert.equal(H.getHubEvent(), true);
    assert.equal(els['event-tag-on'].textContent, 'Live');
    assert.equal(els['event-confirm-on'].hidden, true);
    els['event-main-off'].onclick();
    await els['event-yes-off'].onclick();
    assert.deepEqual(calls, [true, false]);
    assert.equal(els['event-tag-off'].textContent, 'Live');
  } finally { globalThis.fetch = realFetch; }
});

test('a failed push shows the error inline', async () => {
  initEventAdmin(edoc);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => (opt?.method === 'PUT' ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, json: async () => ({ halloween2026: false }) });
  try {
    await H.refreshEvent(hubJson(false));
    els['event-main-on'].onclick();
    await els['event-yes-on'].onclick();
    assert.equal(els['event-admin-error'].hidden, false);
    assert.match(els['event-admin-error'].textContent, /needs the hub update/);
    assert.equal(els['event-yes-on'].disabled, false);
  } finally { globalThis.fetch = realFetch; }
});
