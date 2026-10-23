// Every module a tab loads must have resolvable named imports. A wrong module in an import
// is a *link* error in ES modules: the whole file silently fails to load, so nothing on the
// page is wired up and the page just sits there. It type-checks fine and passes every
// behavioural test, because those import the helpers directly rather than through the page.
//
// This happened for real: the moderator chat imported escapeHtml from social/avatar.js,
// which does not export it (avatar.js imports escapeHtml from ui.js). The page rendered and
// looked right, and no message could ever be sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const el = () => ({
  style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, addEventListener() {}, querySelector: () => null,
  querySelectorAll: () => [], setAttribute() {}, focus() {}, remove() {},
  value: '', textContent: '', innerHTML: '',
});

function stubBrowser() {
  globalThis.window = { addEventListener() {}, location: { href: '' }, navigate() {}, __TAURI__: {} };
  globalThis.document = {
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: () => null, createElement: el, body: el(),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
}

// Every module under src/, found by walking the tree, so a module added after this test was
// written is covered too. A hand-kept list is exactly how account/deco.js stayed broken.
function* allModules(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) { if (e.name !== 'tests') yield* allModules(p); }
    else if (e.name.endsWith('.js')) yield (e.isDirectory() ? '' : '') + p.pathname.replace(SRC.pathname, '').replace(/\.js$/, '');
  }
}

const SRC = new URL('../src/', import.meta.url);
const MODULES = [...allModules(SRC)].sort();

test('the walk actually found the modules it is meant to check', () => {
  // A walk that silently matched nothing would make the test below pass for the wrong reason.
  assert.ok(MODULES.length > 20, `only found ${MODULES.length} modules`);
  for (const expected of ['maps/script', 'account/deco', 'social/validate', 'moderators/script']) {
    assert.ok(MODULES.includes(expected), `walk missed ${expected}`);
  }
});

test('every module links - no import names a module does not export', async () => {
  stubBrowser();
  const broken = [];
  for (const m of MODULES) {
    try {
      await import(`../src/${m}.js`);
    } catch (e) {
      const msg = String(e?.message || '');
      // A missing `window`/`document` is just node not being a browser: the imports
      // resolved, which is all this test is about. Only export/module errors are defects.
      // Two real link errors: a name that is not exported, and a relative path that is not
      // there. An import('/home-news.js') is an absolute path served by the app's own web
      // server, which node has no idea about - not a broken import.
      const missing = /Cannot find module '([^']+)'/.exec(msg);
      const appAbsolute = missing && missing[1].startsWith('/') && !missing[1].startsWith(SRC.pathname);
      if (/export named/.test(msg) || (missing && !appAbsolute)) broken.push(`${m}: ${msg}`);
    }
  }
  assert.deepEqual(broken, [], `modules that failed to link:\n${broken.join('\n')}`);
});

test('a module that does not export an imported name is detected', async () => {
  // Guard the guard: if this file could not tell a link error from a runtime one, the test
  // above would pass no matter how many modules were broken.
  const src = readFileSync(new URL('../src/social/avatar.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ escapeHtml \} from '\.\.\/ui\.js'/);
  assert.ok(!/export .*\bescapeHtml\b/.test(src), 'avatar.js imports escapeHtml, it does not export it');
  assert.match(src, /export function avatarHtml/);
});
