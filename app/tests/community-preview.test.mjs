// Community preview: videos are real muted looping <video> elements (never <img>), sounds get a play button,
// and closing the box releases every video and stops the sound.
import { releaseMedia } from '../src/releasemedia.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewTilesHtml, startPreview, galleryMedia, MAX_PREVIEW_VIDEOS, playlistCardsHtml, placeholderThumb } from '../src/backgrounds/community.js';

const row = { id: 'p1', gallery: ['a.png', 'clip one.mp4', 'b.webm', 'song.mp3', 'notes.txt'] };

test('preview html: images as <img>, videos as <video>, sounds as a button; videos never in <img> or background-image', () => {
  const html = previewTilesHtml(row);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /<img [^>]*a\.png/);
  assert.equal((html.match(/<video /g) || []).length, 2);
  assert.ok(/muted playsinline/.test(html));
  assert.ok(!/<img[^>]*\.(mp4|webm|mp3)/.test(html));
  assert.ok(!/background-image/.test(html));
  assert.match(html, /data-audio="[^"]*song\.mp3"/);
  assert.match(html, /gallery\/clip%20one\.mp4/);
  assert.ok(!/notes\.txt/.test(html));
  assert.deepEqual(galleryMedia(row.gallery).map((m) => m.kind), ['image', 'video', 'video', 'audio']);
});

function fakeEl(attrs = {}) {
  const el = { dataset: attrs, attrs: { ...(attrs.skip ? { 'data-skip': '' } : {}) }, paused: true, playCalls: 0, loads: 0, classes: new Set(),
    removed: false, remove() { this.removed = true; }, hasAttribute(a) { return a in this.attrs; }, removeAttribute(a) { if (a === 'src') this.src = undefined; },
    play() { this.paused = false; this.playCalls++; return Promise.resolve(); }, pause() { this.paused = true; }, load() { this.loads++; },
    classList: { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c) } };
  return el;
}
function fakeGrid(videos, buttons) {
  return { innerHTML: 'filled', querySelectorAll: (sel) => (sel.startsWith('video') ? videos : buttons) };
}


const tick = () => new Promise((r) => setTimeout(r, 5));
// fake network: every fetch resolves to a blob "blob:<url>" unless held back by hold()
function fakeEnv() {
  const env = { fetched: [], revoked: [], aborted: 0, holds: new Map() };
  env.fetchFn = (url, { signal }) => {
    env.fetched.push(url);
    const done = () => ({ ok: true, headers: { get: () => '100' }, blob: async () => ({ url }) });
    const gate = env.holds.get(url);
    if (!gate) return Promise.resolve(done());
    return new Promise((res, rej) => { signal.addEventListener('abort', () => { env.aborted++; rej(new Error('abort')); }); gate.release = () => res(done()); });
  };
  env.createUrl = (b) => `blob:${b.url}`;
  env.revokeUrl = (u) => env.revoked.push(u);
  return env;
}

test('startPreview downloads each video into a blob (never a network src), then plays it muted + looping', async () => {
  const vids = [fakeEl({ src: 'u1' }), fakeEl({ src: 'u2' })];
  const env = fakeEnv();
  startPreview(fakeGrid(vids, []), undefined, env);
  await tick();
  assert.deepEqual(env.fetched, ['u1', 'u2']);
  for (const v of vids) { assert.equal(v.muted, true); assert.equal(v.loop, false); assert.equal(v.paused, false); assert.match(v.src, /^blob:/); }
});

test('release() never calls load() on a video that is still loading from the network, and aborts the download', async () => {
  const vids = [fakeEl({ src: 'slow' })];
  const env = fakeEnv();
  env.holds.set('slow', {});
  const grid = fakeGrid(vids, []);
  const p = startPreview(grid, undefined, env);
  await tick();
  vids[0].networkState = 2; // NETWORK_LOADING
  p.release();
  await tick();
  assert.equal(env.aborted, 1);
  assert.equal(vids[0].loads, 0);
  assert.equal(vids[0].playCalls, 0);
  assert.equal(grid.innerHTML, '');
});

test('release() of a playing blob video: paused, detached, source dropped, blob urls revoked', async () => {
  const vids = [fakeEl({ src: 'u1' })];
  const env = fakeEnv();
  const grid = fakeGrid(vids, []);
  const p = startPreview(grid, undefined, env);
  await tick();
  vids[0].networkState = 1;
  p.release();
  assert.equal(vids[0].paused, true); assert.equal(vids[0].src, undefined); assert.equal(vids[0].loads, 1); assert.equal(vids[0].removed, true);
  assert.deepEqual(env.revoked, ['blob:u1']);
  assert.equal(grid.innerHTML, '');
});

test('releaseMedia defers load() until a still-loading element has settled, and gives up without ever blocking', () => {
  const timers = [];
  const el = fakeEl({});
  el.networkState = 2;
  releaseMedia(el, { setTimer: (f) => timers.push(f) });
  assert.equal(el.paused, true); assert.equal(el.removed, true); assert.equal(el.loads, 0);
  timers.shift()(); assert.equal(el.loads, 0); // still loading
  el.networkState = 1;
  timers.shift()(); assert.equal(el.loads, 1);
  const stuck = fakeEl({}); stuck.networkState = 2;
  let n = 0; const q = [];
  releaseMedia(stuck, { setTimer: (f) => q.push(f) });
  while (q.length && n++ < 1000) q.shift()();
  assert.equal(stuck.loads, 0); assert.ok(n < 1000);
});

test('videos beyond the cap are never downloaded', async () => {
  const vids = Array.from({ length: MAX_PREVIEW_VIDEOS + 3 }, (_, i) => fakeEl({ src: `u${i}`, skip: i >= MAX_PREVIEW_VIDEOS }));
  const env = fakeEnv();
  startPreview(fakeGrid(vids, []), undefined, env);
  await tick();
  assert.equal(env.fetched.length, MAX_PREVIEW_VIDEOS);
  assert.equal(vids.filter((v) => v.playCalls).length, MAX_PREVIEW_VIDEOS);
});

test('sound button: downloads then plays, one sound at a time; release() stops it without load()', async () => {
  const sounds = [];
  const mk = () => { const a = fakeEl({}); sounds.push(a); return a; };
  const b1 = fakeEl({ audio: 's1' }), b2 = fakeEl({ audio: 's2' });
  const env = fakeEnv();
  const p = startPreview(fakeGrid([], [b1, b2]), mk, env);
  await b1.onclick();
  assert.equal(sounds[0].paused, false); assert.equal(sounds[0].src, 'blob:s1');
  await b2.onclick(); // switches
  assert.equal(sounds[0].paused, true); assert.equal(sounds[1].paused, false);
  await b2.onclick(); // same button stops
  assert.equal(sounds[1].paused, true);
  await b1.onclick();
  sounds[2].networkState = 2;
  p.release();
  assert.equal(sounds[2].paused, true); assert.equal(sounds[2].loads, 0);
});

test('playlist cards: counts per kind, placeholder tile (never an image of the video) when there is no picture', () => {
  const sec = { state: 'ok', rows: [
    { id: 'a', name: 'A', author: 'x', gallery: ['1.png', '2.jpg', 'c.mp4', 's.mp3'] },
    { id: 'b', name: 'B', author: 'x', gallery: ['c.mp4'] },
    { id: 'c', name: 'C', author: 'x', gallery: ['s.ogg'] },
  ] };
  const html = playlistCardsHtml(sec, new Set());
  assert.match(html, /2 pictures · 1 video · 1 sound/);
  assert.match(html, /by x - 1 video</);
  assert.match(html, /bg-thumb-video/);
  assert.match(html, /bg-thumb-audio/);
  assert.equal((html.match(/background-image/g) || []).length, 1);
  assert.ok(!/background-image[^>]*\.(mp4|mp3|ogg)/.test(html));
  assert.match(placeholderThumb([]), /browse-card-thumb"><\/div>/);
});

test('preview: EVERY picture tile gets its src (not just the first), a few at a time, and none after release', async () => {
  const mkImg = (i) => { const l = {}; return { dataset: { src: `u/${i}.jpg` }, addEventListener(t, f) { l[t] = f; }, set src(v) { this._src = v; setTimeout(() => l.load?.(), 1); }, get src() { return this._src; } }; };
  const imgs = Array.from({ length: 34 }, (_, i) => mkImg(i));
  const grid = { innerHTML: 'x', querySelectorAll: (sel) => (sel.startsWith('img') ? imgs : []) };
  const p = startPreview(grid, () => ({}), {});
  assert.ok(imgs.filter((i) => i.src).length <= 4, 'pooled');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(imgs.filter((i) => i.src === `u/${imgs.indexOf(i)}.jpg`).length, 34);
  const more = Array.from({ length: 10 }, (_, i) => mkImg(i));
  const g2 = { innerHTML: 'x', querySelectorAll: (sel) => (sel.startsWith('img') ? more : []) };
  const p2 = startPreview(g2, () => ({}), {});
  p2.release();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(more.filter((i) => i.src).length <= 4, 'released: no further pictures started');
  p.release();
});
