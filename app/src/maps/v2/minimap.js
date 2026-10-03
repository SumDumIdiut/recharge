// The whole map small (one dot per 32x32-cell chunk that has tiles), with the view on it;
// click or drag to go there.
const COLOR = (name) => (/Spikes/.test(name) ? '#d0d4c4' : /blue/.test(name) ? '#3f7fe0' : /orange/.test(name) ? '#e08a3f' : /moss|Moss/.test(name) ? '#5c8a4c' : name === 'new awesome nikki ground' ? '#8a8d84' : '#3a3c38');
const ORDER = (name) => (name === 'new awesome nikki ground' ? 3 : /Spikes|blue|orange/.test(name) ? 4 : /moss/i.test(name) ? 2 : 1);

export class Minimap {
  constructor(ed) {
    this.ed = ed;
    this.el = document.createElement('canvas');
    this.el.className = 'mm2-mini mm2-panel';
    this.el.width = 220; this.el.height = 150;
    ed.root.appendChild(this.el);
    this.rev = -1;
    const go = (e) => {
      const r = this.el.getBoundingClientRect(), m = this.map;
      if (!m) return;
      ed.cam.x = m.x0 + ((e.clientX - r.left) / r.width) * (m.x1 - m.x0);
      ed.cam.y = m.y1 - ((e.clientY - r.top) / r.height) * (m.y1 - m.y0);
      ed.dirty = true;
    };
    this.el.addEventListener('pointerdown', (e) => { this.el.setPointerCapture(e.pointerId); this.down = true; go(e); });
    this.el.addEventListener('pointermove', (e) => { if (this.down) go(e); });
    this.el.addEventListener('pointerup', () => { this.down = false; });
  }

  // The map's picture, made again when its tiles change (at most every second or so).
  build() {
    const st = this.ed.doc.tiles, b = st.bounds();
    if (!b) { this.map = null; return; }
    const pad = 512, x0 = b[0] - pad, x1 = b[2] + pad, y0 = b[1] - pad, y1 = b[3] + pad;
    const W = this.el.width, H = this.el.height, k = Math.min(W / (x1 - x0), H / (y1 - y0));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
    const layers = [...st.layers.values()].sort((a, c) => ORDER(a.name) - ORDER(c.name));
    for (const l of layers) {
      g.fillStyle = COLOR(l.name);
      const span = 32 * l.size;
      for (const [ck, c] of l.chunks) {
        if (!c.some((v) => v)) continue;
        const [cx, cy] = ck.split(',').map(Number), wx = l.ox + cx * span, wy = l.oy + cy * span;
        g.fillRect(ox + (wx - x0) * k, oy + (y1 - wy - span) * k, Math.max(1, span * k), Math.max(1, span * k));
      }
    }
    this.map = { cv, x0: x0 - ox / k, x1: x1 + ox / k, y0: y0 - oy / k, y1: y1 + oy / k };
    this.rev = st.rev;
  }

  draw() {
    const st = this.ed.doc.tiles, now = performance.now();
    if (this.rev !== st.rev && (!this.builtAt || now - this.builtAt > 1000)) { this.build(); this.builtAt = now; }
    const g = this.el.getContext('2d'), m = this.map, W = this.el.width, H = this.el.height;
    g.clearRect(0, 0, W, H);
    if (!m) return;
    g.drawImage(m.cv, 0, 0);
    const ed = this.ed, vw = ed.gl.clientWidth / ed.cam.scale, vh = ed.gl.clientHeight / ed.cam.scale;
    const sx = (x) => ((x - m.x0) / (m.x1 - m.x0)) * W, sy = (y) => ((m.y1 - y) / (m.y1 - m.y0)) * H;
    g.strokeStyle = '#41f88d'; g.lineWidth = 1.5;
    const x = sx(ed.cam.x - vw / 2), y = sy(ed.cam.y + vh / 2);
    g.strokeRect(x, y, Math.max(3, sx(ed.cam.x + vw / 2) - x), Math.max(3, sy(ed.cam.y - vh / 2) - y));
  }
}

export const KEYS = [
  ['V / Q / M', 'Edit: select, box, move'], ['B', 'Build'], ['E', 'Delete'], ['Ctrl (moving or placing)', 'Line up with things around'], ['Alt (moving)', 'Move freely, off the snap grid'],
  ['Shift + click', 'Add to / take from the selection'], ['Drag empty space', 'Box things and tiles (drag inside to move)'],
  ['Arrows (Shift: a tile, Alt: a pixel)', 'Move by the snap step'], ['R / Shift+R', 'Turn the selection'], ['F', 'Flip the selection'],
  ['[ / ]', 'Draw order down / up (Shift: back / front)'], ['Delete', 'Delete (in an area: clear it)'],
  ['Ctrl+D', 'Duplicate'], ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / cut / paste'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S', 'Save to your maps'], ['T', 'Simulate (zip movers, credits)'],
  ['Space + drag, middle / right drag', 'Pan'], ['Wheel', 'Zoom'], ['Alt', 'Drag without snapping'], ['Esc', 'Stop placing / clear selection / leave'], ['K or ?', 'These keys'],
];
