// Video thumbnails: one broken / hanging video must never stall the queue, only good frames are kept, a failure
// is remembered (no retry storm) and every hidden <video> is released.
import test from 'node:test';
import assert from 'node:assert/strict';

const made = [];
class FakeVideo {
  constructor() {
    this.tag = 'video'; this.listeners = {}; this.style = {}; this.readyState = 0; this.videoWidth = 1920; this.videoHeight = 1080;
    this.duration = 60; this.released = false; this.attached = false; made.push(this);
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
  fire(ev) { for (const f of [...(this.listeners[ev] || [])]) f({}); }
  set src(u) {
    this._src = u;
    queueMicrotask(() => {
      if (u.includes('bad')) { this.error = { code: 4 }; this.fire('error'); }
      else if (u.includes('hang')) { /* never loads */ }
      else if (u.includes('notrack')) { this.videoWidth = 0; this.readyState = 2; this.fire('loadeddata'); }
      else { this.readyState = 2; this.fire('loadeddata'); }
    });
  }
  get src() { return this._src; }
  set currentTime(t) { this._t = t; this.seeks.push(t); queueMicrotask(() => this.fire('seeked')); }
  get currentTime() { return this._t; }
  get seeks() { return (this._seeks ||= []); }
  pause() {} load() {}
  removeAttribute(a) { if (a === 'src') this._src = undefined; }
  remove() { this.attached = false; this.released = true; }
}
// a canvas whose "pixels" depend on the video time: black before 5 s unless the url says always black
function makeDoc(brightFrom = 0) {
  return {
    addEventListener() {}, hidden: false,
    body: { appendChild: (v) => { v.attached = true; } },
    createElement: (tag) => {
      if (tag === 'video') return new FakeVideo();
      const c = { width: 0, height: 0 };
      let lastVideo = null;
      c.getContext = () => ({
        drawImage: (v) => { lastVideo = v; },
        getImageData: (x, y, w, h) => {
          const bright = lastVideo && !String(lastVideo.src).includes('black') && lastVideo.currentTime >= brightFrom;
          if (lastVideo?.src?.includes('tainted')) throw new Error('SecurityError');
          const d = new Uint8ClampedArray(w * h * 4).fill(bright ? 120 : 0);
          return { data: d };
        },
      });
      c.toBlob = (cb) => cb(new Blob(['jpg']));
      return c;
    },
  };
}
globalThis.document = makeDoc();
globalThis.window = {};
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.fetch = async () => ({ ok: false, headers: { get: () => null } }); // HEAD fails: key without mtime

const { videoFrame, loadThumb, grabConfig, grabTimes, isBlackFrame, frameBrightness } = await import('../src/backgrounds/thumbs.js');
const invoke = async () => 'http://127.0.0.1:1/tok/';

test('a good video yields a frame, and the hidden <video> sits in the document while grabbing and is released after', async () => {
  const before = made.length;
  const r = await videoFrame('http://x/good.mp4');
  assert.ok(r.blob && !r.failed && r.duration === 60);
  const v = made[before];
  assert.equal(v.released, true);
  assert.equal(v.src, undefined);
});

test('an all-black frame is retried at another time; a real frame later wins', async () => {
  globalThis.document = makeDoc(20); // black until 20 s
  const before = made.length;
  const r = await videoFrame('http://x/late.mp4');
  assert.ok(r.blob && !r.black, 'used a later, non-black frame');
  assert.ok(made[before].seeks.length >= 2);
  globalThis.document = makeDoc();
});

test('a video that is black everywhere still gives a (non-cached) frame, flagged black', async () => {
  const r = await videoFrame('http://x/black.mp4');
  assert.ok(r.blob && r.black === true);
});

test('failures: decode error, no video track, tainted canvas, hang -> failed with a reason, never throws', async () => {
  const bad = await videoFrame('http://x/bad.mp4');
  assert.equal(bad.failed, true); assert.match(bad.reason, /decode error 4/);
  assert.equal((await videoFrame('http://x/notrack.mp4')).failed, true);
  const taint = await videoFrame('http://x/tainted.mp4');
  assert.equal(taint.failed, true); assert.match(taint.reason, /CORS/);
  const before = made.length;
  const hang = await videoFrame('http://x/hang.mp4', { timeout: 60 });
  assert.equal(hang.failed, true); assert.equal(hang.reason, 'timeout');
  assert.equal(made[before].released, true, 'a hung video is released too');
});

test('the queue continues after a failing and a hanging video', async () => {
  grabConfig.timeout = 700;
  const t0 = Date.now();
  const [a, b, c, d] = await Promise.all(['q-bad.mp4', 'q-hang.mp4', 'q-good.mp4', 'q-good2.mp4'].map((f) => loadThumb(invoke, f, 'video')));
  grabConfig.timeout = 25000;
  assert.equal(a.failed, true); assert.equal(a.url, null);
  assert.equal(b.failed, true);
  assert.equal(c.url, 'blob:fake'); assert.equal(d.url, 'blob:fake');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(made.every((v) => v.released), 'every hidden video was released');
});

test('a failed video is remembered for the session (no retry storm) and not stored as a thumbnail', async () => {
  const n = made.length;
  const first = await loadThumb(invoke, 'once-bad.mp4', 'video');
  assert.equal(first.failed, true);
  const created = made.length - n;
  const again = await loadThumb(invoke, 'once-bad.mp4', 'video');
  assert.equal(again.failed, true);
  assert.equal(made.length - n, created, 'second request used the remembered failure');
});

test('helpers: grab times, black detection', () => {
  const t = grabTimes(100);
  assert.equal(t[0], 8); assert.ok(t.includes(1) && t.includes(50));
  assert.ok(grabTimes(0.4).every((x) => x >= 0 && x <= 0.4));
  assert.equal(isBlackFrame({ mean: 0, max: 0 }), true);
  assert.equal(isBlackFrame({ mean: 30, max: 200 }), false);
  assert.equal(frameBrightness({ getImageData: () => { throw new Error('x'); } }, 2, 2), null);
});
