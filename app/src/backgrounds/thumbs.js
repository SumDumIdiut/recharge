// Small cached thumbnails for the Backgrounds page. A picture / video frame is fetched from the local media
// server once, shrunk to 480 px wide JPEG, and kept in IndexedDB (keyed by file + mtime + size), so the grid
// never decodes full-size files while scrolling. Loading only starts near the viewport, a few at a time.
import { mediaBase, mediaUrl } from '../bgmedia.js';
import { releaseMedia } from '../releasemedia.js';
import { thumbKey, thumbPrefix, thumbSize, mayNotPlay, pictureSource, posterNameFor, POSTER_WIDTH, POSTER_QUALITY, MAX_POSTER_BYTES } from './media.js';
import { readMp4Cover, urlReader, blobReader } from './cover.js';

const DB = 'rechargeBgThumbs';
const IDB_TIMEOUT_MS = 4000;
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
      setTimeout(() => resolve(null), IDB_TIMEOUT_MS); // a storage that never answers must not stall the thumbnails
    });
  }
  return dbp;
}
const idb = (mode, fn) => db().then((d) => (d ? new Promise((resolve) => {
  setTimeout(() => resolve(null), IDB_TIMEOUT_MS);
  try {
    const tx = d.transaction('thumbs', mode);
    const r = fn(tx.objectStore('thumbs'));
    tx.oncomplete = () => resolve(r?.result ?? null);
    tx.onerror = tx.onabort = () => resolve(null);
  } catch (e) { resolve(null); }
}) : null));
const getRec = (key) => idb('readonly', (s) => s.get(key));
function putRec(file, key, rec) {
  return idb('readwrite', (s) => {
    s.delete(IDBKeyRange.bound(thumbPrefix(file), thumbPrefix(file) + '￿')); // stale versions of this file
    s.put(rec, key);
  });
}

// Runs jobs `limit` at a time.
function queue(limit) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      const { fn, resolve } = waiting.shift();
      active++;
      Promise.resolve().then(fn).catch(() => null).then((v) => { active--; resolve(v); pump(); });
    }
  };
  return (fn) => new Promise((resolve) => { waiting.push({ fn, resolve }); pump(); });
}
const imageQueue = queue(3);
const videoQueue = queue(1);

const memo = new Map(); // key -> Promise<{ url, duration }|null>

function toBlob(canvas, quality = 0.8) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function shrinkImage(blob, maxWidth, quality) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
    const { width, height } = thumbSize(bmp.width, bmp.height, maxWidth);
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    try { return await toBlob(c, quality); } finally { c.width = c.height = 0; } // release the canvas backing store right away
  } finally { bmp?.close?.(); }
}

// --- video still frames ---
// WebKitGTK paints nothing for a <video> that is not in the document: drawImage() then returns a fully BLACK
// frame although 'seeked' fired. So the grabber element lives in the document (tiny, almost transparent, behind
// everything), waits until a frame was really presented, rejects all-black frames and retries at other times.
// Every grab has an overall deadline so the (one at a time) queue can never stall, and the element is always released.
export const GRAB_TIMEOUT_MS = 25000;
export const grabConfig = { timeout: GRAB_TIMEOUT_MS }; // tests shorten it
const STEP_TIMEOUT_MS = 8000;

// Mean / max brightness of a canvas, or null when it can't be read (tainted by a cross-origin video without CORS).
export function frameBrightness(ctx, w, h) {
  try {
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, max = 0;
    for (let i = 0; i < d.length; i += 16) { const l = d[i] + d[i + 1] + d[i + 2]; sum += l; if (l > max) max = l; }
    return { mean: sum / (d.length / 16) / 3, max: max / 3 };
  } catch (e) { return null; }
}
export const isBlackFrame = (b) => !!b && b.max < 6;
// Moments to try, in order: ~10 % in (a title card / fade-in at 0 s is common), 1 s, the middle, the very start.
export function grabTimes(duration) {
  const d = isFinite(duration) && duration > 0 ? duration : 2;
  const t = [Math.min(d * 0.1, 8), Math.min(1, d / 2), d / 2, Math.min(0.1, d / 4)].map((x) => Math.max(0, Math.min(x, d - 0.05)));
  return t.filter((x, i) => t.indexOf(x) === i);
}

export function videoFrame(url, { timeout = grabConfig.timeout, doc = document, maxWidth, quality } = {}) {
  return new Promise((resolve) => {
    const v = doc.createElement('video');
    let finished = false;
    const timers = new Set();
    const wait = (ms) => new Promise((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, ms); timers.add(t); });
    const once = (ev, ms) => new Promise((r) => {
      let t = null;
      const on = () => { clearTimeout(t); v.removeEventListener(ev, on); v.removeEventListener('error', onErr); r(true); };
      const onErr = () => { clearTimeout(t); v.removeEventListener(ev, on); v.removeEventListener('error', onErr); r(false); };
      t = setTimeout(() => { v.removeEventListener(ev, on); v.removeEventListener('error', onErr); r(false); }, ms);
      timers.add(t);
      v.addEventListener(ev, on);
      v.addEventListener('error', onErr);
    });
    const done = (r) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      releaseMedia(v);
      resolve(r);
    };
    const failed = (reason, duration) => done({ blob: null, failed: true, reason, duration });
    timers.add(setTimeout(() => failed('timeout'), timeout));
    (async () => {
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:9px;opacity:0.01;pointer-events:none;z-index:2147483647;';
      doc.body?.appendChild(v);
      v.src = url;
      if (!(v.readyState >= 2) && !(await once('loadeddata', STEP_TIMEOUT_MS))) return failed(v.error ? `decode error ${v.error.code}` : 'no data');
      const duration = v.duration;
      if (!(v.videoWidth > 0)) return failed('no video track', duration);
      const { width, height } = thumbSize(v.videoWidth, v.videoHeight, maxWidth);
      const c = doc.createElement('canvas');
      c.width = width; c.height = height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      let best = null, tainted = false;
      for (const t of grabTimes(duration)) {
        if (finished) return;
        v.currentTime = t;
        if (!(await once('seeked', STEP_TIMEOUT_MS))) continue;
        // let the frame reach the compositor
        if (v.requestVideoFrameCallback) await Promise.race([new Promise((r) => v.requestVideoFrameCallback(() => r())), wait(500)]);
        else await wait(250);
        ctx.drawImage(v, 0, 0, width, height);
        const b = frameBrightness(ctx, width, height);
        if (!b) { tainted = true; break; }
        best = { b, t };
        if (!isBlackFrame(b)) { best = { b, t }; break; }
      }
      if (finished) return;
      if (tainted) return failed('cross-origin video (no CORS headers)', duration);
      if (!best) return failed('could not seek', duration);
      let blob = await toBlob(c, quality);
      if (blob && blob.size > MAX_POSTER_BYTES && maxWidth) blob = await toBlob(c, 0.6); // posters are capped at 2 MB
      c.width = c.height = 0;
      if (!blob) return failed('could not encode frame', duration);
      done({ blob, duration, black: isBlackFrame(best.b) });
    })().catch((e) => failed(String(e?.message || e)));
  });
}


// canPlayType of the engine for the "may not play" note (null outside a browser).
const canPlay = (type) => { try { return typeof document === 'undefined' ? 'maybe' : document.createElement('video').canPlayType(type); } catch (e) { return 'maybe'; } };
const videoMayNotPlay = (codec, frameReason) => mayNotPlay({ codec, frameReason, canPlay });

// The cover picture inside an MP4 as a small JPEG -> { blob, cover: true, codec, mayNotPlay } or null. Never throws.
export async function coverOf(reader, frameReason, maxWidth, quality) {
  try {
    const r = await readMp4Cover(reader);
    const flag = videoMayNotPlay(r.videoCodec, frameReason);
    if (!r.bytes) return r.videoCodec ? { blob: null, codec: r.videoCodec, mayNotPlay: flag } : null;
    const blob = await shrinkImage(new Blob([r.bytes], { type: r.mime }), maxWidth, quality);
    return blob ? { blob, cover: true, codec: r.videoCodec, mayNotPlay: flag } : null;
  } catch (e) { return null; }
}

// Community cards: a picture for a hub video (cached by hub key). `reader` reads the file with range requests (or from a blob).
// -> { url, mayNotPlay } | null ; the object URL belongs to the caller's page lifetime.
const hubMemo = new Map();
export function hubCoverThumb(hubKey, reader, frameReason) {
  if (hubMemo.has(hubKey)) return hubMemo.get(hubKey);
  const p = (async () => {
    const hit = await getRec(`hub:${hubKey}`);
    if (hit?.blob) return { url: URL.createObjectURL(hit.blob), mayNotPlay: !!hit.mayNotPlay };
    const cov = await coverOf(reader, frameReason);
    if (!cov?.blob) return null;
    await idb('readwrite', (s) => s.put({ blob: cov.blob, cover: true, mayNotPlay: cov.mayNotPlay, codec: cov.codec }, `hub:${hubKey}`));
    return { url: URL.createObjectURL(cov.blob), mayNotPlay: !!cov.mayNotPlay };
  })().catch(() => null);
  hubMemo.set(hubKey, p);
  p.then((r) => { if (!r) hubMemo.delete(hubKey); });
  return p;
}
export { blobReader, urlReader, pictureSource };

// --- posters: "<video>.poster.jpg" next to each library video, made once from a frame (else the file's own cover) ---
// The frame grab above is only the GENERATOR; tiles load the saved JPEG (served by the media server as an image).

// -> { blob, duration, cover?, black? } | { failed, reason, mayNotPlay, duration }. Never throws.
export async function makePosterBlob(src, grab = videoFrame) {
  const rec = await grab(src, { maxWidth: POSTER_WIDTH, quality: POSTER_QUALITY });
  if (rec?.blob && !rec.black) return { blob: rec.blob, duration: rec.duration };
  // no usable frame (codec the engine lacks, damaged file, cross-origin): the cover picture inside the file, if there is one
  const cov = await coverOf(urlReader(src), rec?.reason, POSTER_WIDTH, POSTER_QUALITY);
  if (cov?.blob && cov.blob.size <= MAX_POSTER_BYTES) return { blob: cov.blob, duration: rec?.duration, cover: true, mayNotPlay: cov.mayNotPlay, codec: cov.codec };
  if (rec?.blob) return { blob: rec.blob, duration: rec.duration, black: true }; // a really black video: a black poster is still its picture
  return { failed: true, reason: rec?.reason, duration: rec?.duration, mayNotPlay: cov?.mayNotPlay ?? videoMayNotPlay(null, rec?.reason) };
}

const posterMemo = new Map(); // file -> Promise<{ url, duration?, ... } | { url: null, failed }>
export const forgetPoster = (file) => posterMemo.delete(file);

const posterBytes = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));

// The poster of a library video as { url (object URL of the JPEG), duration?, cover?, mayNotPlay? }, made first when missing.
// { url: null, failed: true } when no poster could be made (kept until restart, never retried in a loop).
// `missing: true` skips the "is there one already?" request (the retrofit already knows).
export function ensurePoster(invoke, file, { missing = false, grab } = {}) {
  if (posterMemo.has(file)) return posterMemo.get(file);
  const p = (async () => {
    const base = await mediaBase(invoke);
    if (!missing) {
      try {
        const res = await fetch(mediaUrl(base, posterNameFor(file)));
        if (res.ok) return { url: URL.createObjectURL(await res.blob()) };
      } catch (e) {}
    }
    return videoQueue(async () => {
      const rec = await makePosterBlob(mediaUrl(base, file), grab);
      if (!rec.blob) return { url: null, failed: true, reason: rec.reason, duration: rec.duration, mayNotPlay: rec.mayNotPlay };
      try { await invoke('write_poster', { name: file, bytes: await posterBytes(rec.blob) }); } catch (e) { console.warn(`[poster] could not save the poster of ${file}: ${e?.message || e}`); }
      return { url: URL.createObjectURL(rec.blob), duration: rec.duration, cover: !!rec.cover, mayNotPlay: !!rec.mayNotPlay, codec: rec.codec };
    });
  })().catch(() => ({ url: null, failed: true, reason: 'poster error' }));
  posterMemo.set(file, p);
  return p;
}

// Background job: every library video without a poster gets one, one at a time. Safe to call again whenever videos were added
// (a running job picks the new ones up on its next round). `delay` lets the caller wait until the window is idle.
let posterJob = { running: false, again: false };
export function schedulePosters(invoke, { delay = 0, onPoster } = {}) {
  posterJob.again = true;
  if (posterJob.running) return;
  posterJob.running = true;
  setTimeout(async () => {
    try {
      while (posterJob.again) {
        posterJob.again = false;
        const list = await invoke('list_video_posters').catch(() => null);
        for (const file of list?.missing || []) {
          if (posterMemo.has(file)) continue; // a tile asked already (or it failed before)
          const r = await ensurePoster(invoke, file, { missing: true });
          if (r?.url) onPoster?.(file, r);
        }
      }
    } catch (e) {}
    posterJob.running = false;
  }, delay);
}

// -> Promise<{ url, duration }|null> for an image or video file of the library (url: object URL of the small JPEG).
export function loadThumb(invoke, file, kind) {
  const run = async () => {
    if (kind === 'video') return ensurePoster(invoke, file); // a video tile shows its poster (made once, kept next to the video)
    const base = await mediaBase(invoke);
    const src = mediaUrl(base, file);
    let key = thumbKey(file, '', 0);
    try {
      const head = await fetch(src, { method: 'HEAD' });
      if (head.ok) key = thumbKey(file, head.headers.get('Last-Modified'), head.headers.get('Content-Length'));
    } catch (e) {}
    if (memo.has(key)) return memo.get(key);
    const p = (async () => {
      const hit = await getRec(key);
      if (hit?.blob) return { url: URL.createObjectURL(hit.blob), duration: hit.duration, cover: !!hit.cover, mayNotPlay: !!hit.mayNotPlay, codec: hit.codec };
      const q = kind === 'video' ? videoQueue : imageQueue;
      return q(async () => {
        let rec;
        if (kind === 'video') {
          rec = await videoFrame(src);
          // no frame (codec the engine lacks, damaged file): the cover picture inside the file, if there is one
          const cov = rec?.blob ? null : await coverOf(urlReader(src), rec?.reason);
          if (cov?.blob) rec = { ...cov, duration: rec?.duration };
          else if (rec) rec.mayNotPlay = cov?.mayNotPlay ?? videoMayNotPlay(null, rec.reason);
        } else {
          const res = await fetch(src);
          if (!res.ok) return null;
          rec = { blob: await shrinkImage(await res.blob()) };
        }
        if (rec?.failed && !rec.blob) return { url: null, failed: true, reason: rec.reason, duration: rec.duration, mayNotPlay: rec.mayNotPlay }; // kept in memo: no retry until the app restarts, never stored
        if (!rec?.blob) return rec ? { url: null, duration: rec.duration } : null;
        if (rec.black) return { url: URL.createObjectURL(rec.blob), duration: rec.duration }; // a really black video: show it, but don't cache
        await putRec(file, key, rec);
        return { url: URL.createObjectURL(rec.blob), duration: rec.duration, cover: !!rec.cover, mayNotPlay: !!rec.mayNotPlay, codec: rec.codec };
      });
    })();
    memo.set(key, p);
    p.then((r) => { if (!r) memo.delete(key); });
    return p;
  };
  return run().catch(() => null);
}

// Calls load() for an element the first time it comes within ~one screen of the viewport (elements that are
// re-rendered away are simply never loaded).
const pending = new WeakMap();
let io = null;
export function lazyThumb(el, load) {
  if (typeof IntersectionObserver === 'undefined') { load(); return; }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const fn = pending.get(e.target);
        pending.delete(e.target);
        fn?.();
      }
    }, { rootMargin: '600px 0px' });
  }
  pending.set(el, load);
  io.observe(el);
}
