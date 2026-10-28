// Halloween theme music: one looping element, theme enter/leave, music pref, game pause/resume, gesture retry, playlist sound still off.
// node --test tests/halloween-music.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const els = [];
const docListeners = {};
let blockPlay = false;
const mk = (tag) => {
  const el = { tag, style: {}, paused: true, attrs: {}, volume: 1, loop: false, plays: 0, removed: false,
    addEventListener() {}, removeEventListener() {}, removeAttribute(k) { delete this.attrs[k]; },
    play() { this.plays++; if (blockPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }, load() {}, remove() { el.removed = true; } };
  Object.defineProperty(el, 'src', { set(v) { el.attrs.src = v; }, get() { return el.attrs.src; } });
  els.push(el);
  return el;
};
globalThis.document = { hidden: false, body: { appendChild() {} },
  documentElement: { style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} },
  addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
  removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); },
  getElementById: () => null, createElement: mk };
globalThis.requestAnimationFrame = (f) => f();
globalThis.fetch = async (u) => { assert.equal(u, '/assets/halloween-theme.mp3'); return { ok: true, blob: async () => ({}) }; };
let blobs = 0;
globalThis.URL.createObjectURL = () => `blob:test-${++blobs}`;
globalThis.window = { dispatchEvent() {}, __TAURI__: { core: { invoke: async (cmd) => { if (cmd === 'background_media_base') return 'http://127.0.0.1:9/tok/'; throw new Error('unexpected ' + cmd); } } } };

await import('../src/theme.js'); // registers its own theme handler (clears playlist sound)
const { setEventOn, setThemeChoice } = await import('../src/halloween.js');
const { saveAudioPrefs, getAudioPrefs, setGameRunning, setSound, currentSound } = await import('../src/bgmedia.js');
const { startHalloweenMusic, setMusicOn, _musicElement } = await import('../src/halloween-music.js');
const music = () => els.filter((e) => e.tag === 'audio' && e.attrs.src?.startsWith('blob:'));
const flush = () => new Promise((r) => setTimeout(r, 0));

// forced-on style: event on, user choice unset
const enter = () => { setThemeChoice(null); return setEventOn(true); };
const leave = () => setThemeChoice('classic');
startHalloweenMusic();
setEventOn(false);

test('entering the theme starts one looping element at the saved volume', async () => {
  saveAudioPrefs({ ...getAudioPrefs(), volume: 0.3 });
  enter();
  await flush();
  assert.equal(music().length, 1);
  const a = music()[0];
  assert.equal(a.loop, true);
  assert.equal(a.volume, 0.3);
  assert.equal(a.paused, false);
});

test('toggling the theme repeatedly never makes a second live element', async () => {
  for (let i = 0; i < 4; i++) { leave(); await flush(); enter(); await flush(); }
  assert.equal(els.filter((e) => e.tag === 'audio' && e.attrs.src && !e.removed).length, 1);
  assert.equal(music().filter((e) => !e.paused).length, 1);
});

test('leaving the theme stops and releases it', async () => {
  const a = _musicElement();
  leave();
  await flush();
  assert.equal(a.paused, true);
  assert.equal(a.removed, true);
  assert.equal(a.attrs.src, undefined);
  assert.equal(_musicElement(), null);
  enter();
});

test('game running pauses it, game exit resumes it; keepPlaying keeps it going', async () => {
  const a = _musicElement();
  assert.equal(a.paused, false);
  setGameRunning(true);
  assert.equal(a.paused, true);
  setGameRunning(false);
  assert.equal(a.paused, false);
  saveAudioPrefs({ ...getAudioPrefs(), keepPlaying: true });
  setGameRunning(true);
  assert.equal(a.paused, false);
  setGameRunning(false);
  saveAudioPrefs({ ...getAudioPrefs(), keepPlaying: false });
});

test('the music pref off pauses at once and means no playback; on resumes', async () => {
  const a = _musicElement();
  setMusicOn(false);
  assert.equal(store.rechargeHalloweenMusic, '0');
  assert.equal(a.paused, true);
  leave(); enter(); await flush();
  assert.equal(els.filter((e) => e.tag === 'audio' && !e.paused).length, 0);
  setMusicOn(true);
  assert.equal(store.rechargeHalloweenMusic, '1');
  assert.equal(_musicElement().paused, false);
});

test('a rejected play() retries once on the first gesture', async () => {
  leave();
  blockPlay = true;
  enter();
  await flush();
  const a = _musicElement();
  assert.equal(a.paused, true);
  const before = a.plays;
  assert.equal(docListeners.pointerdown?.length, 1);
  blockPlay = false;
  docListeners.pointerdown[0]();
  assert.equal(a.plays, before + 1);
  assert.equal(a.paused, false);
  assert.equal(docListeners.pointerdown.length, 0);
  assert.equal(docListeners.keydown.length, 0);
});

test('playlist sound stays suppressed under Halloween', async () => {
  setSound('test-song.ogg', 'http://127.0.0.1:9/tok/');
  saveAudioPrefs({ ...getAudioPrefs(), enabled: true });
  leave(); enter();
  await flush();
  assert.equal(currentSound(), null);
  assert.equal(els.filter((e) => e.tag === 'audio' && e.attrs.src?.includes('test-song') && !e.paused).length, 0);
});

test('the file is fetched into a blob only once for the whole session', () => {
  assert.equal(blobs, 1);
});
