import { workerInit, workerSetState, workerRenderTile, workerRenderMapView } from './editor.js';

let ready = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ready = workerInit(m.state);
    try {
      await ready;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'unsupported', error: String(err) });
    }
  } else if (m.type === 'state') {
    await ready;
    workerSetState(m.state);
  } else if (m.type === 'view') {
    // The map view picture (mapthumb.js): one whole map in, one bitmap out.
    try {
      await ready;
      const blob = await workerRenderMapView(m.map, m.w, m.h, () => self.postMessage({ type: 'progress', id: m.id }));
      self.postMessage({ type: 'view', id: m.id, blob });
    } catch (err) {
      self.postMessage({ type: 'view', id: m.id, error: String(err && err.stack || err) });
    }
  } else if (m.type === 'tile') {
    await ready;
    let bitmap = null;
    let error = null;
    try { bitmap = workerRenderTile(m.z, m.tx, m.ty, m.part); } catch (err) { error = String(err && err.stack || err); }
    self.postMessage({ type: 'tile', key: m.key, gen: m.gen, bitmap, error }, bitmap ? [bitmap] : []);
  }
};
