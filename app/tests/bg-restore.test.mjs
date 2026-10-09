// Restarting inside the rotation interval still brings back the current video and sound, without rotating.
// node tests/bg-restore.test.mjs
import assert from 'node:assert/strict';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const els = [];
const mk = (tag) => {
  const el = { tag, style: {}, paused: true, attrs: {}, listeners: {}, volume: 1, muted: false,
    addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {}, removeAttribute(k) { delete this.attrs[k]; },
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {}, remove() {} };
  Object.defineProperty(el, 'src', { set(v) { el.attrs.src = v; if (tag === 'video') setTimeout(() => el.listeners.loadeddata?.(), 0); }, get() { return el.attrs.src; } });
  els.push(el);
  return el;
};
globalThis.document = { hidden: false, body: { appendChild() {} }, documentElement: { style: { setProperty() {} }, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {} }, addEventListener() {}, removeEventListener() {}, createElement: mk };
globalThis.requestAnimationFrame = (f) => f();
globalThis.window = { __TAURI__: { core: { invoke: async (cmd) => {
  calls.push(cmd);
  if (cmd === 'get_backgrounds_config') return config;
  if (cmd === 'background_media_base') return 'http://127.0.0.1:9/tok/';
  throw new Error('unexpected ' + cmd);
} } } };
const calls = [];
const config = { active_playlist: 'p', playlists: [{ id: 'p', interval: 15, sound: 'test-song.ogg', images: ['clip.mp4', 'pic.jpg', 'test-song.ogg'] }] };

const { changeBackground, applySoundSetting } = await import('../src/theme.js');
const { currentVideo, currentSound } = await import('../src/bgmedia.js');

await test('launch inside the interval: video layer and sound come back, no pick_background', async () => {
  store.rechargeBgCurrent = 'clip.mp4';
  store.rechargeBgLastChange = String(Date.now());
  assert.equal(await changeBackground('launch'), false);
  assert.ok(currentVideo());
  assert.equal(currentVideo().src, 'http://127.0.0.1:9/tok/clip.mp4');
  assert.equal(currentSound(), 'test-song.ogg');
  assert.ok(!calls.includes('pick_background'));
  assert.equal(els.filter((e) => e.tag === 'audio').length, 1);
});

await test('tick while not due leaves everything as is', async () => {
  const video = currentVideo();
  await changeBackground('tick');
  assert.equal(currentVideo(), video);
  assert.equal(els.filter((e) => e.tag === 'audio').length, 1);
});

await test('changing the Sound setting swaps the sound in place: no pick_background, same video', async () => {
  calls.length = 0;
  const video = currentVideo();
  config.playlists[0].sound = 'off';
  await applySoundSetting();
  assert.equal(currentSound(), null);
  config.playlists[0].sound = 'own';
  await applySoundSetting();
  assert.equal(currentSound(), 'own');
  config.playlists[0].sound = 'test-song.ogg';
  await applySoundSetting();
  assert.equal(currentSound(), 'test-song.ogg');
  assert.ok(!calls.includes('pick_background'));
  assert.equal(currentVideo(), video);
});

console.log(`${n} passed`);
