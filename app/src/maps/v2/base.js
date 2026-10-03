// The level's data (basemap.json) and its images, loaded once.
let loading = null;

export function loadBase(onProgress = () => {}) {
  if (!loading) loading = fetchBase(onProgress).catch((e) => { loading = null; throw e; });
  return loading;
}

async function fetchBase(onProgress) {
  const res = await fetch('/maps/basemap.json');
  if (!res.ok) throw new Error('basemap.json: ' + res.status);
  const total = Number(res.headers.get('content-length')) || 1e7;
  let text;
  if (res.body?.getReader) {
    const reader = res.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(0.6 * Math.min(1, got / total), `Level data ${(got / 1e6).toFixed(1)} MB`);
    }
    text = await new Blob(chunks).text();
  } else text = await res.text();
  const data = JSON.parse(text);
  onProgress(0.65, 'Level art');
  const sc = data.scene || {};
  const srcs = { tiles: '/maps/' + data.art.atlas, scene: '/maps/' + sc.atlas, board: '/maps/course-screen.png' };
  (sc.backgrounds || []).forEach((b) => { srcs['bg:' + b.img] = '/maps/' + b.img; });
  (sc.worldBackdrops || []).forEach((b) => { srcs['bg:' + b.img] = '/maps/' + b.img; });
  (sc.fonts || []).forEach((f, i) => { if (f) srcs['font:' + i] = '/maps/' + f.atlas; });
  for (const d of data.defs || []) if (d.kind === 'vine') srcs['vine:' + d.sprite] = '/maps/vines/' + encodeURIComponent(d.sprite) + '.png';
  const images = {}, keys = Object.keys(srcs);
  let done = 0;
  await Promise.all(keys.map((k) => image(srcs[k]).then((img) => { images[k] = img; onProgress(0.65 + 0.35 * (++done / keys.length), 'Level art'); }, () => {})));
  try { data.plants = await (await fetch('/maps/plants/plants.json')).json(); } catch { data.plants = []; }
  return { data, images };
}

function image(src) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error('image ' + src));
    img.src = src;
  });
}

// A tile layer's grid and how the game draws it: { size, ox, oy, order, alpha, visible }.
// "<layer>#ghost" is that layer with collision off: drawn the same, nothing collides with it.
export function layerInfo(data, name) {
  const base = baseLayer(name), art = data.art.layers.find((l) => l.name === base), lt = (data.art.levelTiles || []).find((l) => l.name === base);
  const g = art || lt;
  return {
    size: g?.size ?? 32, ox: g?.ox ?? 0, oy: g?.oy ?? -23,
    order: art?.order ?? lt?.order ?? 0, alpha: art?.alpha ?? 1, visible: lt ? lt.visible !== false : true, ghost: base !== name,
  };
}
export const baseLayer = (name) => name.split('#')[0];
export const GHOST = '#ghost';
