// Downloaded maps, mods and skins follow their Hub entry: when the hub holds a newer revision of something installed, it is reinstalled in place
// (the install keeps the same folder). Runs when Maps / Mods / Skins load and once at startup. Never while the game is running (it is queued and done
// after the game closes), one install at a time, and a failure is logged and not retried until Recharge restarts.
import { HUB_BASE } from './hub.js';

export const SETTING_KEY = 'autoUpdateContent';
const KINDS = ['maps', 'mods', 'skins'];
// Mods that are pulled from their repo and built by the loader, not installed from a Hub package.
const REPO_MOD_IDS = new Set(['recharge.maps', 'recharge.customskins', 'recharge.example', 'recharge.multiplayer']);

export function autoUpdateEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(SETTING_KEY) !== '0'; } catch { return true; }
}

export function setAutoUpdate(on, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTING_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

function isNewerVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

// Is the hub's copy newer than the installed one? Revisions decide; with equal revisions the hub's later update time does.
// An install from before revisions existed counts as revision 1.
export function isNewerRevision(installed, hub) {
  const ir = Number.isFinite(installed?.revision) ? installed.revision : 1;
  const hr = Number.isFinite(hub?.revision) ? hub.revision : 1;
  if (hr !== ir) return hr > ir;
  const iu = Date.parse(installed?.updatedAt), hu = Date.parse(hub?.updatedAt);
  return Number.isFinite(iu) && Number.isFinite(hu) && hu > iu;
}

// What needs updating: [{ kind, id (hub id), name }] from the installed list (as the Rust list commands return it) and the hub catalog (rows with id, name, revision, updatedAt).
export function pendingUpdates(kind, installed, catalog) {
  const byId = new Map((catalog || []).map((c) => [c.id, c]));
  const out = [];
  for (const item of installed || []) {
    let entry = null, newer = false;
    if (kind === 'maps') {
      entry = item.hub ? byId.get(item.hub) : null;
      newer = !!entry && isNewerRevision(item, entry);
    } else if (kind === 'skins') {
      entry = item.hubId ? byId.get(item.hubId) : null;
      newer = !!entry && isNewerRevision(item, entry);
    } else if (kind === 'mods') {
      if (REPO_MOD_IDS.has(item.id)) continue;
      if (item.hubId) {
        entry = byId.get(item.hubId);
        newer = !!entry && isNewerRevision(item, entry);
      } else {
        // Installed before the hub entry was recorded: the mod's own version tells.
        entry = (catalog || []).find((c) => c.modId === item.id);
        newer = !!entry && isNewerVersion(entry.version, item.version);
      }
    }
    if (entry && newer) out.push({ kind, id: entry.id, name: entry.name });
  }
  return out;
}

// The queue. `deps`: invoke(cmd, args), isGameRunning(), notify(html), enabled(), log(msg), setTimer(fn, ms).
export function createUpdater(deps) {
  const queue = [];
  const failed = new Set();
  const refreshers = {};
  let running = null;
  let timer = null;
  const key = (u) => u.kind + ':' + u.id;
  const log = (m) => { try { deps.log?.(m); } catch { /* logging must never break updating */ } };

  async function run() {
    while (queue.length) {
      if (!deps.enabled()) { queue.length = 0; return; }
      let busy = true;
      try { busy = await deps.isGameRunning(); } catch { /* unknown: wait */ }
      if (busy) { retryLater(); return; }
      const u = queue.shift();
      try {
        await deps.invoke('install_from_hub_cmd', { kind: u.kind, id: u.id, quiet: true });
        deps.notify(`Updated <strong>${escape(u.name)}</strong>`);
        try { await refreshers[u.kind]?.(); } catch (e) { log(`refresh after updating ${u.name} failed: ${e}`); }
      } catch (err) {
        failed.add(key(u));
        log(`auto-update of ${u.kind} ${u.name} failed: ${err}`);
      }
    }
  }

  function retryLater() {
    if (timer) return;
    timer = deps.setTimer(() => { timer = null; kick(); }, deps.retryMs ?? 30000);
  }

  function kick() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  return {
    // Adds what isn't already queued or failed, then works through the queue. `refresh` redraws that kind's tab after each install.
    request(updates, refresh) {
      if (!deps.enabled()) return Promise.resolve();
      if (refresh && updates[0]) refreshers[updates[0].kind] = refresh;
      for (const u of updates) {
        if (!failed.has(key(u)) && !queue.some((q) => key(q) === key(u))) queue.push(u);
      }
      return queue.length ? kick() : (running || Promise.resolve());
    },
    queued: () => queue.map(key),
    failedKeys: () => [...failed],
    idle: () => running || Promise.resolve(),
  };
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let shared = null;
export function sharedUpdater() {
  if (!shared) {
    shared = createUpdater({
      invoke: (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
      isGameRunning: () => window.__TAURI__.core.invoke('is_game_running'),
      notify: (html) => window.__showToast?.(html),
      enabled: () => autoUpdateEnabled(),
      log: (m) => console.warn('[auto-update]', m),
      setTimer: (fn, ms) => setTimeout(fn, ms),
    });
  }
  return shared;
}

// Called by Maps / Mods / Skins once their catalog and installed list are loaded.
export function checkTab(kind, installed, catalog, refresh) {
  if (!autoUpdateEnabled()) return Promise.resolve();
  const updates = pendingUpdates(kind, installed, catalog);
  return updates.length ? sharedUpdater().request(updates, refresh) : Promise.resolve();
}

// Once at startup, after the hub lists arrive: looks at all three kinds without opening their tabs.
export async function startupCheck(refreshTab) {
  if (!autoUpdateEnabled()) return;
  const { invoke } = window.__TAURI__.core;
  const installedOf = { maps: () => invoke('list_maps'), mods: () => invoke('list_installed_mods'), skins: () => invoke('list_installed_skins') };
  for (const kind of KINDS) {
    try {
      const res = await fetch(`${HUB_BASE}/api/${kind}`);
      if (!res.ok) continue;
      const rows = await res.json();
      const catalog = rows.map((r) => ({ id: r.id, name: r.name, modId: r.modId || null, version: r.version, revision: r.revision, updatedAt: r.updatedAt }));
      const installed = (await installedOf[kind]()).filter((m) => m.id !== 'map-maker-test');
      await checkTab(kind, installed, catalog, () => refreshTab?.(kind));
    } catch (e) {
      console.warn('[auto-update] startup check for', kind, 'failed:', e);
    }
  }
}
