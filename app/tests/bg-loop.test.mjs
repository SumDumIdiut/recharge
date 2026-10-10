// The background <video>/<audio> must never use the native `loop`: on WebKitGTK a looping 60 s+ 1080p AV1 clip made the
// next pause()/load() (Activate on another playlist) block the whole page for ~35 s. They loop by hand from 'ended'.
// node tests/bg-loop.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const els = [];
const mk = (tag) => {
  const el = { tag, style: {}, paused: true, attrs: {}, listeners: {}, volume: 1, muted: false, loop: undefined, currentTime: 12, plays: 0,
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener() {}, removeAttribute(k) { delete this.attrs[k]; },
    play() { this.paused = false; this.plays++; return Promise.resolve(); }, pause() { this.paused = true; }, load() {}, remove() {} };
  Object.defineProperty(el, 'src', { set(v) { el.attrs.src = v; if (tag === 'video') setTimeout(() => el.listeners.loadeddata?.forEach((f) => f()), 0); }, get() { return el.attrs.src; } });
  els.push(el);
  return el;
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { hidden: false, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {}, createElement: mk };
globalThis.requestAnimationFrame = (f) => f();
globalThis.window = {};

const { showVideo, setSound, currentVideo } = await import('../src/bgmedia.js');

await test('background video: no native loop, restarts itself on ended', async () => {
  const v = await showVideo('http://127.0.0.1:9/tok/clip.mp4');
  assert.equal(v, currentVideo());
  assert.equal(v.loop, false);
  const before = v.plays;
  v.listeners.ended.forEach((f) => f());
  assert.equal(v.currentTime, 0);
  assert.equal(v.plays, before + 1);
});

await test('background audio: no native loop, restarts itself on ended', async () => {
  setSound('song.ogg', 'http://127.0.0.1:9/tok/');
  const a = els.find((e) => e.tag === 'audio');
  assert.ok(a);
  assert.equal(a.loop, false);
  a.listeners.ended.forEach((f) => f());
  assert.equal(a.currentTime, 0);
});

await test('source guard: bgmedia.js never sets loop = true', async () => {
  const src = readFileSync(new URL('../src/bgmedia.js', import.meta.url), 'utf8');
  assert.ok(!/\.loop\s*=\s*true/.test(src));
});

await test('source guard: no native loop anywhere in the media code', async () => {
  for (const f of ['../src/bgmedia.js', '../src/backgrounds/community.js', '../src/backgrounds/thumbs.js', '../src/backgrounds/media.js', '../src/backgrounds/script.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/\.loop\s*=\s*true/.test(src), f + ' sets loop = true');
    assert.ok(!/<(video|audio)[^>]*\sloop[\s>]/.test(src), f + ' has a loop attribute');
  }
  assert.ok(!/crossOrigin/.test(readFileSync(new URL('../src/bgmedia.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')));
});

console.log(`${n} passed`);
