// Settings > RechargeLoader: "IGTAP is running - Close game and install" flow (mocked invoke): node tests/loader-close.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../src/settings/script.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');

function setup(installResults) {
  const els = {};
  const el = (id) => (els[id] ??= { id, hidden: id.includes('close') || id === 'loader-progress-track', disabled: false, textContent: '', style: {}, dataset: {}, classList: { toggle() {}, add() {} }, appendChild() {} });
  const document = { getElementById: el, createElement: () => el('x' + Math.random()), body: el('body') };
  const calls = [];
  const invoke = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'install_or_update_loader') {
      const r = installResults.shift();
      if (r instanceof Error || typeof r === 'string') throw r;
      return null;
    }
    if (cmd === 'loader_status') return { installed: true, version: '1.0.0', outdated: false };
    if (cmd === 'get_game_path') return '/g';
    return null;
  };
  const window = { __TAURI__: { core: { invoke }, event: { listen() {} } } };
  const ctx = vm.createContext({ window, document, calls, console, setTimeout, Date, localStorage: { getItem() {}, setItem() {} } });
  vm.runInContext('var renderInstallList = async () => {}; var confirmDestructive = async () => true; var runMigrate = () => {};' + code, ctx);
  return { els, calls, window };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// 1. install fails because the game runs -> close button appears, message has no raw prefix
{
  const t = setup(['IGTAP_RUNNING: IGTAP is running - close the game before installing.']);
  await t.window.__loaderInstall();
  assert.equal(t.els['loader-close-install-btn'].hidden, false);
  assert.equal(t.els['loader-progress'].textContent, 'IGTAP is running - close the game before installing.');
  assert.equal(t.els['loader-install-btn'].disabled, false);

  // 2. the button closes the game, waits, then retries the install (which now succeeds)
  t.calls.length = 0;
  t.window.__TAURI__.core.invoke('x');
  await t.window.__loaderCloseAndInstall();
  await tick();
  const seq = t.calls.filter((c) => c === 'close_game_and_wait' || c === 'install_or_update_loader');
  assert.deepEqual(seq, ['close_game_and_wait', 'install_or_update_loader']);
  assert.equal(t.els['loader-close-install-btn'].hidden, true);
  assert.equal(t.els['loader-progress'].textContent, 'Done.');
}

// 3. closing fails -> no install attempt, error shown, button stays usable
{
  const t = setup([]);
  t.els['loader-close-install-btn'] = { hidden: false, disabled: false, textContent: '' };
  t.window.__TAURI__.core.invoke = async (cmd) => { t.calls.push(cmd); if (cmd === 'close_game_and_wait') throw 'The running game wouldn\'t close'; return null; };
  await t.window.__loaderCloseAndInstall();
  assert.ok(!t.calls.includes('install_or_update_loader'));
  assert.match(t.els['loader-progress'].textContent, /wouldn't close/);
  assert.equal(t.els['loader-close-install-btn'].disabled, false);
}

// 4. other errors show as-is with no close button
{
  const t = setup(['Failed: some other problem']);
  await t.window.__loaderInstall();
  assert.equal(t.els['loader-close-install-btn'].hidden, true);
  assert.equal(t.els['loader-progress'].textContent, 'Failed: some other problem');
}
console.log('loader-close ok');
