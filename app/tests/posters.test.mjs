// Posters: "<video>.poster.jpg" sidecars are hidden from every listing, follow their video, are made once in the background,
// and hub cards / What's new / previews prefer: first gallery image, else the first poster, else the cover.js path.
import test from 'node:test';
import assert from 'node:assert/strict';

const els = {};
globalThis.document = { getElementById: (id) => els[id] || null, addEventListener() {}, hidden: false };
globalThis.window = { addEventListener() {}, __TAURI__: { core: { invoke: async () => Promise.reject(new Error('n')) } } };
const HUBROWS = {
  playlists: [
    { id: 'pv', name: 'only video', author: 'a', gallery: ['v1.mp4'], posters: { 'v1.mp4': 'poster_1_01.jpg' }, createdAt: '2026-03-01T00:00:00Z' },
    { id: 'pp', name: 'pic + poster', author: 'b', gallery: ['a.png', 'v1.mp4'], posters: { 'v1.mp4': 'poster_1_01.jpg' }, createdAt: '2026-02-01T00:00:00Z' },
    { id: 'old', name: 'old hub', author: 'c', gallery: ['v1.mp4'], createdAt: '2026-01-01T00:00:00Z' },
  ],
  backgrounds: [{ id: 'bv', name: 'a clip', author: 'd', gallery: ['clip.mp4'], posters: { file: 'poster_9_01.jpg' }, createdAt: '2026-01-05T00:00:00Z' }],
};
globalThis.fetch = async (url) => {
  const m = String(url).match(/\/api\/(playlists|backgrounds)$/);
  return { ok: true, json: async () => (m ? HUBROWS[m[1]] : []) };
};
const media = await import('../src/backgrounds/media.js');
const editor = await import('../src/backgrounds/editor.js');
const community = await import('../src/backgrounds/community.js');
const thumbs = await import('../src/backgrounds/thumbs.js');
const { initHomeNews } = await import('../src/home-news.js');
const { galleryImages } = await import('../src/ui.js');

const LIB = ['clip.mp4', 'clip.mp4.poster.jpg', 'pic.png', 'x.webm', 'x.webm.poster.png', 'song.mp3', 'PIC2.PNG.POSTER.JPG'];

test('sidecars never show up as items, counts or pickable media', () => {
  assert.deepEqual(media.withoutPosters(LIB), ['clip.mp4', 'pic.png', 'x.webm', 'song.mp3']);
  assert.equal(media.mediaKind('clip.mp4.poster.jpg'), null);
  assert.equal(media.fileKind('clip.mp4.poster.png'), null);
  assert.equal(media.fileKind('photo.jpg'), 'image');
  assert.equal(media.countsText(LIB), '1 picture · 2 videos · 1 sound');
  assert.equal(media.placeholderKind(['clip.mp4', 'clip.mp4.poster.jpg']), 'video');
  assert.deepEqual(media.soundOptions(LIB).map((o) => o[0]), ['auto', 'off', 'own', 'song.mp3']);
  const d = editor.newDraft();
  assert.equal(editor.addItems(d, LIB), 4, 'a poster file can never be added to a playlist');
  assert.ok(editor.savePayload({ ...d, items: [...d.items, 'a.mp4.poster.jpg'] }).images.every((f) => !/poster/.test(f)));
  assert.deepEqual(galleryImages(['a.png', 'a.mp4.poster.jpg', 'b.jpg']), ['a.png', 'b.jpg']);
});

test('name mapping, rename and delete follow the video', () => {
  assert.equal(media.posterNameFor('my clip.mp4'), 'my clip.mp4.poster.jpg');
  assert.equal(media.posterOwner('my clip.mp4.poster.jpg'), 'my clip.mp4');
  assert.equal(media.posterOwner('x.webm.poster.PNG'), 'x.webm');
  assert.equal(media.posterOwner('x.webm'), null);
  const has = (n) => LIB.includes(n);
  assert.deepEqual(media.posterRename('clip.mp4', 'clip-2.mp4', has), { from: 'clip.mp4.poster.jpg', to: 'clip-2.mp4.poster.jpg' });
  assert.deepEqual(media.posterRename('clip.mp4', null, has), { from: 'clip.mp4.poster.jpg', to: null }, 'delete removes it');
  assert.equal(media.posterRename('pic.png', 'p.png', has), null, 'no poster, nothing to move');
});

const ROW = (o) => ({ id: 'r1', name: 'n', author: 'x', ...o });

test('card picture order: gallery image, then poster, then the cover path', () => {
  assert.match(community.rowPicture(ROW({ gallery: ['a.png', 'v.mp4'], posters: { 'v.mp4': 'p.jpg' } }), 'playlist').url, /gallery\/a\.png$/);
  const p = community.rowPicture(ROW({ gallery: ['v.mp4'], posters: { 'v.mp4': 'poster_1_01.jpg' } }), 'playlist');
  assert.equal(p.poster, true);
  assert.match(p.url, /\/api\/playlists\/r1\/gallery\/poster_1_01\.jpg$/);
  assert.match(community.rowPicture(ROW({ gallery: ['v.mp4'], posters: { file: 'q.jpg' } }), 'background').url, /\/api\/backgrounds\/r1\/gallery\/q\.jpg$/);
  assert.equal(community.rowPicture(ROW({ gallery: ['v.mp4'], posters: {} }), 'playlist'), null);
  assert.equal(community.rowPicture(ROW({ gallery: ['v.mp4'] }), 'playlist'), null, 'hub without posters');
  // cover.js stays only the last fallback
  assert.ok(community.hubVideoSource(ROW({ gallery: ['v.mp4'] }), 'playlist'));
  assert.equal(community.hubVideoSource(ROW({ gallery: ['v.mp4'], posters: { 'v.mp4': 'p.jpg' } }), 'playlist'), null);
});

test('hub cards show the poster with a play button, as plain JPEG urls (never the video)', () => {
  const html = community.playlistCardsHtml({ state: 'ok', rows: HUBROWS.playlists }, new Set());
  const cards = html.split('<div class="browse-card"').slice(1);
  assert.match(cards[0], /has-cover[^>]*background-image:url\('[^']*poster_1_01\.jpg'\)/);
  assert.match(cards[0], /bg-play/);
  assert.ok(!/data-cover-url/.test(cards[0]));
  assert.match(cards[1], /gallery\/a\.png/, 'a gallery picture wins over the poster');
  assert.ok(!/poster_1_01/.test(cards[1]));
  assert.match(cards[2], /data-cover-url=/, 'a hub without posters still uses the cover path');
  assert.ok(!/background-image:url\('[^']*\.mp4/.test(html));
  const img = community.imageCardsHtml({ state: 'ok', rows: HUBROWS.backgrounds }, new Set());
  assert.match(img, /gallery\/poster_9_01\.jpg/);
  assert.ok(!/data-cover-url/.test(img));
});

test('preview tiles: a hub poster is the video tile picture from the start', () => {
  const html = community.previewTilesHtml(ROW({ id: 'pp', gallery: ['a.png', 'v1.mp4', 'v2.mp4'], posters: { 'v1.mp4': 'poster_1_01.jpg' } }));
  assert.match(html, /<video poster="[^"]*gallery\/poster_1_01\.jpg"/);
  assert.equal((html.match(/ poster="/g) || []).length, 1);
  assert.equal((html.match(/bg-prev-video has-cover/g) || []).length, 1);
});

test("What's new uses the poster like a cover (no cover.js read), keeps gallery pictures first", async () => {
  els['home-news'] = { innerHTML: '', querySelectorAll: () => [] };
  const asked = [];
  await initHomeNews({ cover: async (key) => { asked.push(key); return { url: 'blob:c' }; } });
  assert.deepEqual(asked, ['playlist:old:v1.mp4'], 'only the hub row without posters borrows a cover');
  const html = els['home-news'].innerHTML;
  assert.match(html, /<img class="news-img" src="[^"]*gallery\/poster_1_01\.jpg"/);
  assert.match(html, /<img class="news-img" src="[^"]*backgrounds\/bv\/gallery\/poster_9_01\.jpg"/);
  assert.match(html, /playlists\/pp\/gallery\/a\.png/);
  assert.ok(!/src="[^"]*\.mp4/.test(html));
});

// ---- generation ----
const fakeInvoke = (log, extra = {}) => async (cmd, args) => {
  log.push([cmd, args]);
  if (cmd === 'background_media_base') return 'http://127.0.0.1:1/tok/';
  if (extra[cmd]) return extra[cmd](args);
  return null;
};
const noPosterOnServer = async () => ({ ok: false, status: 404, headers: { get: () => null }, blob: async () => new Blob([]) });

test('a video without a poster: frame grabbed, saved through write_poster, the tile gets the new picture', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u, o) => { urls.push(String(u)); return noPosterOnServer(); };
  const log = [];
  const grabs = [];
  const grab = async (src, opts) => { grabs.push([src, opts]); return { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])]), duration: 12 }; };
  const r = await thumbs.ensurePoster(fakeInvoke(log), 'a clip.mp4', { grab });
  assert.ok(r.url.startsWith('blob:'));
  assert.equal(r.duration, 12);
  assert.ok(urls[0].endsWith('/a%20clip.mp4.poster.jpg'), 'looked for the saved poster first');
  assert.equal(grabs[0][1].maxWidth, 1280);
  assert.equal(grabs[0][1].quality, 0.82);
  const w = log.find((l) => l[0] === 'write_poster');
  assert.equal(w[1].name, 'a clip.mp4');
  assert.deepEqual(w[1].bytes, [0xff, 0xd8, 0xff, 1, 2, 3]);
  // asked again: remembered, nothing is made twice
  assert.equal(await thumbs.ensurePoster(fakeInvoke(log), 'a clip.mp4', { grab }), r);
  assert.equal(grabs.length, 1);
  globalThis.fetch = realFetch;
});

test('an existing poster is just loaded (no grab, no write)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9])]) });
  const log = [];
  const r = await thumbs.ensurePoster(fakeInvoke(log), 'have.mp4', { grab: async () => { throw new Error('must not grab'); } });
  assert.ok(r.url.startsWith('blob:'));
  assert.ok(!log.some((l) => l[0] === 'write_poster'));
  globalThis.fetch = realFetch;
});

test('no frame and no cover: failed (the only case a tile says "can\'t preview"), nothing written', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = noPosterOnServer;
  const log = [];
  const warn = console.warn; console.warn = () => {};
  const r = await thumbs.ensurePoster(fakeInvoke(log), 'broken.mp4', { grab: async () => ({ blob: null, failed: true, reason: 'decode error 4' }) });
  console.warn = warn;
  assert.equal(r.url, null);
  assert.equal(r.failed, true);
  assert.equal(r.mayNotPlay, true);
  assert.ok(!log.some((l) => l[0] === 'write_poster'));
  globalThis.fetch = realFetch;
});

test('retrofit: videos without a poster get one, strictly one at a time; later calls pick up new videos', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = noPosterOnServer;
  const log = [];
  let active = 0, maxActive = 0;
  const lists = [{ missing: ['r1.mp4', 'r2.mp4'], have: {} }, { missing: ['r3.mp4'], have: {} }];
  const invoke = fakeInvoke(log, {
    list_video_posters: () => lists.shift() || { missing: [], have: {} },
    write_poster: () => null,
  });
  const done = [];
  // the generator is the real ensurePoster; its grab is injected through the first call each file gets
  const origEnsure = thumbs.ensurePoster;
  for (const f of ['r1.mp4', 'r2.mp4', 'r3.mp4']) {
    // pre-seed so the job's ensurePoster finds a memo entry made with a fake grab (video decoding is not available under node)
    origEnsure(invoke, f, { missing: true, grab: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; return { blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0])]) }; } }).then(() => done.push(f));
  }
  thumbs.schedulePosters(invoke);
  thumbs.schedulePosters(invoke); // second call while the first is queued: still one job
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(done, ['r1.mp4', 'r2.mp4', 'r3.mp4']);
  assert.equal(maxActive, 1);
  assert.equal(log.filter((l) => l[0] === 'write_poster').length, 3);
  assert.equal(log.filter((l) => l[0] === 'list_video_posters').length >= 1, true);
  globalThis.fetch = realFetch;
});
