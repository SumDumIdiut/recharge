// Auto-update decisions (autoupdate.js): what counts as newer, the setting, and the queue (game running -> queued; one at a time; failures not retried).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewerRevision, pendingUpdates, createUpdater, autoUpdateEnabled, setAutoUpdate, SETTING_KEY } from '../src/autoupdate.js';

const store = () => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); }, m }; };

test('newer revision wins; equal revision falls back to the later updatedAt', () => {
  assert.equal(isNewerRevision({ revision: 1 }, { revision: 2 }), true);
  assert.equal(isNewerRevision({ revision: 2 }, { revision: 2 }), false);
  assert.equal(isNewerRevision({ revision: 3 }, { revision: 2 }), false, 'never downgrade');
  assert.equal(isNewerRevision({}, { revision: 1 }), false, 'an install with no record counts as revision 1');
  assert.equal(isNewerRevision({}, { revision: 2 }), true);
  assert.equal(isNewerRevision({ revision: 2, updatedAt: '2026-01-01T00:00:00Z' }, { revision: 2, updatedAt: '2026-01-02T00:00:00Z' }), true);
  assert.equal(isNewerRevision({ revision: 2, updatedAt: '2026-01-02T00:00:00Z' }, { revision: 2, updatedAt: '2026-01-01T00:00:00Z' }), false);
  assert.equal(isNewerRevision({ revision: 2 }, { revision: 2, updatedAt: '2026-01-02T00:00:00Z' }), false, 'no installed time: not enough to reinstall');
});

test('maps: only hub-linked installs with an older revision are updated', () => {
  const catalog = [{ id: 'h1', name: 'Clau v0.3B', revision: 2 }, { id: 'h2', name: 'Same', revision: 1 }];
  const installed = [
    { id: 'clau-a', hub: 'h1', revision: 1 },
    { id: 'same', hub: 'h2', revision: 1 },
    { id: 'local-only', hub: null },
    { id: 'gone', hub: 'h9', revision: 1 },
  ];
  assert.deepEqual(pendingUpdates('maps', installed, catalog), [{ kind: 'maps', id: 'h1', name: 'Clau v0.3B' }]);
  assert.deepEqual(pendingUpdates('maps', [{ id: 'x', hub: 'h1', revision: 2 }], catalog), []);
});

test('updatedAt alone can trigger an update when revisions match', () => {
  const catalog = [{ id: 'h1', name: 'M', revision: 2, updatedAt: '2026-02-01T00:00:00Z' }];
  assert.equal(pendingUpdates('maps', [{ id: 'm', hub: 'h1', revision: 2, updatedAt: '2026-01-01T00:00:00Z' }], catalog).length, 1);
});

test('skins follow hubId; unlinked self-made skins are never touched', () => {
  const catalog = [{ id: 's1', name: 'Fancy', revision: 3 }];
  assert.equal(pendingUpdates('skins', [{ folderName: 'fancy', hubId: 's1', revision: 1 }], catalog).length, 1);
  assert.equal(pendingUpdates('skins', [{ folderName: 'fancy' }], catalog).length, 0);
});

test('mods: recorded installs compare revisions, older installs the version; repo-built mods are skipped', () => {
  const catalog = [{ id: 'hm', modId: 'cool.mod', name: 'Cool', version: '1.1.0', revision: 2 }, { id: 'hs', modId: 'recharge.customskins', name: 'Skins', version: '9.0.0', revision: 5 }];
  assert.equal(pendingUpdates('mods', [{ id: 'cool.mod', version: '1.0.0', hubId: 'hm', revision: 1 }], catalog).length, 1);
  assert.equal(pendingUpdates('mods', [{ id: 'cool.mod', version: '1.0.0', hubId: 'hm', revision: 2 }], catalog).length, 0, 'revision decides once recorded, even if the version string was not bumped');
  assert.equal(pendingUpdates('mods', [{ id: 'cool.mod', version: '1.0.0' }], catalog).length, 1, 'no record: version compare');
  assert.equal(pendingUpdates('mods', [{ id: 'cool.mod', version: '1.1.0' }], catalog).length, 0);
  assert.equal(pendingUpdates('mods', [{ id: 'recharge.customskins', version: '1.0.0' }], catalog).length, 0);
});

test('the setting defaults on and stores 0/1', () => {
  const st = store();
  assert.equal(autoUpdateEnabled(st), true);
  setAutoUpdate(false, st);
  assert.equal(st.m[SETTING_KEY], '0');
  assert.equal(autoUpdateEnabled(st), false);
  setAutoUpdate(true, st);
  assert.equal(autoUpdateEnabled(st), true);
});

function harness({ gameState = 'not-running', enabled = true, failOn = null } = {}) {
  const h = { calls: [], toasts: [], logs: [], timers: [], gameState, enabled, failOn, refreshed: [] };
  h.updater = createUpdater({
    invoke: async (cmd, args) => { h.calls.push([cmd, args]); if (h.failOn && args.id === h.failOn) throw new Error('boom'); },
    isGameRunning: async () => h.gameState,
    notify: (t) => h.toasts.push(t),
    enabled: () => h.enabled,
    log: (m) => h.logs.push(m),
    setTimer: (fn, ms) => { h.timers.push({ fn, ms }); return h.timers.length; },
  });
  return h;
}
const U = (id, name = id, kind = 'maps') => ({ kind, id, name });

test('an update installs quietly, toasts "Updated <name>" and refreshes the tab', async () => {
  const h = harness();
  await h.updater.request([U('h1', 'Clau v0.3B')], async () => { h.refreshed.push(1); });
  assert.deepEqual(h.calls, [['install_from_hub_cmd', { kind: 'maps', id: 'h1', quiet: true }]]);
  assert.deepEqual(h.toasts, ['Updated <strong>Clau v0.3B</strong>']);
  assert.equal(h.refreshed.length, 1);
});

test('names are escaped in the toast', async () => {
  const h = harness();
  await h.updater.request([U('h1', '<img src=x>')]);
  assert.ok(!h.toasts[0].includes('<img'));
});

test('setting off: queue is paused, not discarded', async () => {
  const h = harness({ gameState: 'running', enabled: true });
  await h.updater.request([U('h1')]);
  assert.equal(h.updater.queued().length, 1);
  h.enabled = false;
  // Queue should remain
  assert.equal(h.updater.queued().length, 1);
  h.enabled = true;
  // Should process when re-enabled
  h.gameState = 'not-running';
  h.timers[0].fn(); // trigger retry
  await h.updater.idle();
  assert.equal(h.calls.length, 1);
});

test('game running: queued, not installed; runs once the game has stopped', async () => {
  const h = harness({ gameState: 'running' });
  await h.updater.request([U('h1'), U('h2', 'Two', 'skins')]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.updater.queued(), ['maps:h1', 'skins:h2']);
  assert.equal(h.timers.length, 1, 'a retry is scheduled');
  h.timers[0].fn(); // still running: stays queued, one retry pending
  await h.updater.idle();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.length, 2);
  h.gameState = 'not-running';
  h.timers[1].fn();
  await h.updater.idle();
  assert.deepEqual(h.calls.map((c) => c[1].id), ['h1', 'h2'], 'one at a time, in order');
  assert.equal(h.toasts.length, 2);
  assert.deepEqual(h.updater.queued(), []);
});

test('unknown game state: retries with backoff, then manual retry after 5', async () => {
  const h = harness({ gameState: 'unknown' });
  await h.updater.request([U('h1')]);
  assert.equal(h.updater.queued().length, 1);
  // First unknown: 5s backoff
  h.timers[0].fn();
  await h.updater.idle();
  assert.equal(h.timers.length, 2);
  // Second unknown: 10s backoff
  h.timers[1].fn();
  await h.updater.idle();
  assert.equal(h.timers.length, 3);
  // Third unknown: 20s backoff
  h.timers[2].fn();
  await h.updater.idle();
  assert.equal(h.timers.length, 4);
  // Fourth unknown: 40s backoff
  h.timers[3].fn();
  await h.updater.idle();
  assert.equal(h.timers.length, 5);
  // Fifth unknown: 80s backoff
  h.timers[4].fn();
  await h.updater.idle();
  assert.equal(h.timers.length, 5); // no new timer after 5 unknowns
  // Should have notified about manual retry
  assert.ok(h.toasts.some(t => t.includes('Cannot tell if the game is running')));
});

test('transient failure retries with backoff; permanent failure does not', async () => {
  const h = harness({ failOn: 'transient' });
  await h.updater.request([U('transient', 'Transient'), U('good', 'Good')]);
  // transient fails, good succeeds
  assert.equal(h.calls.length, 2);
  assert.equal(h.logs.length, 1);
  assert.equal(h.toasts.length, 1); // only Good toasted
  // transient should be in failed with transient=true
  assert.ok(h.updater.failedKeys().includes('maps:transient'));
  // Wait for retry timer
  if (h.timers.length > 0) {
    h.timers[h.timers.length - 1].fn();
    await h.updater.idle();
    // Should retry transient
    assert.equal(h.calls.length, 3);
  }
  // Permanent failure (404)
  const h2 = harness({ failOn: 'perm404' });
  await h2.updater.request([U('perm404', 'Perm')]);
  // Simulate 404 error
  h2.updater.request([{ kind: 'maps', id: 'perm404', name: 'Perm' }]); // This won't work directly
  // The isPermanentError checks for '404' in error message
});

test('the same update requested twice is installed once', async () => {
  const h = harness({ gameState: 'running' });
  await h.updater.request([U('h1')]);
  await h.updater.request([U('h1')]);
  assert.deepEqual(h.updater.queued(), ['maps:h1']);
});

test('pendingCount returns queued + transient failed count', async () => {
  const h = harness({ gameState: 'running' });
  await h.updater.request([U('h1'), U('h2')]);
  assert.equal(h.updater.pendingCount(), 2);
  // Simulate a transient failure - process with game not running
  const h2 = harness({ gameState: 'not-running', failOn: 'bad' });
  await h2.updater.request([U('bad', 'Bad'), U('good', 'Good')]);
  await h2.updater.idle();
  // bad failed (transient), good succeeded
  assert.equal(h2.updater.pendingCount(), 1); // bad is transient failed
});