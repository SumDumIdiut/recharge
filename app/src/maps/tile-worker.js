// Renders base-map tiles for the map editor off the main thread: the editor
// module itself, with its canvases as OffscreenCanvases (see editor.js, "tile
// workers"). Messages: init (load the base map + images), state (level state
// changed), tile (render one, returned as an ImageBitmap).
import { workerInit, workerSetState, workerRenderTile } from './editor.js';

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
  } else if (m.type === 'tile') {
    await ready;
    let bitmap = null;
    try { bitmap = workerRenderTile(m.z, m.tx, m.ty); } catch (err) { console.warn('[map editor] tile failed', err); }
    self.postMessage({ type: 'tile', key: m.key, bitmap }, bitmap ? [bitmap] : []);
  }
};
