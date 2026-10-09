// Share mode, deactivate label, Added badges, video/audio handling.
// node tests/backgrounds-ui.test.mjs
import assert from 'node:assert/strict';
import { mediaKind, formatDuration, cardAction, SHARE_HINT, activeButtonLabel, activeTarget, isImageAdded, isPlaylistAdded, soundOptions, importedStem, LIMITS_MB, thumbKey, thumbPrefix, thumbSize } from '../src/backgrounds/media.js';
import { playbackPlan, AUDIO_DEFAULTS } from '../src/bgmedia.js';
import { imageCardsHtml, playlistCardsHtml, loadCommunity } from '../src/backgrounds/community.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await test('share mode: click maps to select / login / publish / unpublish', () => {
  assert.equal(cardAction({ shareMode: false, shared: true, loggedIn: true }), 'none');
  assert.equal(cardAction({ shareMode: true, shared: false, loggedIn: false }), 'login');
  assert.equal(cardAction({ shareMode: true, shared: false, loggedIn: true }), 'publish');
  assert.equal(cardAction({ shareMode: true, shared: true, loggedIn: true }), 'unpublish');
  assert.match(SHARE_HINT, /Click an image to share it - click a shared one to make it private/);
});

await test('deactivate label and target', () => {
  assert.equal(activeButtonLabel('a', 'a'), 'Deactivate');
  assert.equal(activeButtonLabel('b', 'a'), 'Activate');
  assert.equal(activeButtonLabel('b', null), 'Activate');
  assert.equal(activeTarget('a', 'a'), null);
  assert.equal(activeTarget('b', 'a'), 'b');
});

await test('Added badges: by hub id, by name', () => {
  const cfg = { image_hub: { 'sky.png': 'i1' }, playlists: [{ name: 'Set (by bob)', hub_id: 'p9' }, { name: 'Other', hub_id: null }] };
  assert.equal(isImageAdded({ id: 'i1', name: 'whatever' }, cfg, []), true);
  assert.equal(isImageAdded({ id: 'i2', name: 'Night Sky!' }, cfg, ['Night Sky_-2.png']), true);
  assert.equal(isImageAdded({ id: 'i3', name: 'Nope' }, cfg, ['sky.png']), false);
  assert.equal(importedStem('../evil'), '___evil');
  assert.equal(isPlaylistAdded({ id: 'p9', name: 'Renamed', author: 'x' }, cfg), true);
  assert.equal(isPlaylistAdded({ id: 'p1', name: 'Set', author: 'bob' }, cfg), true);
  assert.equal(isPlaylistAdded({ id: 'p2', name: 'New', author: 'bob' }, cfg), false);
  const sec = { state: 'ok', rows: [{ id: 'i1', name: 'A', gallery: [] }, { id: 'i2', name: 'B', gallery: [] }] };
  const html = imageCardsHtml(sec, new Set(), (r) => r.id === 'i1');
  assert.equal((html.match(/badge-added/g) || []).length, 1);
  assert.match(html, /disabled>Added<\/button>/);
  assert.equal((html.match(/>Add<\/button>/g) || []).length, 1);
  const pl = playlistCardsHtml({ state: 'ok', rows: [{ id: 'p9', name: 'P', gallery: [] }] }, new Set(), () => true);
  assert.match(pl, /badge-added/);
});

await test('community load reports added state from config + library', async () => {
  const invoke = async (c) => ({
    fetch_hub_backgrounds_cmd: [{ id: 'i1', name: 'Sky', author: 'a', gallery: [] }],
    fetch_hub_playlists_cmd: [{ id: 'p1', name: 'Set', author: 'b', gallery: [] }],
    get_backgrounds_config: { playlists: [{ name: 'x', hub_id: 'p1' }], image_hub: {} },
    list_background_images: ['sky.png'],
  }[c]);
  const d = await loadCommunity(invoke);
  assert.equal(d.imageAdded({ id: 'i1', name: 'Sky' }), true);
  assert.equal(d.playlistAdded({ id: 'p1', name: 'Set', author: 'b' }), true);
  assert.equal(d.playlistAdded({ id: 'p2', name: 'Else', author: 'b' }), false);
});

await test('video / audio type handling', () => {
  assert.equal(mediaKind('a.MP4'), 'video');
  assert.equal(mediaKind('a.webm'), 'video');
  assert.equal(mediaKind('a.gif'), 'image');
  assert.equal(mediaKind('song.OGG'), 'audio');
  assert.equal(mediaKind('song.wav'), 'audio');
  assert.equal(mediaKind('x.exe'), null);
  assert.deepEqual(LIMITS_MB, { image: 15, video: 90, audio: 20 });
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(NaN), '');
  const opts = soundOptions(['a.png', 'm.mp3', 'v.mp4']).map((o) => o[0]);
  assert.deepEqual(opts, ['auto', 'off', 'own', 'm.mp3']);
});

await test('playback plan: pause when hidden / game running; sound off by default', () => {
  const base = { hidden: false, gameRunning: false, prefs: { ...AUDIO_DEFAULTS }, sound: 'own', hasVideo: true };
  assert.deepEqual(playbackPlan(base).video, true);
  assert.equal(playbackPlan(base).videoMuted, true); // off by default
  assert.equal(playbackPlan({ ...base, prefs: { ...AUDIO_DEFAULTS, enabled: true } }).videoMuted, false);
  assert.equal(playbackPlan({ ...base, hidden: true }).video, false);
  assert.equal(playbackPlan({ ...base, gameRunning: true }).video, false);
  const aud = { ...base, sound: 'm.mp3', prefs: { ...AUDIO_DEFAULTS, enabled: true } };
  assert.equal(playbackPlan(aud).audio, true);
  assert.equal(playbackPlan({ ...aud, hidden: true }).audio, false);
  assert.equal(playbackPlan({ ...aud, hidden: true, prefs: { ...aud.prefs, keepPlaying: true } }).audio, true);
  assert.equal(playbackPlan({ ...aud, gameRunning: true, prefs: { ...aud.prefs, keepPlaying: true } }).audio, false);
  assert.equal(playbackPlan({ ...aud, sound: null }).audio, false);
});

await test('thumbnail cache key: file + mtime + size, new mtime/size = new key', () => {
  const a = thumbKey('sky.png', 'Thu, 01 Jan 2026 00:00:00 GMT', 1234);
  assert.equal(a, thumbKey('sky.png', 'Thu, 01 Jan 2026 00:00:00 GMT', '1234'));
  assert.notEqual(a, thumbKey('sky.png', 'Fri, 02 Jan 2026 00:00:00 GMT', 1234));
  assert.notEqual(a, thumbKey('sky.png', 'Thu, 01 Jan 2026 00:00:00 GMT', 1235));
  assert.notEqual(a, thumbKey('sky2.png', 'Thu, 01 Jan 2026 00:00:00 GMT', 1234));
  assert.ok(a.startsWith(thumbPrefix('sky.png')) && !thumbKey('sky.png-2.png', '', 1).startsWith(thumbPrefix('sky.png')));
  assert.deepEqual(thumbSize(1920, 1080), { width: 480, height: 270 });
  assert.deepEqual(thumbSize(200, 100), { width: 200, height: 100 });
});

console.log(`${n} tests passed`);
