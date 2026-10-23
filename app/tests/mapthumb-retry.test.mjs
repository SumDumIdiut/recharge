// node --test tests/ : a map that failed to draw is tried again (a busy worker), a broken map is not,
// and an offline Hub is not fetched on every render.
import test from 'node:test';
import assert from 'node:assert/strict';

const kept = new Map(); // "<id>@<stamp>" -> base64, as the Rust cache keeps them
const calls = [];
const offline = new Set(); // maps the Hub can't give
const broken = new Set(); // maps whose JSON doesn't parse
let drawFails = false;
let draws = 0;
globalThis.Worker = class {
  postMessage(m) {
    queueMicrotask(() => {
      if (m.type === 'init') this.onmessage({ data: { type: 'ready' } });
      if (m.type === 'view') {
        draws++;
        if (drawFails) this.onmessage({ data: { type: 'view', id: m.id, error: 'worker died' } });
        else this.onmessage({ data: { type: 'view', id: m.id, blob: new Blob(['PNG!']) } });
      }
    });
  }
  terminate() {}
};
globalThis.window = {
  __TAURI__: { core: { invoke: async (cmd, a) => {
    calls.push([cmd, a]);
    if (cmd === 'map_view_stamp') return '1700000000000';
    if (cmd === 'read_map_view') return kept.get(a.id + '@' + a.stamp) ?? null;
    if (cmd === 'write_map_view') { kept.set(a.id + '@' + a.stamp, a.data); return null; }
    if (cmd === 'read_map') {
      if (offline.has(a.id)) throw new Error('offline');
      if (broken.has(a.id)) return 'not json at all';
      return JSON.stringify({ editor: { blocks: {} } });
    }
    if (cmd === 'fetch_hub_map_json') {
      if (offline.has(a.id)) throw new Error('offline');
      if (broken.has(a.id)) return 'not json at all';
      return JSON.stringify({ editor: { blocks: {} } });
    }
    throw new Error('unexpected ' + cmd);
  } } },
};

const { mapThumbFor, clearFailed, viewFailed, retryView } = await import('../src/maps/mapthumb.js');
const fetches = (id) => calls.filter(([c, a]) => (c === 'read_map' || c === 'fetch_hub_map_json') && a.id === id).length;

test('a draw that failed is tried again, and the picture comes when it works', async () => {
  drawFails = true;
  assert.equal(await mapThumbFor('m1', { stamp: 'h1' }), null, 'the worker died: no picture');
  drawFails = false;
  // The backoff holds the next try: a failure is not retried on the very next render.
  assert.equal(await mapThumbFor('m1', { stamp: 'h1' }), null, 'no second try before the backoff');
  clearFailed(); // the list was refreshed
  const img = await mapThumbFor('m1', { stamp: 'h1' });
  assert.match(img, /^data:image\/png;base64,/, 'the retry draws the picture');
  assert.equal(draws, 2);
});

test('an offline Hub is not fetched again on every render', async () => {
  offline.add('m2');
  assert.equal(await mapThumbFor('m2', { stamp: 'h2' }), null);
  const n = fetches('m2');
  assert.ok(n > 0, 'the Hub was asked once');
  await mapThumbFor('m2', { stamp: 'h2' });
  assert.equal(fetches('m2'), n, 'and not again for the same card');
  clearFailed();
  await mapThumbFor('m2', { stamp: 'h2' });
  assert.ok(fetches('m2') > n, 'a refreshed list asks again');
  offline.delete('m2');
});

test('a map whose JSON does not parse is latched', async () => {
  broken.add('m3');
  assert.equal(await mapThumbFor('m3', { stamp: 'h3' }), null);
  const n = fetches('m3');
  await mapThumbFor('m3', { stamp: 'h3' });
  assert.equal(fetches('m3'), n, 'a broken map is not fetched again');
  clearFailed();
  await mapThumbFor('m3', { stamp: 'h3' });
  assert.ok(fetches('m3') > n, 'until the list is refreshed');
  broken.delete('m3');
});

test('a map whose view failed is said to have failed, and can be tried again', async () => {
  offline.add('m4');
  assert.equal(await mapThumbFor('m4', { stamp: 'h4' }), null);
  assert.equal(viewFailed('m4'), true, 'the card is told the view is unavailable');
  assert.equal(viewFailed('m5'), false, 'and no other map is');
  assert.equal(retryView('m4'), 1, 'the failure is forgotten');
  assert.equal(viewFailed('m4'), false, 'so the card offers a fresh try');
  offline.delete('m4');
});
