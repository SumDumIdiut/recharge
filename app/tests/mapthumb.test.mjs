// node --test tests/ : the map view picture's cache keying and "no uploaded picture -> drawn view" choice.
import test from 'node:test';
import assert from 'node:assert/strict';

const kept = new Map(); // "<id>@<stamp>" -> base64, as the Rust cache keeps them
const calls = [];
let draws = 0;
globalThis.Worker = class {
  postMessage(m) {
    queueMicrotask(() => {
      if (m.type === 'init') this.onmessage({ data: { type: 'ready' } });
      if (m.type === 'view') { draws++; this.onmessage({ data: { type: 'view', id: m.id, blob: new Blob(['PNG!']) } }); }
    });
  }
  terminate() {}
};
const stamps = { installed: '1700000000000' };
globalThis.window = {
  __TAURI__: { core: { invoke: async (cmd, a) => {
    calls.push([cmd, a]);
    if (cmd === 'map_view_stamp') return stamps[a.id] ?? null;
    if (cmd === 'read_map_view') return kept.get(a.id + '@' + a.stamp) ?? null;
    if (cmd === 'write_map_view') { for (const k of [...kept.keys()]) if (k.startsWith(a.id + '@')) kept.delete(k); kept.set(a.id + '@' + a.stamp, a.data); return null; }
    if (cmd === 'read_map') return JSON.stringify({ editor: { blocks: {} } });
    if (cmd === 'fetch_hub_map_json') return JSON.stringify({ editor: { blocks: {} } });
    throw new Error('unexpected ' + cmd);
  } } },
};

const { mapThumbFor, cardImage, needsView, hubStamp, viewKey } = await import('../src/maps/mapthumb.js');

test('an uploaded picture wins; the drawn view only fills in when there is none', () => {
  assert.equal(cardImage('up.png', 'data:drawn'), 'up.png');
  assert.equal(cardImage(null, 'data:drawn'), 'data:drawn');
  assert.equal(cardImage(null, null), null);
  assert.equal(needsView('up.png', null), false);
  assert.equal(needsView(null, null), true);
  assert.equal(needsView(null, 'data:drawn'), false);
});

test('keys are id + stamp; a Hub stamp is its upload time', () => {
  assert.notEqual(viewKey('a', '1'), viewKey('a', '2'));
  assert.equal(hubStamp('2026-10-01T02:12:09.594Z'), 'h2026-10-01T02:12:09.594Z');
});

test('drawn once per stamp, redrawn (and the old one dropped) when the stamp changes', async () => {
  const first = await mapThumbFor('m1', { stamp: 'h1' });
  assert.match(first, /^data:image\/png;base64,/);
  assert.equal(draws, 1);
  assert.equal(await mapThumbFor('m1', { stamp: 'h1' }), first); // from the kept copy
  assert.equal(draws, 1);
  await mapThumbFor('m1', { stamp: 'h2' }); // the map changed
  assert.equal(draws, 2);
  assert.deepEqual([...kept.keys()], ['m1@h2']);
});

test('an installed map is keyed by its file time; a Hub-only map is fetched from the Hub', async () => {
  calls.length = 0;
  await mapThumbFor('installed');
  assert.ok(kept.has('installed@1700000000000'));
  assert.ok(calls.some(([c]) => c === 'read_map'));
  const before = calls.length;
  await mapThumbFor('installed');
  assert.ok(calls.slice(before).every(([c]) => c !== 'read_map')); // cached, map not read again
  stamps.installed = '1800000000000'; // edited
  const n = draws;
  await mapThumbFor('installed');
  assert.equal(draws, n + 1);
  assert.deepEqual([...kept.keys()].filter((k) => k.startsWith('installed@')), ['installed@1800000000000']);
});
