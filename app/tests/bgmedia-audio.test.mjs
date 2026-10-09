// Background sound: element reuse, play() retry after a blocked autoplay, prefs applying immediately.
// node tests/bgmedia-audio.test.mjs
import assert from 'node:assert/strict';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const listeners = {};
const created = [];
let blockPlay = true;
globalThis.document = {
  hidden: false,
  addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  createElement: () => {
    const a = { plays: 0, paused: true, volume: 1, attrs: {}, addEventListener() {},
      play() { this.plays++; if (blockPlay) return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; }, load() {}, removeAttribute(k) { delete this.attrs[k]; } };
    Object.defineProperty(a, 'src', { set(v) { a.attrs.src = v; }, get() { return a.attrs.src; } });
    created.push(a);
    return a;
  },
};
const warns = [];
console.warn = (...a) => warns.push(a.join(' '));

const { setSound, saveAudioPrefs, getAudioPrefs, mediaUrl } = await import('../src/bgmedia.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

await test('sound stays silent until the speaker is on, then plays at once', async () => {
  blockPlay = false;
  setSound('test-song.ogg', 'http://127.0.0.1:1/tok/');
  assert.equal(created.length, 1);
  assert.equal(created[0].src, 'http://127.0.0.1:1/tok/test-song.ogg');
  assert.equal(created[0].plays, 0);
  saveAudioPrefs({ ...getAudioPrefs(), enabled: true, volume: 0.7 });
  await flush();
  assert.equal(created[0].plays, 1);
  assert.equal(created[0].volume, 0.7);
  assert.equal(created[0].paused, false);
});

await test('rotating to another track reuses the same element; same track is left alone', async () => {
  setSound('test-song.ogg', 'http://127.0.0.1:1/tok/');
  assert.equal(created.length, 1);
  setSound('other.mp3', 'http://127.0.0.1:1/tok/');
  assert.equal(created.length, 1);
  assert.equal(created[0].src, mediaUrl('http://127.0.0.1:1/tok/', 'other.mp3'));
  setSound(null);
  assert.equal(created[0].paused, true);
  assert.equal(created[0].src, undefined);
});

await test('a blocked play() is logged and retried on the next user gesture', async () => {
  blockPlay = true;
  warns.length = 0;
  setSound('test-song.ogg', 'http://127.0.0.1:1/tok/');
  await flush();
  assert.ok(warns.some((w) => /audio play\(\) failed: NotAllowedError/.test(w)), warns.join('|'));
  assert.equal(listeners.pointerdown?.length, 1);
  blockPlay = false;
  const before = created[0].plays;
  listeners.pointerdown[0]();
  await flush();
  assert.equal(created[0].plays, before + 1);
  assert.equal(created[0].paused, false);
  assert.equal(listeners.pointerdown.length, 0);
});

console.log(`${n} passed`);
