// A video / audio gallery file must never reach an <img> or a CSS background-image (WebKitGTK decodes a video in an
// <img> into an ~11 GB GPU pool).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageName, galleryImages } from '../src/ui.js';
import { playlistCardsHtml, imageThumbUrl } from '../src/backgrounds/community.js';

test('galleryImages keeps only pictures', () => {
  assert.deepEqual(galleryImages(['a.mp4', 'b.PNG', 'c.mp3', 'd.jpg', 'e.webm']), ['b.PNG', 'd.jpg']);
  assert.deepEqual(galleryImages(undefined), []);
  assert.equal(isImageName('x.mp4'), false);
});

test('a playlist whose gallery is a video gets no background-image', () => {
  const html = playlistCardsHtml({ state: 'ok', rows: [{ id: 'p', name: 'v', author: 'a', gallery: ['gallery_01.mp4'] }] }, new Set());
  assert.ok(!/background-image/.test(html) && !/src=|url\(/.test(html)); // the mp4 url may only sit in data-cover-url (read for its cover picture, never displayed)
  const html2 = playlistCardsHtml({ state: 'ok', rows: [{ id: 'p', name: 'v', author: 'a', gallery: ['gallery_01.mp4', 'g2.png'] }] }, new Set());
  assert.ok(/g2\.png/.test(html2) && !/\.mp4/.test(html2));
});

test('a background whose first gallery file is a video falls back to the file endpoint', () => {
  assert.ok(!/\.mp4/.test(imageThumbUrl({ id: 'b', gallery: ['v.mp4'] })));
});

test('What\'s new never renders a video as an image', async () => {
  const els = {};
  globalThis.document = { getElementById: (id) => els[id] || null };
  globalThis.window = { __TAURI__: undefined };
  const { renderNews } = await import('../src/home-news.js');
  els['home-news'] = { innerHTML: '', querySelectorAll: () => [] };
  renderNews([{ kind: 'library', tag: 'Playlist', tab: 'backgrounds', when: '2026-01-01T00:00:00Z', title: 't', image: null }]);
  assert.ok(!/<img/.test(els['home-news'].innerHTML));
});
