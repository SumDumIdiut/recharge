import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moderation } from '../src/social/api.js';
import { avatarHtml, nameHtml, userOf } from '../src/social/avatar.js';

const EVIL = '<img src=x onerror=alert(1)>"\'<script>alert(2)</script>';
const noTags = (html) => assert.ok(!/<img src=x|<script/i.test(html), html);

test('the player directory goes through the hub client, never a bare fetch', () => {
  // A relative /api/... would be fetched from the app's own origin, not the hub.
  assert.equal(typeof moderation.users, 'function');
  assert.equal(moderation.users.length, 1);
  const src = readFileSync(new URL('../src/players/script.js', import.meta.url), 'utf8');
  assert.ok(!/await fetch\(\s*['"`]\/api/.test(src), 'players/script.js must not fetch a relative /api path');
});

test('selecting a player opens the profile card, not a second panel', () => {
  const src = readFileSync(new URL('../src/players/script.js', import.meta.url), 'utf8');
  // The old inline detail block under the list, with its green header text.
  assert.ok(!/playerListHtml/.test(src), 'the inline beaten-maps panel is gone');
  assert.ok(!/players-detail/.test(src));
  assert.ok(!/victors\(/.test(src), 'no per-map victor lookups on a click any more');
  // data-user is what the app-wide listener acts on, so it lands on the same profile card
  // every other name in the app opens - badge editor and moderator button included.
  assert.match(src, /row\.dataset\.user = row\.dataset\.player/);
});

test('the renderer that drew the green header is gone', () => {
  const css = readFileSync(new URL('../src/social/social.css', import.meta.url), 'utf8');
  assert.ok(!/\.player-detail\b/.test(css));
  assert.ok(!/\.player-bio\b/.test(css));
});

test('granting the role refreshes the badges the hub handed back', () => {
  const src = readFileSync(new URL('../src/social/profile.js', import.meta.url), 'utf8');
  // The response now carries badges; without reading them the card would show the old set
  // until it was closed and reopened.
  assert.match(src, /if \(Array\.isArray\(r\.badges\)\) p\.badges = r\.badges/);
  // ...and the card is re-rendered so the Moderator chip and the name above it agree.
  assert.match(src, /profileCardHtml\(p, \{ uploads: true \}\)/);
  assert.match(src, /x\.id === 'moderator'/);
});

test('the row normalises the hub shape so avatars and colours actually render', () => {
  const src = readFileSync(new URL('../src/players/script.js', import.meta.url), 'utf8');
  // The directory sends avatar_url / name_color / frame_colors; the renderers read
  // avatar / nameColor. Passing rows straight through silently dropped both, so every
  // avatar showed a letter and every name showed plain white.
  assert.match(src, /userOf\(raw\)/);
  assert.match(src, /import \{ avatarHtml, nameHtml, userOf \}/);
  const hub = readFileSync(new URL('../src/social/avatar.js', import.meta.url), 'utf8');
  assert.match(hub, /avatar: a\.avatar_url/); // userOf is what does the renaming
  assert.match(hub, /nameColor: a\.name_color/);
});

test('a directory row with an avatar and a colour survives the round trip', () => {
  const raw = {
    username: 'Flipped',
    avatar_url: '/api/avatars/b06afa.webp',
    name_color: 'linear-gradient(90deg, #41f88d, #4aa8ff)',
    frame: 's-spin-gradient', frame_colors: ['#41f88d', '#4aa8ff'],
    badges: [], moderator: false, uploads: {},
  };
  const u = userOf(raw);
  assert.equal(u.avatar, '/api/avatars/b06afa.webp');
  assert.equal(u.nameColor, 'linear-gradient(90deg, #41f88d, #4aa8ff)');
  assert.equal(u.frame, 's-spin-gradient');
  // The renderers read these camelCase names, so this is what makes them produce an <img>
  // and a styled <a> rather than an initial and plain text.
  assert.match(avatarHtml(u, 40), /<img class="avatar-img" src="https:[^"]*b06afa\.webp"/);
  assert.match(nameHtml(u), /style="[^"]*gradient/);
});

test('points are gone from the row and uploads stand in', () => {
  const src = readFileSync(new URL('../src/players/script.js', import.meta.url), 'utf8');
  assert.ok(!/\bu\.points\b/.test(src), 'the list shows what people made, not their points');
  assert.ok(!/\bu\.awards\b/.test(src));
  assert.match(src, /raw\.uploads/);
  assert.match(src, /\['map', 'Maps'\]/);
  assert.match(src, /\['mod', 'Mods'\]/);
  assert.match(src, /\['skin', 'Skins'\]/);
  assert.match(src, /\['playlist', 'Playlists'\]/);
  assert.match(src, /\['background', 'Backgrounds'\]/);
});

test('a moderator without the badge still shows as one', () => {
  const src = readFileSync(new URL('../src/players/script.js', import.meta.url), 'utf8');
  // An admin is a moderator without the is_moderator flag, so the badge alone would make
  // every admin look like an ordinary account.
  assert.match(src, /raw\.moderator && !\(raw\.badges \|\| \[\]\)\.some\(\(b\) => b\.id === 'moderator'\)/);
});
