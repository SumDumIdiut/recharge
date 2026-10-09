// Small cached thumbnails for the Backgrounds page. A picture / video frame is fetched from the local media
// server once, shrunk to 480 px wide JPEG, and kept in IndexedDB (keyed by file + mtime + size), so the grid
// never decodes full-size files while scrolling. Loading only starts near the viewport, a few at a time.
import { mediaBase, mediaUrl } from '../bgmedia.js';
import { thumbKey, thumbPrefix, thumbSize } from './media.js';

const DB = 'rechargeBgThumbs';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  return dbp;
}
const idb = (mode, fn) => db().then((d) => (d ? new Promise((resolve) => {
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

function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

async function shrinkImage(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
    const { width, height } = thumbSize(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    return await toBlob(c);
  } finally { bmp?.close?.(); }
}

function videoFrame(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const done = (r) => { v.removeAttribute('src'); v.load?.(); resolve(r); };
    v.onerror = () => done(null);
    v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = async () => {
      try {
        const { width, height } = thumbSize(v.videoWidth, v.videoHeight);
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(v, 0, 0, width, height);
        done({ blob: await toBlob(c), duration: v.duration });
      } catch (e) { done({ blob: null, duration: v.duration }); }
    };
    setTimeout(() => done(null), 15000);
    v.src = url;
  });
}

// -> Promise<{ url, duration }|null> for an image or video file of the library (url: object URL of the small JPEG).
export function loadThumb(invoke, file, kind) {
  const run = async () => {
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
      if (hit?.blob) return { url: URL.createObjectURL(hit.blob), duration: hit.duration };
      const q = kind === 'video' ? videoQueue : imageQueue;
      return q(async () => {
        let rec;
        if (kind === 'video') rec = await videoFrame(src);
        else {
          const res = await fetch(src);
          if (!res.ok) return null;
          rec = { blob: await shrinkImage(await res.blob()) };
        }
        if (!rec?.blob) return rec ? { url: null, duration: rec.duration } : null;
        await putRec(file, key, rec);
        return { url: URL.createObjectURL(rec.blob), duration: rec.duration };
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
