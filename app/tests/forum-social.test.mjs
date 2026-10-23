import test from 'node:test';
import assert from 'node:assert/strict';
import { richText, safeUrl, linkHtml, timeAgo } from '../src/social/text.js';
import { avatarHtml, nameHtml, userOf, FRAMES, frameOf, initialOf, safeColor, hubUrl } from '../src/social/avatar.js';
import { validatePost, validateReply, validateComment, LIMITS } from '../src/social/validate.js';
import { commentsHtml } from '../src/social/comments.js';
import { postRowHtml, postHtml, replyHtml, imagesHtml, listHtml } from '../src/forum/lib.js';
import { profileCardHtml } from '../src/social/profile.js';
import { clampOffset, sourceRect, coverSource, scaleFor, clampZoom } from '../src/social/crop.js';
import { resolveHubBase, DEFAULT_HUB_BASE } from '../src/hub.js';
import { errorMessage } from '../src/social/api.js';

const EVIL = '<img src=x onerror=alert(1)>"\'<script>alert(2)</script>';
const noTags = (html) => { assert.ok(!/<img src=x|<script/i.test(html), html); };

test('richText escapes everything and only links http(s)', () => {
  noTags(richText(EVIL));
  assert.match(richText('see https://a.example/x?y=1&z=2.'), /href="https:\/\/a\.example\/x\?y=1&amp;z=2"[^>]*rel="noopener noreferrer"/);
  assert.ok(richText('see https://a.example/x.').endsWith('</a>.'));
  assert.ok(!richText('javascript:alert(1) and data:text/html,x').includes('<a'));
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://u:p@x.com/'), '');
  assert.equal(safeUrl('file:///etc/passwd'), '');
  assert.ok(safeUrl('http://x.com'));
  assert.ok(!linkHtml('https://x.com/"><script>', 'a').includes('<script'));
});

test('titles, bodies and usernames are escaped in forum markup', () => {
  const author = { username: EVIL, avatar_url: null, frame: 'gold', name_color: '"><b>' };
  const post = { id: 1, title: EVIL, body: EVIL, category: 'bug', status: 'solved', pinned: true, reply_count: 2, created_at: '2026-01-01T00:00:00Z', author, images: ['/api/forum/images/a.png', 'javascript:alert(1)'] };
  noTags(postRowHtml(post));
  noTags(postHtml(post));
  noTags(replyHtml({ id: 2, body: EVIL, author, images: [], can_edit: true, can_delete: true }));
  noTags(listHtml({ posts: [post] }));
  assert.ok(!postHtml(post).includes('<b>'), 'bad colour is dropped');
  assert.ok(!imagesHtml(post.images).includes('javascript:'));
  assert.equal((imagesHtml(post.images).match(/<img/g) || []).length, 1);
  noTags(profileCardHtml({ username: EVIL, bio: EVIL, title: EVIL, pronouns: EVIL, links: ['javascript:alert(1)', 'https://ok.example'], uploads: [{ kind: EVIL, name: EVIL }] }, { uploads: true }));
  assert.ok(!profileCardHtml({ username: 'a', links: ['javascript:alert(1)'] }).includes('javascript:'));
});

test('list shows an empty state and fixed row structure', () => {
  assert.match(listHtml({ posts: [] }), /No posts/);
  assert.match(postRowHtml({ id: 3, title: 't', category: 'question', status: 'open', reply_count: 0, author: { username: 'bob' } }), /data-post="3"/);
});

test('composer validation', () => {
  const ok = { title: 'T', body: 'B', category: 'bug', images: [] };
  assert.ok(validatePost(ok).ok);
  assert.ok(validatePost({ ...ok, title: ' ' }).errors.title);
  assert.ok(validatePost({ ...ok, title: 'x'.repeat(121) }).errors.title);
  assert.ok(validatePost({ ...ok, body: '' }).errors.body);
  assert.ok(validatePost({ ...ok, body: 'x'.repeat(5001) }).errors.body);
  assert.ok(validatePost({ ...ok, category: 'nope' }).errors.category);
  const img = { type: 'image/png', size: 10 };
  assert.ok(validatePost({ ...ok, images: [img, img, img, img] }).ok);
  assert.ok(validatePost({ ...ok, images: Array(5).fill(img) }).errors.images);
  assert.ok(validatePost({ ...ok, images: [{ type: 'image/svg+xml', size: 1 }] }).errors.images);
  assert.ok(validatePost({ ...ok, images: [{ type: 'image/png', size: LIMITS.imageBytes + 1 }] }).errors.images);
  assert.ok(validateReply({ body: '' }).errors.body);
  assert.ok(validateReply({ body: 'x'.repeat(3001) }).errors.body);
  assert.ok(validateReply({ body: 'hi', images: Array(3).fill(img) }).errors.images);
  assert.ok(validateComment({ body: 'x'.repeat(1001) }).errors.body);
  assert.ok(validateComment({ body: 'fine' }).ok);
});

test('comments renderer: escapes, one reply level, own-action buttons', () => {
  const list = [{ id: 1, body: EVIL, created_at: '2026-01-01T00:00:00Z', edited_at: '2026-01-02T00:00:00Z', author: { username: EVIL }, can_edit: true, can_delete: true,
    replies: [{ id: 2, body: EVIL, author: { username: 'r' }, can_edit: false, can_delete: true }] }];
  const html = commentsHtml(list, { loggedIn: true });
  noTags(html);
  assert.match(html, /\(edited\)/);
  assert.equal((html.match(/data-act="reply"/g) || []).length, 1, 'replies cannot be replied to');
  assert.equal((html.match(/data-act="edit"/g) || []).length, 1);
  assert.equal((html.match(/data-act="del"/g) || []).length, 2);
  assert.match(commentsHtml([], { loggedIn: false }), /No comments yet/);
});

test('avatar component: frames, fallback initial, safe attributes', () => {
  assert.deepEqual(FRAMES.map((f) => f.id).slice(0, 6), ['none', 'green', 'gold', 'pixel', 'neon', 'double']); // the original six stay first
  assert.equal(frameOf('bogus'), 'none');
  assert.equal(initialOf('zed'), 'Z');
  assert.equal(initialOf(''), '?');
  const none = avatarHtml({ username: 'zed' }, 40);
  assert.match(none, /avatar-initial[^>]*>Z</);
  assert.ok(!none.includes('<img'));
  const withImg = avatarHtml({ username: 'zed', avatar: '/api/avatars/a.png', frame: 'gold' }, 40);
  assert.match(withImg, /frame-gold/);
  assert.match(withImg, /<img[^>]*decoding="async"/);
  assert.match(withImg, /--av:40px/);
  assert.ok(!avatarHtml({ username: 'x', avatar: 'javascript:alert(1)' }).includes('<img'));
  assert.ok(!avatarHtml({ username: EVIL, frame: '"><x', accent: 'red;x' }).includes('<script'));
  assert.equal(safeColor('#12ab9f'), '#12ab9f');
  assert.equal(safeColor('red'), '');
  assert.equal(hubUrl('/api/a.png', 'https://h.example/recharge'), 'https://h.example/recharge/api/a.png'); // the hub's path is kept
  assert.equal(hubUrl('/api/a.png', 'https://h.example/recharge/'), 'https://h.example/recharge/api/a.png');
  assert.equal(hubUrl('/api/a.png', 'http://127.0.0.1:38123'), 'http://127.0.0.1:38123/api/a.png');
  assert.match(nameHtml({ username: EVIL, nameColor: '#fff' }), /data-user="&lt;img/);
  assert.equal(userOf({ author: { username: 'a', avatar_url: '/x', frame: 'neon', name_color: '#fff' } }).frame, 'neon');
});

test('crop maths', () => {
  const B = 256;
  // landscape 1024x512: at zoom 1 the short side fills the box
  assert.equal(scaleFor(1024, 512, B, 1), 0.5);
  assert.equal(clampZoom(99), 4);
  assert.equal(clampZoom(NaN), 1);
  let r = sourceRect(1024, 512, B, 1, 0, 0);
  assert.deepEqual(r, { sx: 256, sy: 0, sw: 512, sh: 512 });
  // pan can't leave the picture: max pan is (512-256)/2 = 128 box px
  assert.deepEqual(clampOffset(1024, 512, B, 1, 999, 999), { x: 128, y: 0 });
  r = sourceRect(1024, 512, B, 1, 128, 0);
  assert.equal(r.sx, 0);
  // zoom 2 halves the source square
  r = sourceRect(1024, 512, B, 2, 0, 0);
  assert.equal(r.sw, 256);
  assert.equal(r.sx, 384);
  assert.equal(r.sy, 128);
  // the rect always stays inside the picture
  for (const z of [1, 1.7, 4]) for (const o of [-1e6, 0, 1e6]) {
    const q = sourceRect(300, 900, B, z, o, o);
    assert.ok(q.sx >= -1e-9 && q.sy >= -1e-9 && q.sx + q.sw <= 300 + 1e-9 && q.sy + q.sh <= 900 + 1e-9);
  }
  const c = coverSource(1000, 1000, 800, 200);
  assert.deepEqual(c, { sx: 0, sy: 375, sw: 1000, sh: 250 });
  assert.deepEqual(coverSource(2000, 100, 800, 200), { sx: 800, sy: 0, sw: 400, sh: 100 });
});

test('hub override and error text', () => {
  assert.equal(resolveHubBase(''), DEFAULT_HUB_BASE);
  assert.equal(resolveHubBase('javascript:alert(1)'), DEFAULT_HUB_BASE);
  assert.equal(resolveHubBase('http://127.0.0.1:8099/recharge/'), 'http://127.0.0.1:8099/recharge');
  assert.match(errorMessage(429, { retry_after: 30 }), /30 seconds/);
  assert.match(errorMessage(429, { retry_after: 600 }), /10 minutes/);
  assert.match(errorMessage(401, {}), /log in/i);
  assert.match(errorMessage(400, { error: 'body too long' }), /body too long/);
});

test('timeAgo', () => {
  const now = Date.parse('2026-01-02T00:00:00Z');
  assert.equal(timeAgo('2026-01-01T23:59:50Z', now), 'just now');
  assert.equal(timeAgo('2026-01-01T22:00:00Z', now), '2h ago');
  assert.equal(timeAgo(null, now), '');
});

import { uploaderHtml } from '../src/social/avatar.js';
import { canRemoveUpload } from '../src/social/perms.js';
import { parentIdOf } from '../src/social/comments.js';

test('admins see Remove on others\' items, owners on theirs, nobody else', () => {
  assert.equal(canRemoveUpload(false, true), true);
  assert.equal(canRemoveUpload(true, false), true);
  assert.equal(canRemoveUpload(false, false), false);
  assert.equal(canRemoveUpload(undefined, undefined), false);
});

test('uploader names are clickable (data-user) and escaped; no account stays plain text', () => {
  const h = uploaderHtml({ author: EVIL, uploader: 'al"ice<b>' });
  noTags(h);
  assert.match(h, /data-user="al&quot;ice&lt;b&gt;"/);
  assert.match(h, /^<a class="user-name/);
  const plain = uploaderHtml({ author: EVIL, uploader: null });
  noTags(plain);
  assert.ok(!plain.includes('data-user'));
  assert.equal(uploaderHtml({ author: 'x' }), 'x');
  assert.match(nameHtml({ username: 'bob', label: 'Bobby' }), />Bobby<\/a>/);
});

test('reply parent id goes to the hub as a number', () => {
  assert.strictEqual(parentIdOf('12'), 12);
  assert.strictEqual(typeof parentIdOf('7'), 'number');
});

test('badges: one chip each, escaped, with the badge colour as a CSS var', async () => {
  const { badgesHtml, titlesHtml, userOf } = await import('../src/social/avatar.js');
  const badge = (id, name, colour = null, description = '') => ({ id, name, colour, description });
  assert.equal(
    badgesHtml({ badges: [badge('moderator', 'Moderator'), badge('admin', 'Admin')] }),
    '<span class="cm-title" title="Moderator">Moderator</span><span class="cm-title" title="Admin">Admin</span>'
  );
  // The badge's own colour only when it is a real colour; anything else is dropped.
  assert.match(badgesHtml({ badges: [badge('a', 'A', '#41f88d')] }), /style="--bd:#41f88d"/);
  assert.equal(badgesHtml({ badges: [badge('a', 'A', 'red; background:url(x)')] }), '<span class="cm-title" title="A">A</span>');
  assert.equal(badgesHtml({ badges: [badge('a', '<b>x</b>')] }), '<span class="cm-title" title="&lt;b&gt;x&lt;/b&gt;">&lt;b&gt;x&lt;/b&gt;</span>');
  assert.equal(badgesHtml({ badges: [badge('a', 'A', null, 'Runs the hub')] }).includes('title="Runs the hub"'), true);
  assert.equal(badgesHtml({}), '');
  assert.equal(badgesHtml({ badges: 'nope' }), '');
  // titlesHtml is the name the call sites already use, and it is badges now.
  assert.equal(titlesHtml, badgesHtml);
  // The old title labels render nothing rather than old labels.
  assert.equal(badgesHtml({ titles: ['Mapmaker'], title: 'Tester' }), '');
  // userOf carries the badges and the moderator flag through.
  assert.deepEqual(userOf({ author: { username: 'a', badges: [badge('moderator', 'Moderator')] } }).badges.map((b) => b.id), ['moderator']);
  assert.equal(userOf({ author: { username: 'a', moderator: true } }).moderator, true);
  assert.equal(userOf({ author: { username: 'a' } }).moderator, false);
});

test('name colours: plain hex or a strict gradient, nothing else reaches the style', async () => {
  const { nameStyle, normalizeGradient, nameHtml } = await import('../src/social/avatar.js');
  assert.equal(nameStyle('#ff8800'), 'color:#ff8800');
  const g = 'linear-gradient(90deg, #41f88d, #4aa8ff 50%, #c63ed8 100%)';
  assert.match(nameStyle(g), /^background-image:linear-gradient\(90deg, #41f88d, #4aa8ff 50%, #c63ed8 100%\);-webkit-background-clip:text/);
  for (const bad of ['red', 'url(x)', 'linear-gradient(90deg, #111111, #222222);color:red', 'linear-gradient(90deg, red, blue)', 'radial-gradient(#111111, #222222)', 'linear-gradient(90deg, #111111)', '"><script>'])
    assert.equal(nameStyle(bad), '', bad);
  assert.equal(normalizeGradient('Linear-Gradient( 45deg ,#ABC,#4aa8ff 50% )'), 'linear-gradient(45deg, #aabbcc, #4aa8ff 50%)');
  assert.equal(normalizeGradient('linear-gradient(400deg, #111, #222)'), '');
  assert.equal(normalizeGradient('linear-gradient(90deg, #111 120%, #222)'), '');
  assert.match(nameHtml({ username: 'f', nameColor: g }), /style="background-image:linear-gradient/);
  assert.doesNotMatch(nameHtml({ username: 'f', nameColor: 'x" onclick="alert(1)' }), /onclick/);
});

test('every frame the app offers is one the hub accepts, and each has CSS', async () => {
  const fs = await import('node:fs');
  const { FRAME_IDS } = await import('../src/social/avatar.js');
  const hub = fs.readFileSync('/run/media/oliver/Drive/Scripts/recharge/recharge-hub/forum.js', 'utf8');
  const hubIds = [...hub.match(/const FRAMES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(FRAME_IDS, hubIds);
  assert.ok(FRAME_IDS.length >= 50, 'a ton of frames');
  const css = fs.readFileSync(new URL('../src/social/social.css', import.meta.url), 'utf8');
  for (const id of FRAME_IDS) assert.ok(css.includes('.frame-' + id + ' ') || css.includes('.frame-' + id + '::'), 'css for ' + id);
});

test('frame shapes take the chosen colours as CSS variables, and only #hex gets through', async () => {
  const { avatarHtml, frameVars, FRAME_PICKER, FRAME_IDS, frameColorCount } = await import('../src/social/avatar.js');
  assert.ok(FRAME_PICKER.every((f) => FRAME_IDS.includes(f.id)), 'every offered shape is a valid frame');
  assert.equal(frameColorCount('s-double'), 2);
  assert.equal(frameColorCount('g-rainbow'), 0);
  assert.equal(frameVars(['#41f88d', '#c63ed8']), ';--fc1:#41f88d;--fc2:#c63ed8');
  assert.equal(frameVars(['red', 'url(x)', '#12345']), '');
  assert.match(avatarHtml({ username: 'a', frame: 's-ring', frame_colors: ['#ff0000'] }), /--fc1:#ff0000/);
  assert.doesNotMatch(avatarHtml({ username: 'a', frame: 's-ring', frame_colors: ['#ff0000;background:url(x)'] }), /url\(/);
});

test('no CSS rule hides a button row: the forum Post / Reply / Save buttons sit in .cm-form-row', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/social/social.css', import.meta.url), 'utf8');
  for (const rule of css.split('}')) {
    if (!/display:\s*none/.test(rule)) continue;
    const sel = rule.split('{')[0];
    if (sel.includes('cm-form-row')) assert.match(sel, /:not\(:has\(button\)\)/, 'a rule hiding .cm-form-row must skip rows with buttons: ' + sel.trim());
  }
});
