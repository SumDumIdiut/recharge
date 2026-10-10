// What's new: a hub entry with no picture whose first gallery file is a video gets that video's cover as a blob/data <img>
// (never the mp4), with a play button. Also the second tab row (Community Images / Playlists) must not be full width.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const els = {};
globalThis.document = { getElementById: (id) => els[id] || null };
globalThis.window = { __TAURI__: { core: { invoke: async () => Promise.reject(new Error('n')) } } };
const ID = 'ee2832c9-ae4b-4ed2-b400-0fd95031a5bb';
globalThis.fetch = async (url) => {
  if (url.endsWith('/api/playlists')) return { ok: true, json: async () => [
    { id: ID, name: 'beany but better', author: 'x', gallery: ['gallery_1791589027140_01.mp4'], createdAt: '2026-02-01T00:00:00Z' },
    { id: 'p2', name: 'pics', author: 'y', gallery: ['a.png', 'b.mp4'], createdAt: '2026-01-01T00:00:00Z' }] };
  return { ok: true, json: async () => [] };
};
const { initHomeNews } = await import('../src/home-news.js');

test('video-first entry gets a cover <img> from a blob url, not the mp4', async () => {
  els['home-news'] = { innerHTML: '', querySelectorAll: () => [] };
  const asked = [];
  await initHomeNews({ cover: async (key, reader) => { asked.push([key, reader]); return { url: 'blob:cover-1' }; } });
  assert.deepEqual(asked.map((a) => a[0]), [`playlist:${ID}:gallery_1791589027140_01.mp4`], 'only the video-first entry');
  const html = els['home-news'].innerHTML;
  assert.match(html, /<img class="news-img" src="blob:cover-1"/);
  assert.match(html, /bg-play/);
  assert.ok(!/src="[^"]*\.mp4/.test(html) && !/url\([^)]*\.mp4/.test(html));
  assert.match(html, /\/api\/playlists\/p2\/gallery\/a\.png/, 'entries with a picture keep it');
});

test('no cover (null / error) leaves the entry picture-less, and a rebuild aborts the old job', async () => {
  els['home-news'] = { innerHTML: '', querySelectorAll: () => [] };
  const warn = console.warn; console.warn = () => {};
  await initHomeNews({ cover: async () => null });
  assert.ok(!/news-cover/.test(els['home-news'].innerHTML));
  let signal, release;
  const first = initHomeNews({ cover: async (k, r) => { await new Promise((res) => { release = res; }); return { url: 'blob:stale' }; } });
  await new Promise((r) => setTimeout(r, 20));
  await initHomeNews({ cover: async () => ({ url: 'blob:fresh' }) });
  release();
  await first;
  console.warn = warn;
  assert.match(els['home-news'].innerHTML, /blob:fresh/);
  assert.ok(!/blob:stale/.test(els['home-news'].innerHTML));
});

test('second tab rows are sized to their tabs, not full width', () => {
  const css = fs.readFileSync(new URL('../src/components.css', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/backgrounds/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.browser-subtabs\s*\{[^}]*width:\s*fit-content/);
  assert.match(css, /\.bg-csections\s*\{[^}]*width:\s*fit-content/);
  for (const v of ['mods', 'maps', 'skins', 'backgrounds']) {
    const html = fs.readFileSync(new URL(`../src/${v}/view.html`, import.meta.url), 'utf8');
    for (const m of html.matchAll(/class="browser-subtabs[^"]*"/g)) assert.ok(m[0].includes('browser-subtabs'));
  }
});
