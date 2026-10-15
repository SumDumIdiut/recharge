// node tests/skin-thumb.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findSkinFrame, gridFor, fitRect, isGuide } from '../src/skin-thumb.js';

// Synthetic sheet like the real template: 6 rows x 9 cols of 256px cells, 2px gutters, magenta guide lines.
function sheet(cols, cell, rows = 6) {
  const w = (cell + 2) * cols + 2, h = (cell + 2) * rows + 2;
  const d = new Uint8Array(w * h * 4);
  const put = (x, y, r, g, b, a = 255) => { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x % (cell + 2) < 2 || y % (cell + 2) < 2) put(x, y, 255, 0, 220);
  const box = (row, col, x, y, bw, bh) => { for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) put(2 + col * (cell + 2) + x + i, 2 + row * (cell + 2) + y + j, 10, 200, 30); };
  return { w, h, d, box };
}

assert.deepEqual(gridFor(2324, 1550), { cols: 9, rows: 6, cellW: 256, cellH: 256 });
assert.ok(isGuide(255, 0, 220, 255) && isGuide(250, 20, 200, 255) && !isGuide(10, 200, 30, 255) && !isGuide(255, 0, 220, 0));

// empty template (guides only): nothing found, caller shows a placeholder
let s = sheet(9, 256);
assert.equal(findSkinFrame(s.d, s.w, s.h), null);

// art in row 0 col 0, off-centre: cropped to its visible box with margin, no magenta
s = sheet(9, 256);
s.box(0, 0, 100, 60, 50, 80);
let r = findSkinFrame(s.d, s.w, s.h);
assert.deepEqual(r, { x: 2 + 100 - 4, y: 2 + 60 - 4, w: 58, h: 88 });

// first frames empty: next non-empty frame in the row is used
s = sheet(9, 256);
s.box(0, 2, 10, 10, 40, 40);
r = findSkinFrame(s.d, s.w, s.h);
assert.equal(r.x, 2 + 2 * 258 + 10 - 4);

// row 0 empty entirely: later row used
s = sheet(9, 256);
s.box(3, 1, 0, 0, 30, 30);
r = findSkinFrame(s.d, s.w, s.h);
assert.ok(r && r.y >= 2 + 3 * 258);

// no art touches guide lines: the crop never reaches gutters
s = sheet(9, 256);
s.box(0, 0, 0, 0, 256, 100);
r = findSkinFrame(s.d, s.w, s.h);
assert.ok(r.x >= 3 && r.y >= 3 && r.x + r.w <= 2 + 256 - 1 && r.y + r.h <= 2 + 256 - 1);

// painted on an opaque white background: the background is not art
s = sheet(9, 256);
for (let y = 2; y < 258; y++) for (let x = 2; x < 258; x++) { const i = (y * s.w + x) * 4; s.d[i] = s.d[i + 1] = s.d[i + 2] = s.d[i + 3] = 255; }
s.box(0, 0, 100, 90, 40, 70);
assert.deepEqual(findSkinFrame(s.d, s.w, s.h), { x: 98, y: 88, w: 48, h: 78 });
// the keyed background is transparent, white inside the character stays
assert.equal(s.d[(5 * s.w + 5) * 4 + 3], 0);
s = sheet(9, 256);
for (let y = 2; y < 258; y++) for (let x = 2; x < 258; x++) { const i = (y * s.w + x) * 4; s.d[i] = s.d[i + 1] = s.d[i + 2] = s.d[i + 3] = 255; }
s.box(0, 0, 100, 90, 60, 70);
for (let y = 110; y < 130; y++) for (let x = 110; x < 130; x++) { const i = (y * s.w + x) * 4; s.d[i] = s.d[i + 1] = s.d[i + 2] = 255; }
assert.ok(findSkinFrame(s.d, s.w, s.h));
assert.equal(s.d[(120 * s.w + 120) * 4 + 3], 255);

// a full-cell picture (screenshot) is not a character frame
s = sheet(9, 256);
s.box(0, 0, 0, 0, 256, 256);
for (let y = 2; y < 258; y++) for (let x = 2; x < 258; x++) { const i = (y * s.w + x) * 4; s.d[i] = x - 2; s.d[i + 1] = y - 2; s.d[i + 2] = 90; }
assert.equal(findSkinFrame(s.d, s.w, s.h), null);

// other cell sizes / column counts
s = sheet(6, 64);
s.box(0, 0, 20, 20, 10, 10);
assert.ok(findSkinFrame(s.d, s.w, s.h));

// fit keeps aspect and centres
assert.deepEqual(fitRect({ w: 50, h: 100 }, 124), { dx: 31, dy: 0, dw: 62, dh: 124 });

// real hub sheets, when fetched (scratchpad .rgba dumps; skipped otherwise)
const dir = process.env.SKIN_SHEETS;
if (dir && fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.rgba'))) {
    const d = fs.readFileSync(`${dir}/${f}`);
    const fr = findSkinFrame(d, 2324, 1550);
    console.log(f, fr);
    if (fr) {
      assert.ok(fr.w > 0 && fr.h > 0);
      for (let y = fr.y; y < fr.y + fr.h; y++) for (let x = fr.x; x < fr.x + fr.w; x++) { const i = (y * 2324 + x) * 4; assert.ok(!(d[i + 3] > 8 && isGuide(d[i], d[i + 1], d[i + 2], d[i + 3]))); }
    }
  }
}
console.log('skin-thumb ok');
