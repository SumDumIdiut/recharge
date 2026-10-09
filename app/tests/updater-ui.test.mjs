// Headless logic test for the launcher banner + settings section (no browser): node tests/updater-ui.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

// Minimal DOM: elements with id, children, dataset, hidden, textContent, remove().
function makeDom() {
  const byId = new Map();
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this._text = ''; this.classList = { toggle() {}, add() {} }; }
    set id(v) { this._id = v; byId.set(v, this); }
    get id() { return this._id; }
    set textContent(v) { this._text = v; }
    get textContent() { return this._text; }
    set innerHTML(v) { this._text = v; }
    get firstChild() { return this.children[0]; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    remove() { if (this._id && byId.get(this._id) === this) byId.delete(this._id); if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    closest() { return new El('div'); }
  }
  const body = new El('body');
  const document = {
    body,
    createElement: (t) => new El(t),
    getElementById: (id) => byId.get(id) ?? null,
  };
  for (const id of ['launcher-managed', 'launcher-managed-status', 'launcher-restart-btn', 'launcher-update-btn', 'launcher-notes', 'launcher-repair-btn', 'launcher-status', 'channel-note', 'channel-stable-btn', 'channel-beta-btn', 'uninstall-managed', 'uninstall-manual', 'uninstall-btn', 'uninstall-note', 'uninstall-data', 'uninstall-restore']) {
    const e = new El('div'); e.id = id; byId.set(id, e);
  }
  return { document, byId };
}

function setup(info) {
  const { document, byId } = makeDom();
  const calls = [];
  const listeners = {};
  const invoke = async (cmd, args) => {
    calls.push(JSON.parse(JSON.stringify([cmd, args ?? null])));
    if (cmd === 'launcher_info') return info;
    if (cmd === 'launcher_check_now') return 12;
    if (cmd === 'launcher_update_failure') return info.failure ?? null;
    if (cmd === 'check_launcher_update') return { appUpdateAvailable: false, mapsUpdateAvailable: false, currentVersion: '3.0.12' };
    if (cmd === 'live_get_channel') return { channel: 'stable' };
    if (cmd === 'live_set_channel') return 'upToDate';
    return null;
  };
  const window = { __TAURI__: { core: { invoke }, event: { listen: (n, f) => { listeners[n] = f; } } } };
  const ctx = vm.createContext({ window, document, calls, fetch: async () => ({ ok: false }), setTimeout, Date, console });
  return { ctx, document, byId, calls, listeners, window };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// --- banner ---
{
  const t = setup({ managed: true, ready: 12, build: '10', channel: 'stable' });
  vm.runInContext(src('live-update.js').replace('const tauri = window.__TAURI__;', 'var tauri = window.__TAURI__;'), t.ctx);
  await tick();
  let b = t.document.getElementById('live-update-banner');
  assert.equal(b?.dataset.kind, 'launcher', 'staged update at load shows launcher banner');
  assert.equal(b.children[0].textContent, 'Update ready');
  t.listeners['live-updated']();
  assert.equal(t.document.getElementById('live-update-banner').dataset.kind, 'launcher', 'live banner does not replace it');
  b.children[1].onclick();
  await tick();
  assert.deepEqual(t.calls.find((c) => c[0] === 'launcher_restart'), ['launcher_restart', { repair: false }]);
  // live banner first, then launcher wins
  const u = setup({ managed: true, ready: null });
  vm.runInContext(src('live-update.js').replace('const tauri', 'var tauri'), u.ctx);
  await tick();
  u.listeners['live-updated']();
  assert.equal(u.document.getElementById('live-update-banner').dataset.kind, 'live');
  u.listeners['launcher-update-ready'](12);
  assert.equal(u.document.getElementById('live-update-banner').dataset.kind, 'launcher', 'launcher update wins');
  // unmanaged: nothing
  const n = setup({ managed: false, ready: null });
  vm.runInContext(src('live-update.js').replace('const tauri', 'var tauri'), n.ctx);
  await tick();
  assert.equal(n.document.getElementById('live-update-banner'), null);
}

// --- settings section ---
{
  const t = setup({ managed: true, ready: null, build: '10', version: '4.0.0-beta1', readyVersion: null, channel: 'beta' });
  const code = src('settings/script.js').replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(code, t.ctx);
  await vm.runInContext('refreshLauncherStatus()', t.ctx);
  assert.equal(t.byId.get('launcher-managed').hidden, false);
  assert.equal(t.byId.get('launcher-managed-status').textContent, 'Installed by the Recharge launcher');
  assert.equal(t.byId.get('launcher-restart-btn').hidden, true);
  assert.equal(t.byId.get('launcher-status').title, 'Build 10', 'CI build only in the tooltip');
  assert.ok(!t.byId.get('launcher-status').textContent.includes('10'));
  assert.equal(t.byId.get('launcher-status').textContent, 'Recharge 4.0.0-beta1 (Beta) - up to date', 'status reflects the launcher version + launcher channel');
  await t.window.__launcherCheck();
  assert.equal(t.byId.get('launcher-restart-btn').hidden, false, 'check that stages shows restart');
  await t.window.__setChannel('stable');
  const names = t.calls.map((c) => c[0]);
  assert.ok(names.includes('launcher_set_channel') && names.indexOf('launcher_set_channel') < names.indexOf('live_set_channel'));
  await t.window.__launcherRepair();
  assert.ok(!names.includes('launcher_restart') && !t.calls.some((c) => c[0] === 'launcher_restart'), 'first click only arms');
  await t.window.__launcherRepair();
  assert.deepEqual(t.calls.at(-1), ['launcher_restart', { repair: true }]);

  const u = setup({ managed: false });
  vm.runInContext(code, u.ctx);
  await vm.runInContext('refreshLauncherStatus()', u.ctx);
  assert.equal(u.byId.get('launcher-managed').hidden, true, 'hidden when not launcher-managed');
}
// --- version line variants + uninstall ---
{
  const t = setup({ managed: true });
  vm.runInContext(src('settings/script.js').replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, ''), t.ctx);
  const line = (i) => vm.runInContext(`managedVersionLine(${JSON.stringify(i)})`, t.ctx);
  assert.equal(line({ version: '4.0.0-beta1', channel: 'beta', ready: 12, readyVersion: '4.0.0-beta2', build: '11' }).text, 'Recharge 4.0.0-beta1 (Beta) - update ready: 4.0.0-beta2 - restart to apply');
  assert.equal(line({ version: '4.0.0', channel: 'stable' }).text, 'Recharge 4.0.0 (Stable) - up to date');
  assert.equal(line({ channel: 'stable', ready: 3 }).text, 'Recharge (Stable) - update ready - restart to apply');
  assert.match(vm.runInContext("manualUninstallText('Win32')", t.ctx), /Windows Settings/);
  assert.match(vm.runInContext("manualUninstallText('Linux x86_64')", t.ctx), /apt remove recharge/);

  // uninstall flow: first click arms, second asks (typed confirm), then the command carries both choices
  const asked = [];
  vm.runInContext('var confirmDestructive = async (o) => { __asked.push(o); return __answer; }', Object.assign(t.ctx, { __asked: asked, __answer: false }));
  t.byId.get('uninstall-btn').textContent = 'Uninstall Recharge';
  t.byId.get('uninstall-data').checked = true;
  await t.window.__uninstallRecharge();
  assert.ok(!t.calls.some((c) => c[0] === 'launcher_uninstall') && asked.length === 0, 'first click only arms');
  await t.window.__uninstallRecharge();
  assert.equal(asked.length, 1);
  assert.match(asked[0].body, /settings, mods, skins and map saves will be deleted/);
  assert.match(asked[0].body, /RechargeLoader stays/);
  assert.ok(!t.calls.some((c) => c[0] === 'launcher_uninstall'), 'declined: nothing happens');
  t.ctx.__answer = true;
  t.byId.get('uninstall-restore').checked = true;
  await t.window.__uninstallRecharge();
  await t.window.__uninstallRecharge();
  assert.deepEqual(t.calls.find((c) => c[0] === 'launcher_uninstall'), ['launcher_uninstall', { deleteData: true, restoreGame: true }]);
}
// --- failed restart is shown with Try again / Open log ---
{
  const t = setup({ managed: true, ready: 12, build: '10', failure: 'app -> app.old: Access denied' });
  vm.runInContext(src('live-update.js').replace('const tauri', 'var tauri'), t.ctx);
  await tick();
  const b = t.document.getElementById('live-update-banner');
  assert.equal(b.dataset.kind, 'failed', 'failure wins over the ready banner');
  assert.match(b.children[0].textContent, /^Update didn't apply - app -> app.old: Access denied/);
  assert.deepEqual(b.children.slice(1).map((c) => c.textContent), ['Try again', 'Open log', 'Dismiss']);
  b.children[2].onclick();
  b.children[1].onclick();
  await tick();
  assert.ok(t.calls.some((c) => c[0] === 'launcher_restart') && t.calls.some((c) => c[0] === 'launcher_open_log'));
  t.listeners['launcher-update-ready'](12);
  assert.equal(t.document.getElementById('live-update-banner').dataset.kind, 'failed', 'ready event does not hide the failure');
}
// --- channel selector follows the launcher ---
{
  const t = setup({ managed: true, channel: 'beta' });
  const code = src('settings/script.js').replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(code, t.ctx);
  assert.equal(vm.runInContext("shownChannel('stable', { managed: true, channel: 'beta' })", t.ctx), 'beta', 'launcher channel wins when managed');
  assert.equal(vm.runInContext("shownChannel('stable', { managed: false, channel: 'beta' })", t.ctx), 'stable');
  assert.equal(vm.runInContext("shownChannel('beta', null)", t.ctx), 'beta');
  assert.equal(vm.runInContext("shownChannel('beta', { managed: true, channel: '' })", t.ctx), 'beta');
}
console.log('updater-ui: all checks passed');
