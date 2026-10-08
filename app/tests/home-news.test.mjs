// node tests/home-news.test.mjs
import assert from 'node:assert/strict';
const els = {};
globalThis.document = { getElementById: (id) => els[id] || null };
const rows = (n) => [{ id: n + '1', name: `<${n}>`, author: 'a&b', description: 'd', gallery: ['x y.png'], createdAt: n === 'mods' ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z' }];
const log = { channel: 'beta', entries: [{ version: '4.0.0', date: '2026-01-03T00:00:00Z', changes: ['<b>x</b>', 'y'] }, { version: 'bad' }] };
globalThis.fetch = async (url) => {
  const m = url.match(/\/api\/(\w+)$/);
  if (m) return { ok: true, json: async () => (m[1] === 'maps' ? Promise.reject(new Error('x')) : rows(m[1])) };
  if (url.endsWith('/update/beta/changelog.json')) return { ok: true, json: async () => log };
  return { ok: false, status: 404 };
};
globalThis.window = { __TAURI__: { core: { invoke: async (c) => (c === 'launcher_info' ? { managed: true, channel: 'beta' } : Promise.reject(new Error('n'))) } } };
const { releaseEntries, mergeEntries, renderNews, initHomeNews, ago } = await import('../src/home-news.js');

const rel = releaseEntries(log);
assert.equal(rel[0].title, 'Recharge 4.0.0');
const merged = mergeEntries([rel, [{ when: '2026-01-02T00:00:00Z', title: 'm' }, { title: 'nodate' }]]);
assert.deepEqual(merged.map((e) => e.title), ['Recharge 4.0.0', 'm']); // newest first, undated + invalid dropped
assert.equal(mergeEntries([Array.from({ length: 30 }, (_, i) => ({ when: new Date(2026, 0, i + 1).toISOString() }))]).length, 10);

els['home-news'] = { innerHTML: '', querySelectorAll: () => [] };
await initHomeNews();
const html = els['home-news'].innerHTML;
assert.match(html, /tag-release">Recharge/);
assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/); // change text escaped
assert.ok(!html.includes('<b>x'));
assert.match(html, /Background/); assert.match(html, /Playlist/);
assert.match(html, /navigate\('backgrounds'\)/);
assert.match(html, /&lt;mods&gt;/);
assert.ok(html.indexOf('Recharge 4.0.0') < html.indexOf('&lt;mods&gt;')); // release newest
assert.ok(!html.includes('Map</span>')); // failed maps fetch tolerated
assert.equal(ago('garbage'), '');
renderNews([]);
assert.match(els['home-news'].innerHTML, /Nothing new yet/);
console.log('home-news ok');
