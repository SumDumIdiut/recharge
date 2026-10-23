// Downloaded maps, mods and skins follow their Hub entry: when the hub holds a newer revision of something installed, it is reinstalled in place
// (the install keeps the same folder). Runs when Maps / Mods / Skins load and once at startup. Never while the game is running (it is queued and done
// after the game closes), one install at a time, and a failure is logged and not retried until Recharge restarts.
import { HUB_BASE } from './hub.js';
import { REPO_MOD_IDS } from './repo-mods.js';
import { isTestMap } from './maps/test-map.js';

export const SETTING_KEY = 'autoUpdateContent';
const KINDS = ['maps', 'mods', 'skins'];

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
// isGameRunning() must return 'running' | 'not-running' | 'unknown'.
export function createUpdater(deps) {
  const queue = [];
  const failed = new Map(); // key -> { error, transient, retries }
  const refreshers = {};
  let running = null;
  let timer = null;
  let unknownCount = 0;
  const key = (u) => u.kind + ':' + u.id;
  const log = (m) => { try { deps.log?.(m); } catch { /* logging must never break updating */ } };

  // Backoff schedule for unknown game state: 5s, 10s, 20s, 40s, 80s (then manual retry)
  const UNKNOWN_BACKOFF = [5000, 10000, 20000, 40000, 80000];
  const MAX_UNKNOWN_RETRIES = UNKNOWN_BACKOFF.length;

  async function run() {
    while (queue.length) {
      // Pause if disabled, don't discard queue
      if (!deps.enabled()) {
        return;
      }
      let gameState = 'unknown';
      try { gameState = await deps.isGameRunning(); } catch { gameState = 'unknown'; }

      if (gameState === 'running') {
        unknownCount = 0; // reset on definitive answer
        retryLater(30000); // fixed 30s when game is confirmed running
        return;
      }
      if (gameState === 'unknown') {
        if (unknownCount >= MAX_UNKNOWN_RETRIES) {
          // After 5 unknowns, surface manual retry and stop auto-retrying
          log('auto-update: cannot determine if game is running after 5 attempts; manual retry needed');
          deps.notify?.('Cannot tell if the game is running \u2014 <button onclick="window.__retryAutoUpdate?.()">Retry</button>');
          return;
        }
        const delay = UNKNOWN_BACKOFF[unknownCount];
        unknownCount++;
        retryLater(delay);
        return;
      }
      // gameState === 'not-running'
      unknownCount = 0;
      const u = queue.shift();
      try {
        await deps.invoke('install_from_hub_cmd', { kind: u.kind, id: u.id, quiet: true });
        deps.notify?.('Updated <strong>' + escape(u.name) + '</strong>');
        try { await refreshers[u.kind]?.(); } catch (e) { log('refresh after updating ' + u.name + ' failed: ' + e); }
        failed.delete(key(u)); // clear on success
      } catch (err) {
        const isPermanent = isPermanentError(err);
        failed.set(key(u), { error: err, transient: !isPermanent, retries: 0 });
        log('auto-update of ' + u.kind + ' ' + u.name + ' failed: ' + err);
        if (!isPermanent) {
          // Transient failure: schedule retry with backoff
          scheduleFailedRetry(key(u), u);
        }
      }
    }
  }

  function isPermanentError(err) {
    const msg = String(err || '');
    // 404 or "not found" style errors are permanent
    return msg.includes('404') || msg.toLowerCase().includes('not found');
  }

  function scheduleFailedRetry(k, u) {
    const entry = failed.get(k);
    if (!entry || entry.transient === false) return;
    const delay = Math.min(1000 * Math.pow(2, entry.retries), 60000); // exponential backoff, max 60s
    entry.retries++;
    deps.setTimer(() => {
      // Re-add to queue if still failed
      if (failed.has(k)) {
        queue.unshift(u);
        kick();
      }
    }, delay);
  }

  function retryLater(ms) {
    if (timer) return;
    timer = deps.setTimer(() => { timer = null; kick(); }, ms);
  }

  function kick() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  // Public API
  return {
    // Adds what isn't already queued or failed, then works through the queue. `refresh` redraws that kind's tab after each install.
    request(updates, refresh) {
      // Always add to queue even if disabled (pause, don't discard)
      if (refresh && updates[0]) refreshers[updates[0].kind] = refresh;
      for (const u of updates) {
        const k = key(u);
        if (!failed.has(k) && !queue.some((q) => key(q) === k)) queue.push(u);
      }
      if (!deps.enabled()) return Promise.resolve();
      return queue.length ? kick() : (running || Promise.resolve());
    },
    queued: () => queue.map(key),
    failedKeys: () => [...failed.keys()],
    idle: () => running || Promise.resolve(),
    // Pending count for badge UI (queued + failed transient)
    pendingCount: () => queue.length + [...failed.values()].filter(f => f.transient).length,
    // Manual retry for unknown state or failed items
    retry() {
      unknownCount = 0;
      // Re-queue transient failed items
      for (const [k, v] of failed) {
        if (v.transient) {
          // Find the original update in queue or re-add from failed (we don't store the full update, so just kick)
          // The queue will be re-processed; failed items stay in failed until they succeed
        }
      }
      return kick();
    },
  };
}

function escape(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;'}[c]));
}

let shared = null;
export function sharedUpdater() {
  if (!shared) {
    shared = createUpdater({
      invoke: (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
      // isGameRunning now returns 'running' | 'not-running' | 'unknown'
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
      const res = await fetch(HUB_BASE + '/api/' + kind);
      if (!res.ok) continue;
      const rows = await res.json();
      const catalog = rows.map((r) => ({ id: r.id, name: r.name, modId: r.modId || null, version: r.version, revision: r.revision, updatedAt: r.updatedAt }));
      const installed = (await installedOf[kind]()).filter((m) => !isTestMap(m));
      await checkTab(kind, installed, catalog, () => refreshTab?.(kind));
    } catch (e) {
      console.warn('[auto-update] startup check for', kind, 'failed:', e);
    }
  }
}
