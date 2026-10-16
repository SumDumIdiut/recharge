// Picture of a skin from its sheet (the Unity animator template: 6 rows Idle, run, Fall, Jump, wallPose, Dash,
// a 2px gutter around and between cells, magenta guide lines in the gutters; see GridSheet.cs / TemplateGrid.cs in recharge-skins).
// The cell grid is derived the way the mod does it: cell = (size - 2) / count - 2. The frame shown is the first non-empty one
// (row 0 left to right, then the other rows), cropped to its visible pixels. Nothing real found: a placeholder.
const GUTTER = 2;
const ROWS = 6;
const MIN_PIXELS = 24; // fewer visible pixels than this is an empty frame (stray dust)

// Same test as GridSheet.IsGridLineColor, plus a looser one for the blurred edges of a guide line.
export function isGuide(r, g, b, a) {
  if (a <= 0) return false;
  if (Math.abs(r - 255) + g + Math.abs(b - 220) <= 60) return true;
  return r > 170 && b > 130 && g < 110 && r - g > 90 && b - g > 70;
}

// Cells are roughly square, so the width gives the column count (the real template is 9 columns of 256px).
export function gridFor(w, h) {
  const cellH = (h - GUTTER) / ROWS - GUTTER;
  if (!(cellH >= 4)) return null;
  const cols = Math.max(1, Math.round((w - GUTTER) / (cellH + GUTTER)));
  const cellW = (w - GUTTER) / cols - GUTTER;
  if (!(cellW >= 4)) return null;
  return { cols, rows: ROWS, cellW, cellH };
}

// Makes the region of (br,bg,bb)-coloured pixels connected to the border of [x0,x1) x [y0,y1) transparent (alpha 0), in place.
export function keyOut(data, w, x0, y0, x1, y1, br, bg, bb, tol = 30) {
  const cw = x1 - x0, ch = y1 - y0;
  const seen = new Uint8Array(cw * ch);
  const stack = [];
  const near = (x, y) => { const i = (y * w + x) * 4; return data[i + 3] > 0 && Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) <= tol; };
  const push = (x, y) => { const k = (y - y0) * cw + (x - x0); if (!seen[k] && near(x, y)) { seen[k] = 1; stack.push(x, y); } };
  for (let x = x0; x < x1; x++) { push(x, y0); push(x, y1 - 1); }
  for (let y = y0; y < y1; y++) { push(x0, y); push(x1 - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    data[(y * w + x) * 4 + 3] = 0;
    if (x > x0) push(x - 1, y);
    if (x < x1 - 1) push(x + 1, y);
    if (y > y0) push(x, y - 1);
    if (y < y1 - 1) push(x, y + 1);
  }
}

// RGBA bytes -> { x, y, w, h } of the first non-empty frame's visible pixels (plus a margin), or null. Keys a flat background out of `data` in place.
export function findSkinFrame(data, w, h, margin = 4) {
  const g = gridFor(w, h);
  if (!g) return null;
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.cols; col++) {
      const cx = GUTTER + col * (g.cellW + GUTTER), cy = GUTTER + row * (g.cellH + GUTTER);
      const x0 = Math.round(cx) + 1, y0 = Math.round(cy) + 1;
      const x1 = Math.min(w, Math.round(cx + g.cellW) - 1), y1 = Math.min(h, Math.round(cy + g.cellH) - 1);
      // an opaque flat background (some skins are painted on white) counts as empty, like transparency
      const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
      const corners = [px(x0, y0), px(x1 - 1, y0), px(x0, y1 - 1), px(x1 - 1, y1 - 1)];
      const [br, bg, bb, ba] = corners[0];
      const flat = ba >= 250 && !isGuide(br, bg, bb, ba) && corners.every((c) => Math.abs(c[0] - br) + Math.abs(c[1] - bg) + Math.abs(c[2] - bb) <= 12 && c[3] >= 250);
      // an opaque flat background (some skins are painted on white) is keyed out: flood fill from the frame's border only, so the same colour inside the character stays
      if (flat) keyOut(data, w, x0, y0, x1, y1, br, bg, bb);
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const a = data[i + 3];
          if (a < 8 || isGuide(data[i], data[i + 1], data[i + 2], a)) continue;
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (n < MIN_PIXELS) continue;
      // art filling the whole cell edge to edge is a picture/screenshot, not a character frame
      if (maxX - minX + 1 >= 0.95 * (x1 - x0) && maxY - minY + 1 >= 0.95 * (y1 - y0)) continue;
      const rx = Math.max(x0, minX - margin), ry = Math.max(y0, minY - margin);
      return { x: rx, y: ry, w: Math.min(x1, maxX + 1 + margin) - rx, h: Math.min(y1, maxY + 1 + margin) - ry };
    }
  }
  return null;
}

// Where to draw: source rect fitted into box x box, aspect kept and centred.
export function fitRect(src, box) {
  const s = Math.min(box / src.w, box / src.h);
  const w = src.w * s, h = src.h * s;
  return { dx: (box - w) / 2, dy: (box - h) / 2, dw: w, dh: h };
}

// Neutral stand-in (default player silhouette) for a sheet with no real art.
function placeholder(ctx, n) {
  ctx.fillStyle = 'rgba(128,132,148,0.35)';
  ctx.beginPath();
  ctx.arc(n * 0.5, n * 0.36, n * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(n * 0.5, n * 0.72, n * 0.17, n * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
}

// Draws the skin picture of a loaded image into el (a fixed-size box) as a canvas: the first real frame, else a placeholder
// (never the guide lines). False when the image has no size.
// allowPlaceholder: draw the stand-in when nothing is found (else 'empty' is returned and nothing is drawn).
export function drawSkinThumb(el, img, box = el.clientWidth || 124, { allowPlaceholder = true } = {}) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return false;
  const dpr = window.devicePixelRatio || 1;
  const out = document.createElement('canvas');
  out.width = Math.round(box * dpr);
  out.height = Math.round(box * dpr);
  out.style.cssText = `width:${box}px;height:${box}px;display:block`;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  let frame = null, source = img;
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, w, h);
    frame = findSkinFrame(px.data, w, h);
    if (frame) { ctx.putImageData(px, 0, 0); source = c; }
  } catch {
    // tainted canvas: no pixel access
  }
  if (frame) {
    const f = fitRect(frame, out.width);
    octx.drawImage(source, frame.x, frame.y, frame.w, frame.h, f.dx, f.dy, f.dw, f.dh);
  } else if (allowPlaceholder) {
    placeholder(octx, out.width);
  } else {
    return 'empty';
  }
  el.replaceChildren(out);
  return true;
}

// Loads src (hub images send Access-Control-Allow-Origin: *) and draws it into el. The box is removed when the image fails, and
// when the sheet has no character art (e.g. a skin that only changes the indicators and sounds): then nothing is shown.
export function applySkinThumb(el, src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { const r = drawSkinThumb(el, img, undefined, { allowPlaceholder: false }); if (r !== true) el.remove(); };
  img.onerror = () => el.remove();
  img.src = src;
}
