// Every place the app shows a username, the name is in that user's chosen colour.
// The rule is easy to state and easy to break: a new plain-text render of a name is one
// escapeHtml(r.username) away, and nothing else would notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { nameTextHtml, nameHtml } from '../src/social/avatar.js';

const SRC = new URL('../src/', import.meta.url);
const COLOUR = 'linear-gradient(90deg, #41f88d, #4aa8ff)';

test('a plain name carries its colour, in either field spelling', () => {
  const solid = nameTextHtml({ username: 'Flipped', name_color: '#4aa8ff' });
  assert.match(solid, /style="color:#4aa8ff"/);
  assert.match(solid, /Flipped/);
  // Normalised rows use the camelCase name.
  assert.match(nameTextHtml({ username: 'Flipped', nameColor: '#4aa8ff' }), /style="color:#4aa8ff"/);
  // A gradient name clips its own background to the text.
  assert.match(nameTextHtml({ username: 'Flipped', name_color: COLOUR }), /background-clip:text/);
  // No colour set: no style attribute at all, and the name still renders.
  assert.ok(!/style=/.test(nameTextHtml({ username: 'Aki' })));
  assert.match(nameTextHtml({ username: 'Aki' }), /Aki/);
});

test('a plain name is escaped, and a bare string still works', () => {
  const evil = '<img src=x onerror=alert(1)>';
  assert.ok(!/<img src=x/.test(nameTextHtml({ username: evil, name_color: '#4aa8ff' })));
  assert.match(nameTextHtml('Grill'), /Grill/);
  assert.match(nameTextHtml(null), /<span class="user-name-plain[^"]*"><\/span>/);
});

test('a name colour cannot smuggle in a style or an attribute', () => {
  // nameStyle only emits a colour or a validated gradient, so hostile input is dropped whole
  // rather than escaped - which would still be wrong if it were ever interpolated unescaped.
  const hostile = 'red;} body{display:none';
  assert.ok(!/style=/.test(nameTextHtml({ username: 'x', name_color: hostile })));
  assert.ok(!/<script/.test(nameTextHtml({ username: '<script>alert(1)</script>' })));
});

test('the clickable name is coloured the same way', () => {
  assert.match(nameHtml({ username: 'Flipped', nameColor: '#4aa8ff' }), /style="color:#4aa8ff"/);
  assert.match(nameHtml({ username: 'Flipped', nameColor: '#4aa8ff' }), /data-user="Flipped"/);
});

// Every source file, so a renderer added later is covered without editing this list.
function* sources(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) { if (e.name !== 'tests') yield* sources(p); }
    else if (e.name.endsWith('.js')) yield p;
  }
}

test('no file renders a username as escaped plain text', () => {
  // The pattern that skipped the colour: escapeHtml(...) straight onto a username, with no
  // nameHtml/nameTextHtml and no colour helper anywhere near it.
  const offenders = [];
  const re = /escapeHtml\((?:[^)]*\.)?(?:username|author)\b[^)]*\)/g;
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;         // prose about names, not markup
      // data-* attributes are an id for the click handler, not a name anyone sees.
      if (/data-user|data-player|nameHtml|nameTextHtml|uploaderHtml/.test(line)) continue;
      if (re.test(line)) offenders.push(`${file.pathname}: ${line.trim()}`);
      re.lastIndex = 0;
    }
  }
  assert.deepEqual(offenders, [], `names rendered without their colour:\n${offenders.join('\n')}`);
});

test('the hub sends a colour with every listed name', () => {
  const hub = readFileSync(new URL('../../../recharge-hub/forum.js', import.meta.url), 'utf8');
  // Names come back with a colour to draw them in: every author object, and every directory row,
  // is built from userJson.
  assert.match(hub, /name_color: u\.name_color \|\| null/);
});
