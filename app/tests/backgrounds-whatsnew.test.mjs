// Node-only tests (stub DOM/invoke): node tests/backgrounds-whatsnew.test.mjs
import assert from 'node:assert/strict';
import { loadCommunity, imageCardsHtml, playlistCardsHtml, UNSUPPORTED_IMAGES } from '../src/backgrounds/community.js';
import { renderChangelog, loadChangelog, bannerDecision, versionForBuild, BUILD_KEY } from '../src/whatsnew.js';
import { maybeShowUpdatedBanner } from '../src/whatsnew-banner.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const stub = (map) => async (cmd) => {
  const v = map[cmd];
  if (v instanceof Error) throw v;
  if (v === undefined) throw new Error('no stub ' + cmd);
  return v;
};

await test('community: both sections, yours badge, Add button', async () => {
  const invoke = stub({
    fetch_hub_backgrounds_cmd: [{ id: 'i1', name: 'Sky <b>', author: 'ann', gallery: ['a.png'] }, { id: 'i2', name: 'Mine', author: 'me', gallery: [] }],
    fetch_hub_playlists_cmd: [{ id: 'p1', name: 'Set', author: 'bob', gallery: ['1.png', '2.png'] }],
    get_backgrounds_config: { playlists: [{ public_id: 'p1' }], image_public: { 'mine.png': 'i2' } },
  });
  const d = await loadCommunity(invoke);
  const img = imageCardsHtml(d.images, d.myImages);
  assert.match(img, /data-act="add-image"/);
  assert.match(img, /Sky &lt;b&gt;/);
  assert.equal((img.match(/bg-yours/g) || []).length, 1);
  assert.match(img, /\/api\/backgrounds\/i1\/gallery\/a\.png/);
  assert.match(img, /\/api\/backgrounds\/i2\/file/);
  const pl = playlistCardsHtml(d.playlists, d.myPlaylists);
  assert.match(pl, /2 pictures/);
  assert.match(pl, /bg-yours/);
});

await test('community: /api/backgrounds 404 only breaks the images section', async () => {
  const invoke = stub({
    fetch_hub_backgrounds_cmd: new Error('UNSUPPORTED'),
    fetch_hub_playlists_cmd: [{ id: 'p1', name: 'Set', author: 'bob', gallery: [] }],
    get_backgrounds_config: { playlists: [] },
  });
  const d = await loadCommunity(invoke);
  assert.equal(d.images.state, 'unsupported');
  assert.ok(imageCardsHtml(d.images, d.myImages).includes(UNSUPPORTED_IMAGES.replace("'", '&#39;')));
  assert.equal(d.playlists.state, 'ok');
  assert.match(playlistCardsHtml(d.playlists, d.myPlaylists), /Set/);
});

await test('community: other errors and empty lists', async () => {
  const d = await loadCommunity(stub({ fetch_hub_backgrounds_cmd: new Error('boom'), fetch_hub_playlists_cmd: [], get_backgrounds_config: {} }));
  assert.match(imageCardsHtml(d.images, d.myImages), /Couldn&#39;t load community images: Error: boom|Couldn.*boom/);
  assert.match(playlistCardsHtml(d.playlists, d.myPlaylists), /No community playlists yet/);
});

await test('whatsnew: render + escaping', () => {
  const html = renderChangelog({ entries: [{ version: '3.1.0<script>', build: 42, date: '2026-10-01', changes: ['Fixed <img onerror=x>', 'Second & third'] }] });
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.match(html, /3\.1\.0&lt;script&gt;/);
  assert.match(html, /build 42/);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.match(html, /Second &amp; third/);
});

await test('whatsnew: 404, empty and error', async () => {
  assert.match((await loadChangelog(stub({ fetch_changelog_cmd: new Error('NOT_FOUND') }), 'beta')).html, /No changelog yet/);
  assert.match((await loadChangelog(stub({ fetch_changelog_cmd: { entries: [] } }), 'beta')).html, /No changelog yet/);
  assert.match((await loadChangelog(stub({ fetch_changelog_cmd: new Error('<x>') }), 'beta')).html, /&lt;x&gt;/);
  let seen;
  await loadChangelog(async (c, a) => { seen = [c, a]; return { entries: [] }; }, 'beta');
  assert.deepEqual(seen, ['fetch_changelog_cmd', { channel: 'beta' }]);
});

await test('banner decision', () => {
  assert.deepEqual(bannerDecision('12', null), { show: false, store: '12' });
  assert.deepEqual(bannerDecision('12', '12'), { show: false, store: '12' });
  assert.deepEqual(bannerDecision('13', '12'), { show: true, store: '13' });
  assert.deepEqual(bannerDecision('', '12'), { show: false, store: null });
  assert.equal(versionForBuild([{ build: 13, version: '3.1' }], '13'), '3.1');
  assert.equal(versionForBuild([], '13'), 'build 13');
});

function stubDoc() {
  const created = [];
  const mk = () => ({ children: [], style: {}, append(...c) { this.children.push(...c); }, remove() { this.removed = true; } });
  return { created, body: { kids: [], appendChild(c) { this.kids.push(c); } }, createElement: () => { const e = mk(); created.push(e); return e; } };
}

await test('banner flow: shows after build change, stores build, silent otherwise', async () => {
  globalThis.window = {};
  const store = new Map([[BUILD_KEY, '12']]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const tauri = { core: { invoke: stub({ launcher_info: { managed: true, build: '13', channel: 'stable' }, fetch_changelog_cmd: { entries: [{ build: 13, version: '3.1.0', changes: [] }] } }) } };
  const doc = stubDoc();
  assert.equal(await maybeShowUpdatedBanner(tauri, storage, doc), true);
  assert.equal(doc.body.kids.length, 1);
  assert.equal(doc.created[1].textContent, 'Updated to 3.1.0');
  assert.equal(store.get(BUILD_KEY), '13');
  const doc2 = stubDoc();
  assert.equal(await maybeShowUpdatedBanner(tauri, storage, doc2), false);
  assert.equal(doc2.body.kids.length, 0);
  // not launcher-managed: nothing
  const t2 = { core: { invoke: stub({ launcher_info: { managed: false } }) } };
  assert.equal(await maybeShowUpdatedBanner(t2, storage, stubDoc()), false);
  // storage that throws must not break
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.equal(await maybeShowUpdatedBanner(tauri, bad, stubDoc()), false);
});

console.log(`${n} tests passed`);
