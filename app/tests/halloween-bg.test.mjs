// Halloweencharge 2026: theme.js suspends the background playlist while the theme is on, and leaves the user's settings alone.
// node --test tests/halloween-bg.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const els = [];
const mk = (tag) => {
  const el = { tag, style: {}, paused: true, attrs: {}, listeners: {}, volume: 1, muted: false,
    addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {}, removeAttribute(k) { delete this.attrs[k]; },
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {}, remove() { el.removed = true; } };
  Object.defineProperty(el, 'src', { set(v) { el.attrs.src = v; if (tag === 'video') setTimeout(() => el.listeners.loadeddata?.(), 0); }, get() { return el.attrs.src; } });
  els.push(el);
  return el;
};
const classes = new Set(), attrs = {}, props = {};
globalThis.document = { hidden: false, body: { appendChild() {} },
  documentElement: { style: { setProperty: (k, v) => { props[k] = v; } },
    classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } },
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, createElement: mk };
globalThis.requestAnimationFrame = (f) => f();
const calls = [];
const config = { active_playlist: 'p', playlists: [{ id: 'p', interval: 15, sound: 'test-song.ogg', images: ['clip.mp4', 'pic.jpg', 'test-song.ogg'] }] };
globalThis.window = { dispatchEvent() {}, __TAURI__: { core: { invoke: async (cmd) => {
  calls.push(cmd);
  if (cmd === 'get_backgrounds_config') return config;
  if (cmd === 'background_media_base') return 'http://127.0.0.1:9/tok/';
  if (cmd === 'pick_background') return { kind: 'image', file: 'pic.jpg', data_url: 'data:image/png;base64,AAAA' };
  throw new Error('unexpected ' + cmd);
} } } };

const { changeBackground, applySoundSetting } = await import('../src/theme.js');
const { setEventOn } = await import('../src/halloween.js');
const { currentVideo, currentSound } = await import('../src/bgmedia.js');
const picks = () => calls.filter((c) => c === 'pick_background').length;
const userKeys = () => JSON.stringify({ t: store.rechargeBgTexture, c: store.rechargeBgCurrent, l: store.rechargeBgLastChange });

store.rechargeBgTexture = 'data:image/png;base64,USERTEX';
store.rechargeBgCurrent = 'clip.mp4';
store.rechargeBgLastChange = String(Date.now()); // recent: nothing is due
setEventOn(false); // the first apply fires the exit handler's tick; let it finish before the tests
await new Promise((r) => setTimeout(r, 50));
calls.length = 0;
const before = userKeys();

test('classic: the current video and sound are restored as usual', async () => {
  assert.equal(await changeBackground('launch'), false);
  assert.ok(currentVideo());
  assert.equal(currentSound(), 'test-song.ogg');
  assert.equal(picks(), 0);
  assert.ok(classes.has('has-bg'));
});

test('entering halloween clears video and sound and keeps has-bg', async () => {
  classes.delete('has-bg');
  setEventOn(true);
  assert.equal(attrs['data-theme'], 'halloween');
  assert.equal(currentVideo(), null);
  assert.equal(currentSound(), null);
  assert.ok(classes.has('has-bg'));
});

test('halloween: changeBackground never picks and returns false', async () => {
  calls.length = 0;
  for (const mode of ['force', 'launch', 'tick']) {
    store.rechargeBgLastChange = '0'; // long overdue
    assert.equal(await changeBackground(mode), false, mode);
  }
  assert.equal(picks(), 0);
  assert.ok(!calls.includes('get_backgrounds_config'));
  assert.ok(classes.has('has-bg'));
  store.rechargeBgLastChange = before ? JSON.parse(before).l : '';
});

test('halloween: applySoundSetting leaves media alone', async () => {
  calls.length = 0;
  await applySoundSetting();
  assert.equal(currentVideo(), null);
  assert.equal(currentSound(), null);
  assert.deepEqual(calls, []);
});

test('halloween: the playlist is suspended without touching it (restore path)', async () => {
  // restoreCurrent is only reachable through changeBackground, which returns early; no media is brought back
  await changeBackground('launch');
  assert.equal(currentVideo(), null);
  assert.equal(currentSound(), null);
});

test('leaving halloween restores has-bg from rechargeBgCurrent and ticks the playlist', async () => {
  calls.length = 0;
  setEventOn(false);
  assert.equal(attrs['data-theme'], undefined);
  assert.ok(classes.has('has-bg'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.includes('get_backgrounds_config'), 'changeBackground(tick) ran');
  assert.equal(picks(), 0, 'not due, so no rotation');
  assert.ok(currentVideo(), 'current video is back');
  assert.equal(currentSound(), 'test-song.ogg');
});

test('leaving with no current item clears has-bg', async () => {
  setEventOn(true);
  const saved = store.rechargeBgCurrent;
  delete store.rechargeBgCurrent;
  config.active_playlist = 'none'; // tick then finds no playlist and also clears it
  setEventOn(false);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!classes.has('has-bg'));
  config.active_playlist = 'p';
  store.rechargeBgCurrent = saved;
});

test('texture / playlist keys are unchanged across an enter/leave cycle', async () => {
  setEventOn(true);
  await changeBackground('force');
  setEventOn(false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(userKeys(), before);
  assert.equal(props['--bg-image'], undefined, 'no inline background override either');
});
