// Video tiles always get a picture when one exists: grabbed frame, else the cover inside the file, else a plain play tile.
// The cover is read from the MP4 boxes (iTunes covr atom, or ffmpeg's single-sample mjpeg "attached picture" track).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMp4Cover, blobReader, urlReader, imageMime } from '../src/backgrounds/cover.js';
import { pictureSource, mayNotPlay, PLAY_OVERLAY, addingText, errText } from '../src/backgrounds/media.js';
import { placeholderThumb, previewTilesHtml, playlistCardsHtml, imageCardsHtml, hubVideoSource, fillHubCovers, startPreview } from '../src/backgrounds/community.js';

const u32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const box = (type, ...kids) => { const body = cat(...kids); return cat(u32(body.length + 8), str(type), body); };
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9);
const ftyp = box('ftyp', str('isom'), u32(0), str('isom'));
const full = (type, ...kids) => box(type, u32(0), ...kids); // version + flags
const trak = (handler, entry, { offset = 0, size = 0, count = 1 } = {}) =>
  box('trak', box('mdia', full('hdlr', u32(0), str(handler), u32(0), u32(0), u32(0), str('x\0')),
    box('minf', box('stbl',
      full('stsd', u32(1), box(entry, new Uint8Array(8))),
      full('stsz', u32(size), u32(count), ...(size ? [] : [u32(0)])),
      full('stco', u32(1), u32(offset))))));
const covr = (img, flags = 13) => box('udta', full('meta', box('ilst', box('©nam', box('data', u32(1), u32(0), str('t'))), box('covr', box('data', u32(flags), u32(0), img)))));

test('covr atom: JPEG and PNG covers are found, the video codec is reported', async () => {
  for (const [img, mime] of [[JPEG, 'image/jpeg'], [PNG, 'image/png']]) {
    const mp4 = cat(ftyp, box('moov', trak('vide', 'av01'), trak('soun', 'mp4a'), covr(img)), box('mdat', new Uint8Array(100)));
    const r = await readMp4Cover(blobReader(new Blob([mp4])));
    assert.equal(r.mime, mime);
    assert.deepEqual([...r.bytes], [...img]);
    assert.equal(r.videoCodec, 'av01');
  }
});

test('attached-picture track: a single-sample mjpeg video track is read through stco / stsz', async () => {
  // layout: ftyp, mdat(JPEG), moov(...) - the picture sits inside mdat, moov at the end
  const head = cat(ftyp, u32(8 + JPEG.length), str('mdat'));
  const offset = head.length;
  const mp4 = cat(head, JPEG, box('moov', trak('vide', 'avc1', { size: 5000, count: 300 }), trak('vide', 'mjpg', { offset, size: JPEG.length })));
  const r = await readMp4Cover(blobReader(new Blob([mp4])));
  assert.equal(r.mime, 'image/jpeg');
  assert.deepEqual([...r.bytes], [...JPEG]);
  assert.equal(r.videoCodec, 'avc1');
});

test('no cover / not an mp4 / truncated: null bytes, never throws', async () => {
  const plain = cat(ftyp, box('moov', trak('vide', 'hvc1')), box('mdat', new Uint8Array(10)));
  const r = await readMp4Cover(blobReader(new Blob([plain])));
  assert.equal(r.bytes, null);
  assert.equal(r.videoCodec, 'hvc1');
  assert.equal((await readMp4Cover(blobReader(new Blob([str('RIFFxxxxWAVEfmt ')])))).bytes, null);
  assert.equal((await readMp4Cover(blobReader(new Blob([plain.subarray(0, 40)])))).bytes, null);
  assert.equal(imageMime(Uint8Array.of(1, 2, 3, 4)), null);
});

test('urlReader reads with Range requests, accepts a server that ignores Range, and falls back to a whole fetch when Range is refused', async () => {
  const mp4 = cat(ftyp, box('mdat', new Uint8Array(5000)), box('moov', trak('vide', 'av01'), covr(JPEG)));
  const calls = [];
  const ranged = async (url, { headers } = {}) => {
    calls.push(headers?.Range);
    const m = /bytes=(\d+)-(\d+)/.exec(headers?.Range || '');
    if (!m) return new Response(mp4, { status: 200 });
    if (+m[1] >= mp4.length) return new Response('', { status: 416 });
    return new Response(mp4.subarray(+m[1], +m[2] + 1), { status: 206 });
  };
  const r1 = await readMp4Cover(urlReader('u', ranged));
  assert.equal(r1.mime, 'image/jpeg');
  assert.ok(calls.length <= 4 && calls.every(Boolean), `only small ranged reads, got ${calls}`);
  const r2 = await readMp4Cover(urlReader('u', async () => new Response(mp4, { status: 200 })));
  assert.equal(r2.mime, 'image/jpeg');
  let n = 0;
  const noRange = async (url, { headers } = {}) => { if (headers) throw new TypeError('preflight failed'); n++; return new Response(mp4); };
  const r3 = await readMp4Cover(urlReader('u', noRange));
  assert.equal(r3.mime, 'image/jpeg');
  assert.equal(n, 1, 'one whole fetch, then served from memory');
  await assert.rejects(readMp4Cover(urlReader('u', async () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-length': '999999999' } }), { maxFull: 10 })));
});

test('picture source order: frame, then cover, then a plain play tile', () => {
  assert.equal(pictureSource({ frame: true, cover: true }), 'frame');
  assert.equal(pictureSource({ frame: false, cover: true }), 'cover');
  assert.equal(pictureSource({ frame: false, cover: false }), 'none');
});

test('"may not play": codec the engine refuses, or a frame that could not be decoded', () => {
  assert.equal(mayNotPlay({ codec: 'av01', canPlay: () => '' }), true);
  assert.equal(mayNotPlay({ codec: 'av01', canPlay: () => 'maybe' }), false);
  assert.equal(mayNotPlay({ codec: 'avc1', canPlay: () => '' }), false);
  assert.equal(mayNotPlay({ frameReason: 'no data' }), true);
  assert.equal(mayNotPlay({ frameReason: 'decode error 4' }), true);
  assert.equal(mayNotPlay({ frameReason: 'timeout' }), false);
});

test('play overlay is on every video tile, never on pictures', () => {
  assert.match(PLAY_OVERLAY, /class="bg-play"/);
  assert.match(placeholderThumb(['a.mp4']), /bg-play/);
  assert.ok(!/bg-play/.test(placeholderThumb(['a.mp3'])));
  const html = previewTilesHtml({ id: 'p', gallery: ['a.png', 'v.mp4'] });
  assert.equal((html.match(/bg-play"/g) || []).length, 1);
  assert.match(html, /data-key="playlist:p:v\.mp4"/);
});

test('video-only hub cards ask for a cover instead of showing the video as a picture', () => {
  const rows = [{ id: 'p', name: 'n', author: 'a', gallery: ['gallery_01.mp4'] }];
  const html = playlistCardsHtml({ state: 'ok', rows }, new Set());
  assert.match(html, /data-cover-url="[^"]*gallery\/gallery_01\.mp4"/);
  assert.match(html, /data-cover-key="playlist:p:gallery_01\.mp4"/);
  assert.ok(!/background-image|<img|<video/.test(html));
  const bg = imageCardsHtml({ state: 'ok', rows: [{ id: 'b', name: 'n', author: 'a', gallery: ['x.mp4'] }] }, new Set());
  assert.ok(!/background-image/.test(bg) && /data-cover-url="[^"]*backgrounds\/b\/file"/.test(bg) && /bg-play/.test(bg));
  assert.equal(hubVideoSource({ id: 'p', gallery: ['a.png', 'v.mp4'] }, 'playlist'), null, 'cards with a gallery picture need none');
});

test('fillHubCovers: one card at a time, picture applied, abortable', async () => {
  const mk = (k) => ({ dataset: { coverUrl: `u/${k}`, coverKey: k }, classList: { add(c) { (this.s ||= new Set()).add(c); } }, style: {}, title: '' });
  const els = [mk('a'), mk('b'), mk('c')];
  const seen = [];
  let release;
  const env = { cover: async (key) => { seen.push(key); if (key === 'b') await new Promise((r) => { release = r; }); return { url: `blob:${key}`, mayNotPlay: key === 'a' }; } };
  const job = fillHubCovers({ querySelectorAll: () => els }, env);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['a', 'b'], 'c waits for b');
  assert.equal(els[0].style.backgroundImage, 'url("blob:a")');
  assert.ok(els[0].classList.s.has('has-cover') && els[0].classList.s.has('may-not-play'));
  job.abort();
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ['a', 'b'], 'aborted: c never starts');
  assert.equal(els[2].style.backgroundImage, undefined);
});

test('preview: the poster comes from the cover before the video has downloaded', async () => {
  const v = { dataset: { src: 'u/v.mp4', key: 'playlist:p:v.mp4' }, hasAttribute: () => false, parentNode: { classList: { add() {}, remove() {} } }, addEventListener() {}, play: () => Promise.resolve() };
  const grid = { innerHTML: 'x', querySelectorAll: (sel) => (sel.startsWith('video') ? [v] : []) };
  const env = { fetchFn: async () => new Response(new Blob(['v'])), createUrl: () => 'blob:v', revokeUrl() {}, cover: async () => ({ url: 'blob:cover' }) };
  const p = startPreview(grid, () => ({}), env);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(v.poster, 'blob:cover');
  p.release();
});

test('adding a playlist: progress text and a real error message', () => {
  assert.equal(addingText(40, 100), 'Adding... 40%');
  assert.equal(addingText(0, 0), 'Adding...');
  assert.equal(errText('download failed: timeout'), 'download failed: timeout');
  assert.equal(errText({ message: 'boom' }), 'boom');
  assert.equal(errText(null), 'something went wrong');
});

test('urlReader: any Range failure falls back to ONE header-less whole-file fetch (capped, abortable, reported)', async () => {
  const mp4 = cat(ftyp, box('mdat', new Uint8Array(5000)), box('moov', trak('vide', 'av01'), covr(JPEG)));
  const warn = console.warn;
  const logs = [];
  console.warn = (m) => logs.push(m);
  try {
    const cases = {
      'CORS TypeError': async (u, o = {}) => { if (o.headers) throw new TypeError('Failed to fetch'); return new Response(mp4); },
      'non-206 error': async (u, o = {}) => (o.headers ? new Response('no', { status: 403 }) : new Response(mp4)),
      'oversized 206': async (u, o = {}) => (o.headers ? new Response(mp4, { status: 206 }) : new Response(mp4)),
    };
    for (const [name, f] of Object.entries(cases)) {
      let whole = 0, withHeaders = 0, reasons = [];
      const fetchFn = async (u, o) => { if (o?.headers) withHeaders++; else whole++; return f(u, o); };
      const r = await readMp4Cover(urlReader('u', fetchFn, { onFallback: (why) => reasons.push(why) }));
      assert.equal(r.mime, 'image/jpeg', name);
      assert.equal(whole, 1, `${name}: exactly one whole fetch`);
      assert.equal(reasons.length, 1, `${name}: spinner callback once`);
      assert.ok(withHeaders >= 1);
    }
    assert.ok(logs.some((m) => /not usable/.test(m)), 'reason logged');
    // a 206 without a readable Content-Range (header not exposed cross-origin) is fine: no fallback
    let whole = 0;
    const exposed = async (u, o = {}) => {
      if (!o.headers) { whole++; return new Response(mp4); }
      const m = /bytes=(\d+)-(\d+)/.exec(o.headers.Range);
      return +m[1] >= mp4.length ? new Response('', { status: 416 }) : new Response(mp4.subarray(+m[1], +m[2] + 1), { status: 206 }); // no Content-Range
    };
    assert.equal((await readMp4Cover(urlReader('u', exposed))).mime, 'image/jpeg');
    assert.equal(whole, 0);
    // cap: streamed body larger than maxFull is refused even without Content-Length
    await assert.rejects(readMp4Cover(urlReader('u', async (u, o = {}) => { if (o.headers) throw new TypeError('x'); return new Response(new Uint8Array(100)); }, { maxFull: 10 })), /too large/);
    // abort: no fallback fetch once aborted
    const ac = new AbortController();
    let n = 0;
    const rd = urlReader('u', async (u, o = {}) => { n++; ac.abort(); throw new TypeError('x'); }, { signal: ac.signal });
    await assert.rejects(rd.read(0, 16));
    assert.equal(n, 1);
  } finally { console.warn = warn; }
});

test('fillHubCovers: spinner class shows while a whole-file read runs and goes away after', async () => {
  const set = new Set();
  const el = { dataset: { coverUrl: 'u/x', coverKey: 'k' }, classList: { add: (c) => set.add(c), remove: (c) => set.delete(c) }, style: {} };
  let during;
  // drive the reader's fallback through a failing Range fetch
  const mp4 = cat(ftyp, box('moov', trak('vide', 'avc1')));
  const warn = console.warn; console.warn = () => {};
  const fetchFn = async (u, o = {}) => { if (o.headers) throw new TypeError('cors'); during = set.has('is-loading'); return new Response(mp4); };
  const env2 = { fetchFn, cover: async (key, reader) => { await readMp4Cover(reader); return { url: 'blob:k' }; } };
  fillHubCovers({ querySelectorAll: () => [el] }, env2);
  await new Promise((r) => setTimeout(r, 20));
  console.warn = warn;
  assert.equal(during, true);
  assert.ok(!set.has('is-loading') && set.has('has-cover'));
});
