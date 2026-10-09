// Draws a map's view picture (Amplifier zoomed out over the whole map) by handing the map to the editor's tile worker (editor.js workerRenderMapView). One worker, started on first use and dropped after a quiet spell (it holds the 9.5MB level data).
const IDLE_MS = 30000;
let worker = null, ready = null, idle = 0, seq = 0;
const pending = new Map();

function stop(err) {
  clearTimeout(idle);
  worker?.terminate();
  worker = ready = null;
  for (const p of pending.values()) p.reject(err || new Error('map view worker stopped'));
  pending.clear();
}

function start() {
  if (ready) return ready;
  if (typeof Worker === 'undefined') return (ready = Promise.reject(new Error('no workers')));
  const w = (worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' }));
  ready = new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') resolve();
      else if (m.type === 'unsupported') { reject(new Error(m.error)); stop(new Error(m.error)); }
      else if (m.type === 'view') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.blob);
      }
    };
    w.onerror = (e) => { const err = new Error('map view worker: ' + (e.message || 'failed')); reject(err); stop(err); };
    w.postMessage({ type: 'init', state: { baseState: 'start', removed: [], removedVines: [] } });
  });
  ready.catch(() => {});
  return ready;
}

// map: the parsed map.json. Resolves to a PNG Blob (w x h), or null for a map with no editor data.
export async function renderMapView(map, w = 960, h = 540) {
  await start();
  clearTimeout(idle);
  const id = ++seq;
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('map view timed out')); stop(new Error('map view timed out')); }, 90000);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  });
  worker.postMessage({ type: 'view', id, map, w, h });
  try { return await done; } finally { if (!pending.size) idle = setTimeout(() => stop(), IDLE_MS); }
}
