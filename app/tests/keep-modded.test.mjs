// Home: "Keep the game modded after closing" (localStorage keep-game-modded, default on) gates the automatic restore_vanilla_build (mocked invoke).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../src/home.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');

function stubEl() {
  const f = function () {};
  const p = new Proxy(f, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === 'querySelectorAll' ? () => [] : k in t ? t[k] : stubEl()),
    set: () => true,
    apply: () => stubEl(),
  });
  return p;
}

function setup({ keep, running = false }) {
  const calls = [];
  const logs = [];
  let isRunning = running;
  const invoke = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'is_game_running') return isRunning;
    if (cmd === 'launch_game') return 'direct';
    if (cmd === 'check_launcher_update') return {};
    if (cmd === 'loader_status') return { installed: true, version: '1', outdated: false };
    if (cmd === 'list_installed_mods') return [];
    if (cmd === 'detect_all_igtap_installs') return [];
    return null;
  };
  const store = keep === undefined ? {} : { 'keep-game-modded': keep };
  const logEl = { prepend: (l) => logs.push(l.innerHTML) };
  const document = {
    getElementById: (id) => (id === 'home-log' ? logEl : stubEl()),
    querySelectorAll: () => [],
    querySelector: () => stubEl(),
    createElement: () => ({ set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } }),
  };
  const window = { __TAURI__: { core: { invoke }, event: { listen() {} } } };
  const ctx = vm.createContext({
    window, document, console, Date, setTimeout: () => 1, clearTimeout() {}, clearInterval, setInterval: () => 1, requestAnimationFrame() {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem(k, v) { store[k] = v; } },
  });
  vm.runInContext(
    'var applyRandomBackground=()=>{},getWaveSettings=()=>({}),initHomeNews=()=>{},layoutNews=()=>{},renderInstallList=async()=>{},isLoggedIn=()=>false,getUsername=()=>"",isAdmin=()=>false,setSession=()=>{},refreshSession=async()=>{},sessionExpired=()=>false,clearExpiredNote=()=>{},EXPIRED_MESSAGE="";'
      + code + ';var __poll=checkRunning;var __init=initHome;var __setSeen=()=>{seenRunning=true};',
    ctx,
  );
  return { calls, logs, window, ctx, stop: () => { isRunning = false; } };
}
const restores = (t) => t.calls.filter((c) => c === 'restore_vanilla_build').length;

for (const [keep, expectRestore] of [[undefined, 0], ['1', 0], ['0', 1]]) {
  // modded session ends
  const t = setup({ keep, running: true });
  await t.window.__homeLaunch('modded');
  t.ctx.__setSeen();
  t.stop();
  await t.ctx.__poll();
  assert.equal(restores(t), expectRestore, `exit keep=${keep}`);
  if (!expectRestore) assert.ok(t.logs.some((l) => l.includes('keeping the game modded')));
}

for (const [keep, expectRestore] of [[undefined, 0], ['0', 1]]) {
  // Home init with the game closed
  const t = setup({ keep });
  await t.ctx.__init().catch((e) => console.log("init err", e));
  assert.equal(restores(t), expectRestore, `init keep=${keep}`);
}

// Vanilla launch never relies on the automatic restore: launch_game({modded:false}) deploys vanilla itself (play.rs), even with keep on.
{
  const t = setup({ keep: '1' });
  let args;
  t.window.__TAURI__.core.invoke = async (c, a) => { if (c === 'launch_game') args = a; return 'direct'; };
  await t.window.__homeLaunch('vanilla');
  assert.deepEqual({ ...args }, { modded: false });
}
console.log('ok');
