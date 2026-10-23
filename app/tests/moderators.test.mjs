import test from 'node:test';
import assert from 'node:assert/strict';

function makeEl() {
  const node = {
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    focus() {},
    remove() {},
    value: '',
    textContent: '',
    innerHTML: '',
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    children: [],
  };
  Object.defineProperty(node, 'allText', {
    get() { return this.children.map((c) => c.textContent || c.allText || '').join(' '); },
  });
  return node;
}

const listeners = { document: [], window: [] };
globalThis.window = { addEventListener(t, fn) { listeners.window.push([t, fn]); }, location: { href: '' }, navigate() {}, __TAURI__: {} };
globalThis.localStorage = { _s: new Map(), getItem(k) { return this._s.get(k) ?? null; }, setItem(k, v) { this._s.set(k, String(v)); }, removeItem(k) { this._s.delete(k); } };
const doc = {
  hidden: false,
  addEventListener(t, fn) { listeners.document.push([t, fn]); },
  getElementById: () => null,
  createElement: makeEl,
  body: makeEl(),
};
globalThis.document = doc;

globalThis.localStorage.setItem('rechargeAuthModerator', '1');
globalThis.localStorage.setItem('rechargeAuthUsername', 'mod');

let chatStatus = 200;
let chatMessages = [];
let chatCalls = 0;
let retryAfter = 5;
let networkFail = false;

globalThis.fetch = async (url) => {
  if (networkFail && String(url).includes('/api/moderator/chat')) throw new Error('network down');
  if (String(url).includes('/api/moderator/chat')) {
    chatCalls++;
    if (chatStatus !== 200) {
      const body = chatStatus === 429
        ? { error: 'Slow down', retry_after: retryAfter }
        : { error: chatStatus === 403 ? 'moderators only' : 'nope' };
      return { ok: false, status: chatStatus, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ messages: chatMessages }) };
  }
  if (String(url).includes('/api/me')) {
    return { ok: true, status: 200, json: async () => ({ username: 'mod', name_color: '', moderator: true }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const mod = await import('../src/moderators/script.js');
const { room, open, close, pull, retry, POLL_MS, IDLE_MS, MAX_FAILURES } = mod;

function reset() {
  try { close(); } catch {}
  room.lastId = 0;
  room.seq = 0;
  room.failures = 0;
  room.emptyPolls = 0;
  room.delay = POLL_MS;
  room.stopped = false;
  room.paused = false;
  room.listeners = false;
  room.log = makeEl();
  room.form = null;
  room.input = { value: '' };
  chatStatus = 200;
  chatMessages = [];
  chatCalls = 0;
  networkFail = false;
  doc.hidden = false;
  if (room.timer) { clearTimeout(room.timer); room.timer = 0; }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('403 closes the room and reports access removed', async () => {
  reset();
  chatStatus = 403;
  open();
  await wait(40);
  assert.equal(room.open, false);
  assert.match(room.log.allText, /access removed/);
});

test('401 closes the room and asks to sign in', async () => {
  reset();
  chatStatus = 401;
  open();
  await wait(40);
  assert.equal(room.open, false);
  assert.match(room.log.allText, /sign in/);
});

test('429 backs off by retryAfter without closing', async () => {
  reset();
  retryAfter = 7;
  chatStatus = 429;
  open();
  await wait(40);
  assert.equal(room.open, true);
  assert.ok(room.delay >= 7000, `delay ${room.delay}`);
});

test('network failure backs off and a later success clears it', async () => {
  reset();
  networkFail = true;
  open();
  await wait(40);
  assert.equal(room.open, true);
  assert.ok(room.delay > POLL_MS);
  const before = room.failures;
  assert.ok(before >= 1);
  networkFail = false;
  chatStatus = 200;
  chatMessages = [{ id: 1, body: 'hi', author: { username: 'mod' } }];
  await pull();
  assert.equal(room.failures, 0);
  assert.equal(room.delay, POLL_MS);
  assert.equal(room.lastId, 1);
});

test('ten consecutive failures stop polling', async () => {
  reset();
  networkFail = true;
  room.open = true;
  room.log = makeEl();
  for (let i = 0; i < 10; i++) await pull();
  assert.equal(room.stopped, true);
  assert.equal(room.open, true);
  assert.match(room.log.allText, /Retry/);
});

test('idle backoff engages after three empty polls', async () => {
  reset();
  open();
  await wait(40); // first poll empty
  // force two more empty polls
  await pull();
  await pull();
  assert.ok(room.emptyPolls >= 3);
  assert.equal(room.delay, IDLE_MS);
});

test('hidden pauses and showing performs one catch-up poll', async () => {
  reset();
  open();
  await wait(40);
  const before = chatCalls;
  doc.hidden = true;
  const vis = listeners.document.find(([t]) => t === 'visibilitychange')[1];
  vis();
  await wait(40);
  assert.equal(chatCalls, before); // no requests while hidden
  doc.hidden = false;
  vis();
  await wait(40);
  assert.equal(chatCalls, before + 1); // exactly one catch-up
});

test('pagehide clears the timer', async () => {
  reset();
  open();
  await wait(10);
  const ph = listeners.window.find(([t]) => t === 'pagehide')[1];
  ph();
  assert.equal(room.timer, 0);
});

test('retry resumes after stop', async () => {
  reset();
  networkFail = true;
  room.open = true;
  room.log = makeEl();
  for (let i = 0; i < 10; i++) await pull();
  assert.equal(room.stopped, true);
  networkFail = false;
  retry();
  assert.equal(room.stopped, false);
  await wait(40);
  assert.ok(chatCalls >= 1);
});
