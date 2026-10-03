import { FLOATS, quad } from './gl.js';
import { TextBaker } from './text.js';
import { layerInfo } from '../base.js';
import { courseScreen, SCREEN_BOX } from '../markers.js';
import { spikeTile, spikeExtra } from '../spikes.js';

const CH = 32;
// How far a tile's art may reach past its cell (big pieces drawn from one cell).
const TILE_REACH = 128;
const TILE_SPRITE = /^(.*)@(-?\d+)$/;
const PRICE_TEXT = /^[\d.]+(e\d+)?[KMGT]?(w|gp|np|cd|rp|bp)?$/;
const CURRENCY_ENUM = ['Cash', 'GreenPower', 'AtomicPower', 'regularNumber', 'CloneDust', 'RedPower', 'BluePower'];
const CURRENCY_TEXT = { Cash: ['w', '#ff6a00'], GreenPower: ['gp', '#00dd5d'], AtomicPower: ['np', '#9654ef'], CloneDust: ['cd', '#b3905d'], RedPower: ['rp', '#da5145'], BluePower: ['bp', '#4f9cff'] };
function shortNumber(n) {
  if (n < 1000) return String(Math.round(n));
  if (n >= 1e15) { const ex = Math.floor(Math.log10(n)); return (n / 10 ** ex).toFixed(2) + 'e' + ex; }
  const i = Math.min(4, Math.floor(Math.log10(n) / 3));
  return parseFloat((n / 1000 ** i).toPrecision(3)) + 'KMGT'[i - 1];
}
// Level texts that only appear later in the game.
const LATER_TEXTS = new Set(['I have boosted all previous courses', 'Quaeso, ad locum generatoris redi;', 'ulteriores decessiones ruina violenta punientur.']);
const rot2 = (a) => [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];
const mul2 = (p, q) => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const ID = [1, 0, 0, 1];
// A zip mover's parts that travel along its track (the rest stays).
const ZIP_MOVING = /^(ZipMoverMovingPart|ZipMoverMechanism|ZipMoverGear)/;
// Where along its track (0 start, 1 end) a zip mover is `now` seconds into its
// loop: move, pause, return, pause - as the game plays one on its own.
function zipTravel(zip, now) {
  const go = Math.max(0.05, zip.time), back = Math.max(0.05, zip.backTime);
  const atEnd = Math.max(0, zip.pauseReturn ?? 0.5), atStart = Math.max(0, zip.pauseMove ?? 1), cycle = go + atEnd + back + atStart;
  let t = now % cycle;
  if (t < go) { const x = t / go; return x < 0.75 ? 1.1851852 * x * x * x : 1.1851852 * 0.421875 + 3 * 1.1851852 * 0.5625 * (x - 0.75); }
  t -= go;
  if (t < atEnd) return 1;
  t -= atEnd;
  if (t < back) return 1 - t / back;
  return 0;
}
// A zip mover's settings: its own, else the level's.
export function zipOf(item, e) {
  const z = item?.zip;
  if (!z) return null;
  const c = e.cfg?.zip || {}, end = c.end || z.end;
  const part = item.parts.find((p) => p.n === 'ZipMoverMovingPart'), [w, h] = part?.sz || [96, 384];
  const pb = Math.abs(z.end[1]) < Math.abs(z.end[0]) ? { thick: w, span: h } : { thick: h, span: w };
  const span = c.span ?? pb.span, across = Math.abs(end[1]) < Math.abs(end[0]) * 0.5;
  return { end, time: c.time ?? z.time, backTime: c.backTime ?? z.backTime, auto: !!c.auto, pauseMove: c.pauseMove ?? 1, pauseReturn: c.pauseReturn ?? 0.5, size: across ? [pb.thick, span] : [span, pb.thick] };
}
// Where course screens sit among the level's layers (the game's course canvas draws over the walls).
const SCREEN_ORDER = 0;
// The board image's 9-slice: 30 px borders, 27.5 x 28.75 world units on the board.
const BOARD_SLICE = 30, BOARD_EDGE = [27.5, 28.75];

// What a thing is drawn from: a level unit, or a palette item (by index, else by its saved name).
export function partsOf(base, e) {
  if (e.kind === 'unit') return base.scene.units[e.lv] || null;
  if (e.kind !== 'object') return null;
  const list = base.catalog?.[e.cat] || [];
  const it = list[e.i];
  return it && (!e.n || it.name === e.n) ? it : list.find((x) => x.name === e.n) || null;
}

// Draws a Doc with WebGL: tile layers from per-chunk buffers, the things in it per frame,
// all in the game's drawing order.
export class WorldRenderer {
  constructor(gl, base, images) {
    this.gl = gl;
    this.base = base;
    this.images = images;
    this.tex = { tiles: gl.texture(images.tiles), scene: gl.texture(images.scene) };
    this.bgTex = new Map();
    this.chunks = new Map();
    this.text = new TextBaker(base, images);
    this.boxTexts = new Map();
    this.baked = new Map();
    this.groupBakes = new WeakMap();
    this.frame = new Float32Array(FLOATS * 4096);
    this.doc = null;
    this.sceneRev = -1;
  }

  setDoc(doc) {
    if (this.doc !== doc) { for (const c of this.chunks.values()) this.gl.dropBatch(c.batch); this.chunks.clear(); this.sprites = null; }
    this.doc = doc;
  }

  // ---- tiles ----
  // A rule tile (moss): its picture by which of its 8 neighbours are moss too, from the
  // level's own table (the game's RuleTile). [sprite, matrix] or null.
  ruleTile(store, layer, x, y) {
    const table = this.base.art.autotiles?.moss;
    if (!table) return null;
    const AROUND = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
    const bits = AROUND.map(([dx, dy]) => !!store.cell(layer, x + dx, y + dy));
    for (const c of [1, 3, 5, 7]) bits[c] = bits[c] && bits[c - 1] && bits[(c + 1) % 8];
    const mask = bits.reduce((m, b, i) => (b ? m | (1 << i) : m), 0);
    let pick = table[mask];
    if (!pick) {
      const count = (n) => { let c = 0; for (; n; n >>= 1) c += n & 1; return c; };
      let score = Infinity;
      for (const [m, v] of Object.entries(table)) { const d = Number(m) ^ mask, sc = count(d & 0b01010101) * 4 + count(d & 0b10101010); if (sc < score) { score = sc; pick = v; } }
    }
    return pick ? [pick[0], this.base.mats[pick[1]] || ID] : null;
  }

  tileSprite(store, v) {
    const n = (v & 0xffff) - 1;
    if (store !== this.spriteOf?.store) this.spriteOf = { store, list: [] };
    let sp = this.spriteOf.list[n];
    if (sp === undefined) {
      const name = store.names[n] || '', drawn = TILE_SPRITE.exec(name);
      sp = drawn ? Number(drawn[2]) : this.base.art.tiles[name] ?? -1;
      this.spriteOf.list[n] = sp;
    }
    return sp;
  }

  chunkBatch(layer, ck, cells) {
    const key = layer.name + '|' + ck;
    let c = this.chunks.get(key);
    if (c && c.cells === cells && !c.stale) return c;
    const store = this.doc.tiles, meta = layerInfo(this.base, layer.name), spr = this.base.art.sprites;
    const AW = this.tex.tiles.w, AH = this.tex.tiles.h;
    const [cx, cy] = ck.split(',').map(Number);
    let n = 0;
    const out = new Float32Array(FLOATS * CH * CH * 4);
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      if (!v) continue;
      let sp = this.tileSprite(store, v), m = null;
      const gx = cx * CH + (i % CH), gy = cy * CH + Math.floor(i / CH);
      if (store.names[(v & 0xffff) - 1] === 'Moss') { const r = this.ruleTile(store, layer.name, gx, gy); if (r) [sp, m] = r; }
      const x = layer.ox + (gx + 0.5) * layer.size, y = layer.oy + (gy + 0.5) * layer.size;
      if (sp < 0) {
        // A join made of four quarter pieces (maps from the old editor).
        const q = store.extra.get(layer.name + '|' + gx + ',' + gy)?.spriteFrom?.quarters;
        if (!q) continue;
        q.forEach((name, k) => {
          const s = this.base.art.tiles[name];
          if (s === undefined || n >= CH * CH * 4) return;
          const [qx, qy, w, h] = spr[s], col = k % 2, row = k >> 1;
          const x0 = col ? 0 : -w / 2, y1 = row ? 0 : h / 2, u0 = qx + col * w / 2, v0 = qy + row * h / 2;
          quad(out, n++, x, y, store.matrix(v), x0, y1 - h / 2, x0 + w / 2, y1, (u0 + 0.5) / AW, (v0 + 0.5) / AH, (u0 + w / 2 - 0.5) / AW, (v0 + h / 2 - 0.5) / AH, 1, 1, 1, meta.alpha);
        });
        continue;
      }
      const [sx, sy, w, h] = spr[sp];
      quad(out, n++, x, y, m || store.matrix(v), -w / 2, -h / 2, w / 2, h / 2, (sx + 0.5) / AW, (sy + 0.5) / AH, (sx + w - 0.5) / AW, (sy + h - 0.5) / AH, 1, 1, 1, meta.alpha);
    }
    if (!c) c = { batch: this.gl.batch() };
    this.gl.fill(c.batch, out, n);
    c.cells = cells; c.stale = false; c.count = n;
    this.chunks.set(key, c);
    return c;
  }
  // Chunks whose tiles changed: drawn again next time.
  // Chunks whose tiles changed, and those beside them (rule tiles at an edge look across it).
  tilesChanged(keys) {
    for (const k of keys) {
      const bar = k.lastIndexOf('|'), layer = k.slice(0, bar), [cx, cy] = k.slice(bar + 1).split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const c = this.chunks.get(layer + '|' + (cx + dx) + ',' + (cy + dy)); if (c) c.stale = true; }
    }
  }

  drawLayer(layer, view) {
    const span = CH * layer.size, r = TILE_REACH + layer.size;
    const x0 = Math.floor((view.x0 - r - layer.ox) / span), x1 = Math.floor((view.x1 + r - layer.ox) / span);
    const y0 = Math.floor((view.y0 - r - layer.oy) / span), y1 = Math.floor((view.y1 + r - layer.oy) / span);
    const wide = (x1 - x0 + 1) * (y1 - y0 + 1) > layer.chunks.size;
    const each = (ck, cells) => { const c = this.chunkBatch(layer, ck, cells); this.gl.draw(c.batch, this.tex.tiles); };
    if (wide) {
      for (const [ck, cells] of layer.chunks) {
        const comma = ck.indexOf(','), cx = +ck.slice(0, comma), cy = +ck.slice(comma + 1);
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) each(ck, cells);
      }
    } else {
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) { const ck = cx + ',' + cy, cells = layer.chunks.get(ck); if (cells) each(ck, cells); }
    }
  }

  // Thorn vines: tiles too big for the tile atlas, drawn from their own images.
  drawVines(layer, view) {
    if (!this.vineOf) {
      this.vineOf = new Map((this.base.defs || []).filter((d) => d.kind === 'vine').map((d) => [d.tile, d.sprite]));
      this.vineLayers = new Set((this.base.defs || []).filter((d) => d.kind === 'vine').map((d) => d.layer));
      this.vineTex = new Map();
    }
    if (!this.vineLayers.has(layer.name)) return;
    const store = this.doc.tiles, r = 6 * 32, by = new Map();
    store.forRect(layer.name, Math.floor((view.x0 - r - layer.ox) / layer.size), Math.floor((view.y0 - r - layer.oy) / layer.size), Math.floor((view.x1 + r - layer.ox) / layer.size), Math.floor((view.y1 + r - layer.oy) / layer.size), (x, y, v) => {
      const sprite = this.vineOf.get(store.tileName(v).replace(/@-?\d+$/, ''));
      if (!sprite) return;
      if (!by.has(sprite)) by.set(sprite, []);
      by.get(sprite).push([layer.ox + (x + 0.5) * layer.size, layer.oy + (y + 0.5) * layer.size, store.matrix(v)]);
    });
    for (const [sprite, list] of by) {
      let t = this.vineTex.get(sprite);
      if (t === undefined) { const img = this.images['vine:' + sprite]; t = img ? this.gl.texture(img) : null; this.vineTex.set(sprite, t); }
      if (!t) continue;
      const out = new Float32Array(FLOATS * list.length);
      list.forEach(([x, y, m], i) => quad(out, i, x, y, m, -t.w / 2, -t.h / 2, t.w / 2, t.h / 2, 0, 0, 1, 1));
      this.gl.drawNow(out, list.length, t);
    }
  }

  // ---- the things placed: their sprites, texts, images and tile groups ----
  buildScene(ents = this.doc.entities, courses = this.doc.courses, keep = true) {
    const doc = this.doc, sc = this.base.scene, state = doc.state, items = [], texts = [], images = [];
    for (const e of ents) {
      const u = partsOf(this.base, e);
      if (!u) continue;
      const cfg = e.cfg || {}, alpha = cfg.alpha ?? 1, dz = e.dz || 0, k = cfg.scale || 1;
      const T = mul2(rot2(((cfg.rot || 0) * Math.PI) / 180), [k * (cfg.sx || 1) * (cfg.fx ? -1 : 1), 0, 0, k * (cfg.sy || 1) * (cfg.fy ? -1 : 1)]);
      const turn = ((cfg.rot || 0) * Math.PI) / 180, grow = Math.max(Math.hypot(T[0], T[2]), Math.hypot(T[1], T[3]));
      // A zip mover: its track and end node follow its end; the moving part travels it.
      const zip = zipOf(u, e);
      let parts = u.parts;
      if (zip) {
        const [ex, ey] = zip.end, len = Math.hypot(ex, ey) || 1, dx = ex / len, dy = ey / len;
        const tn = rot2(Math.atan2(ey, ex) - Math.atan2(u.zip.end[1], u.zip.end[0]));
        parts = parts.map((p) => {
          if (p.n === 'ZipTrack') return { ...p, x: ex / 2 + dx * 5, y: ey / 2 + dy * 5, m: mul2(tn, p.m), sz: p.sz && [len + 30, p.sz[1]] };
          if (p.n === 'ZipNode (1)') return { ...p, x: ex - dx * 5, y: ey - dy * 5 };
          if (p.n === 'ZipMoverMovingPart' && p.sz) return { ...p, sz: zip.size };
          return p;
        });
      }
      const zipEnd = zip && [T[0] * zip.end[0] + T[1] * zip.end[1], T[2] * zip.end[0] + T[3] * zip.end[1]];
      const box = e.boxEdit && u.object?.box;
      for (const p of parts) {
        // A refresher's used-up look: the game shows it only once the refresher is used.
        if ((p.st && p.st !== state) || p.n === 'InactiveSprite') continue;
        const x = e.x + T[0] * p.x + T[1] * p.y, y = e.y + T[2] * p.x + T[3] * p.y;
        if (p.is === 'text') { const src = box ? this.boxText(u, e, p) : p; texts.push({ ...src, x, y, r: (p.r || 0) + turn, src, a: (p.a ?? 1) * alpha, e: e.id }); }
        else if (p.is === 'image') images.push({ ...p, x, y, r: (p.r || 0) + turn, w: p.w * grow, h: p.h * grow, a: (p.a ?? 1) * alpha, e: e.id });
        else if (p.is === 'group') items.push({ ...p, x, y, o: p.o + dz, m: mul2(T, p.m), group: true, src: p, reach: 4000, e: e.id });
        else {
          const [, , sw, sh] = sc.sprites[p.s];
          const [w, h] = p.dm ? p.sz : [sw, sh], m = mul2(T, p.m);
          const it = { ...p, x, y, m, o: p.o + dz, a: (p.a ?? 1) * alpha, e: e.id, reach: Math.hypot(w, h) * Math.max(Math.hypot(m[0], m[2]), Math.hypot(m[1], m[3])) };
          if (zip && ZIP_MOVING.test(p.n || '')) {
            it.zip = { ...zip, end: zipEnd, x0: x, y0: y };
            // Where it goes, faintly, while it isn't moving.
            if (!this.simulate) items.push({ ...it, x: x + zipEnd[0], y: y + zipEnd[1], a: it.a * 0.35, zip: null, ghost: true });
          }
          items.push(it);
        }
      }
    }
    // Spikes off the grid and kill-on-touch spikes (tile art), signs, images.
    const spikeOrder = layerInfo(this.base, 'Spikes').order;
    for (const e of ents) {
      const dz = e.dz || 0;
      if (e.kind === 'spike') {
        const t = spikeTile(this.base, e.grid || e.c === 'true' ? 'spike' : e.c, e.q || 0), sp = this.base.art.tiles[t.tile];
        if (sp === undefined) continue;
        const kill = e.grid || e.c === 'true';
        items.push({ tileArt: true, sp, x: e.x, y: e.y, m: e.grid ? t.matrix : mul2(spikeExtra(e), t.matrix), o: spikeOrder + dz, c: kill ? [1, 0.125, 0.125] : null, e: e.id, reach: 48 });
      } else if (e.kind === 'text') {
        const src = this.signText(e);
        if (src) texts.push({ ...src, x: e.x, y: e.y, r: ((e.r || 0) * Math.PI) / 180, src, a: e.alpha ?? 1, e: e.id });
      } else if (e.kind === 'sprite') {
        const sz = this.spriteSize(e);
        items.push({ image: true, ent: e, x: e.x, y: e.y, o: dz, e: e.id, reach: Math.hypot(sz.w, sz.h) / 2 });
      }
    }
    // Course screens: the game's board, with course 1's board texts on it.
    const art = this.screenArt();
    for (const c of courses) {
      const at = courseScreen(c);
      if (at) items.push({ board: true, x: at.x, y: at.y, o: SCREEN_ORDER + (c.dz || 0), e: 'm:' + c.id + ':screen', art, reach: 400 });
    }
    items.sort((a, b) => a.o - b.o);
    if (!keep) return { items, texts, images };
    this.sprites = { items, texts, images };
    this.sceneRev = doc.rev;
  }
  // What's about to be placed, faded over the map; ghostBounds is its box for the outline.
  drawGhost(view, now) {
    this.ghostBounds = null;
    if (!this.ghost) return;
    const keep = this.sprites;
    this.sprites = this.buildScene([this.ghost], [], false);
    this.drawItems(this.sprites.items, 0, this.sprites.items.length, view, now);
    this.drawImages(view);
    this.drawTexts(view);
    this.ghostBounds = this.boundsOf(this.ghost.id);
    this.sprites = keep;
  }

  // Quads for one sprite part (sliced / tiled draw modes become several).
  spriteQuads(p, out, n, now) {
    const spr = this.base.scene.sprites, AW = this.tex.scene.w, AH = this.tex.scene.h;
    let s = p.s;
    if (p.frames) s = p.frames[Math.floor(now * p.fps + (p.ph || 0) * p.frames.length) % p.frames.length];
    const [sx, sy, w, h, pvx, pvy, bl = 0, bb = 0, brd = 0, bt = 0] = spr[s];
    const W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h, tint = p.c || [1, 1, 1];
    const put = (dx0, dy0, dx1, dy1, ux0, uy0, ux1, uy1) => {
      quad(out, n++, p.x, p.y, p.m, dx0 - pvx * W, (1 - pvy) * H - dy1, dx1 - pvx * W, (1 - pvy) * H - dy0,
        ux0 / AW, uy0 / AH, ux1 / AW, uy1 / AH, tint[0], tint[1], tint[2], p.a ?? 1);
    };
    if (!p.dm) { put(0, 0, W, H, sx + 0.5, sy + 0.5, sx + w - 0.5, sy + h - 0.5); return n; }
    const srcX = [sx, sx + bl, sx + w - brd, sx + w], srcY = [sy, sy + bt, sy + h - bb, sy + h];
    const dstX = [0, bl, W - brd, W], dstY = [0, bt, H - bb, H];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const sW = srcX[i + 1] - srcX[i], sH = srcY[j + 1] - srcY[j];
      if (sW <= 0 || sH <= 0 || dstX[i + 1] <= dstX[i] || dstY[j + 1] <= dstY[j]) continue;
      if (p.dm === 2) {
        // Tiled: the middle repeats at its own size.
        for (let ty = dstY[j]; ty < dstY[j + 1]; ty += sH) for (let tx = dstX[i]; tx < dstX[i + 1]; tx += sW) {
          const cw = Math.min(sW, dstX[i + 1] - tx), chh = Math.min(sH, dstY[j + 1] - ty);
          if (n * FLOATS + FLOATS > out.length) return n;
          put(tx, ty, tx + cw, ty + chh, srcX[i], srcY[j], srcX[i] + cw, srcY[j] + chh);
        }
      } else put(dstX[i], dstY[j], dstX[i + 1], dstY[j + 1], srcX[i], srcY[j], srcX[i + 1], srcY[j + 1]);
    }
    return n;
  }

  groupTexture(g) {
    let b = this.groupBakes.get(g.src);
    if (b) return b;
    const sprites = this.base.scene.sprites, img = this.images.scene;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y, s] of g.cells) {
      const [, , w, h, , , , , , , ppu = 1] = sprites[s];
      const r = Math.max(w, h) / ppu;
      minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r); minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
    }
    const px = Math.min(2, 2048 / Math.max(maxX - minX, maxY - minY, 1));
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((maxX - minX) * px); cv.height = Math.ceil((maxY - minY) * px);
    const gx = cv.getContext('2d');
    for (const [x, y, s, t0, t1, t2, t3] of g.cells) {
      const [sx, sy, w, h, pvx, pvy, , , , , ppu = 1] = sprites[s];
      const k = px / ppu;
      gx.setTransform(k * t0, -k * t2, -k * t1, k * t3, (x - minX) * px + k * (-t0 * pvx * w + t1 * h * (1 - pvy)), (maxY - y) * px + k * (t2 * pvx * w - t3 * h * (1 - pvy)));
      gx.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    }
    b = { tex: this.gl.texture(cv), minX, maxY, px, cw: cv.width, ch: cv.height };
    this.groupBakes.set(g.src, b);
    return b;
  }

  drawItems(items, from, to, view, now) {
    const out = this.frame;
    let n = 0;
    const flush = () => { if (n) { this.gl.drawNow(out, n, this.tex.scene); n = 0; } };
    for (let i = from; i < to; i++) {
      const p = items[i];
      if (p.x + p.reach < view.x0 || p.x - p.reach > view.x1 || p.y + p.reach < view.y0 || p.y - p.reach > view.y1) continue;
      if (p.board) { flush(); this.drawBoard(p); continue; }
      if (p.tileArt) { flush(); this.drawTileArt(p); continue; }
      if (p.image) { flush(); this.drawImageThing(p.ent); continue; }
      if (p.group) {
        flush();
        const b = this.groupTexture(p), tmp = new Float32Array(FLOATS);
        quad(tmp, 0, p.x, p.y, p.m, b.minX, b.maxY - b.ch / b.px, b.minX + b.cw / b.px, b.maxY, 0, 0, 1, 1);
        this.gl.drawNow(tmp, 1, b.tex);
        continue;
      }
      if ((n + 40) * FLOATS > out.length) flush();
      if (p.zip && this.simulate) {
        const f = zipTravel(p.zip, now - (this.simStart || 0));
        n = this.spriteQuads({ ...p, x: p.zip.x0 + p.zip.end[0] * f, y: p.zip.y0 + p.zip.end[1] * f }, out, n, now);
        continue;
      }
      n = this.spriteQuads(p, out, n, now);
    }
    flush();
  }

  // A tile-atlas sprite as a thing (spikes): centred, turned by its matrix.
  drawTileArt(p) {
    const [sx, sy, w, h] = this.base.art.sprites[p.sp], AW = this.tex.tiles.w, AH = this.tex.tiles.h, c = p.c || [1, 1, 1];
    const tmp = new Float32Array(FLOATS);
    quad(tmp, 0, p.x, p.y, p.m, -w / 2, -h / 2, w / 2, h / 2, (sx + 0.5) / AW, (sy + 0.5) / AH, (sx + w - 0.5) / AW, (sy + h - 0.5) / AH, c[0], c[1], c[2], 1);
    this.gl.drawNow(tmp, 1, this.tex.tiles);
  }
  // Sign text in the level's green sign style, saying anything.
  signText(e) {
    if (!this.signs) this.signs = new Map();
    const tpl = this.signTpl ??= (this.base.scene.texts.always || []).find((t) => t.t.startsWith('Mossy ground')) || (this.base.scene.texts.always || []).find((t) => t.c === '#7bb652') || null;
    if (!tpl) return null;
    const k = [e.t, e.w, e.h, e.c].join('|');
    let t = this.signs.get(k);
    if (!t) { t = { ...tpl, t: e.t || ' ', w: e.w / tpl.k, h: e.h / tpl.k, c: e.c || tpl.c, r: 0 }; this.signs.set(k, t); }
    return t;
  }
  // A game sprite (plants) or one of your images: its size in the world.
  spriteSize(e) {
    const pl = e.game && (this.base.plants || []).find((p) => p.sprite === e.game), s = e.scale || 1;
    if (pl) return { w: pl.w * s * (e.sx || 1), h: pl.h * s * (e.sy || 1) };
    const t = this.spriteTex(e);
    return { w: (t?.w || 64) * s * (e.sx || 1), h: (t?.h || 64) * s * (e.sy || 1) };
  }
  spriteTex(e) {
    if (!this.extraTex) this.extraTex = new Map();
    const k = e.game ? 'plant:' + e.game : 'asset:' + e.image;
    if (this.extraTex.has(k)) return this.extraTex.get(k);
    this.extraTex.set(k, null);
    const load = (src) => { const img = new Image(); img.onload = () => { this.extraTex.set(k, this.gl.texture(img)); this.onLoad?.(); }; img.src = src; };
    if (e.game) { const pl = (this.base.plants || []).find((p) => p.sprite === e.game); if (pl) load('/maps/plants/' + pl.file); }
    else if (e.image) assetBlob(e.image).then((b) => { if (b) load(URL.createObjectURL(b)); });
    return null;
  }
  drawImageThing(e) {
    const t = this.spriteTex(e);
    if (!t) return;
    const sz = this.spriteSize(e), a = ((e.r || 0) * Math.PI) / 180;
    const m = mul2(rot2(a), [e.fx ? -1 : 1, 0, 0, e.fy ? -1 : 1]), tmp = new Float32Array(FLOATS);
    quad(tmp, 0, e.x, e.y, m, -sz.w / 2, -sz.h / 2, sz.w / 2, sz.h / 2, 0, 0, 1, 1, 1, 1, 1, e.alpha ?? 1);
    this.gl.drawNow(tmp, 1, t);
  }

  // Course 1's board texts (reward, best time, clones) around their centre.
  screenArt() {
    if (this.boardArt !== undefined) return this.boardArt;
    const sc = this.base.scene, panel = (sc.placements.always || []).find((p) => (p.p || '').endsWith('course 1/DisableBits/background geometry/entry backround'));
    const texts = panel ? (sc.texts.always || []).filter((t) => Math.abs(t.x - panel.x) < 300 && Math.abs(t.y - panel.y) < 350 && !/^[A-Z]+$/.test(t.t)) : [];
    this.boardArt = texts.length ? { texts, ref: { x: texts.reduce((a, t) => a + t.x, 0) / texts.length, y: texts.reduce((a, t) => a + t.y, 0) / texts.length } } : null;
    return this.boardArt;
  }
  drawBoard(p) {
    const img = this.images.board;
    if (!img) return;
    if (!this.tex.board) this.tex.board = this.gl.texture(img);
    const b = SCREEN_BOX, iw = img.width, ih = img.height, k = BOARD_SLICE;
    const L = p.x + b.dx - b.w / 2, T = p.y + b.dy + b.h / 2, ex = Math.min(BOARD_EDGE[0], b.w / 2), ey = Math.min(BOARD_EDGE[1], b.h / 2);
    const sx = [0, k, iw - k, iw], sy = [0, k, ih - k, ih], dx = [L, L + ex, L + b.w - ex, L + b.w], dy = [T, T - ey, T - b.h + ey, T - b.h];
    const out = new Float32Array(FLOATS * 9);
    let n = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) quad(out, n++, 0, 0, ID, dx[i], dy[j + 1], dx[i + 1], dy[j], sx[i] / iw, sy[j] / ih, sx[i + 1] / iw, sy[j + 1] / ih);
    this.gl.drawNow(out, n, this.tex.board);
    if (!p.art) return;
    const tmp = new Float32Array(FLOATS);
    for (const t of p.art.texts) {
      const bk = this.bakedText(t);
      if (!bk) continue;
      quad(tmp, 0, p.x + t.x - p.art.ref.x, p.y + t.y - p.art.ref.y, rot2(t.r), bk.x0, bk.top - bk.ch / bk.px, bk.x0 + bk.cw / bk.px, bk.top, 0, 0, 1, 1);
      this.gl.drawNow(tmp, 1, bk.tex);
    }
  }
  // A level box's price and name as its map settings have them (the game's own text otherwise).
  boxText(u, e, p) {
    const be = e.boxEdit, name = u.nameText ??= u.parts.filter((q) => q.is === 'text' && q.f !== 1).sort((a, b) => b.h - a.h)[0];
    let t = null, c = p.c;
    if (p.f === 1 && PRICE_TEXT.test(p.t) && (be.price != null || be.currency)) {
      const cur = be.currency || CURRENCY_ENUM[u.object.box.currency], [suf, col] = CURRENCY_TEXT[cur] || ['', p.c];
      t = shortNumber(be.price ?? u.object.box.price ?? 10) + suf; c = col;
    } else if (p === name && be.label) t = be.label;
    if (t == null || (t === p.t && c === p.c)) return p;
    const key = u.id + '|' + p.t + '|' + t + '|' + c;
    let src = this.boxTexts.get(key);
    if (!src) this.boxTexts.set(key, (src = { ...p, t, c }));
    return src;
  }
  bakedText(src) {
    let b = this.baked.get(src);
    if (b === undefined) {
      const bk = this.text.bake(src);
      b = bk ? { tex: this.gl.texture(bk.canvas), x0: bk.x0, top: bk.top, px: bk.px, cw: bk.canvas.width, ch: bk.canvas.height } : null;
      this.baked.set(src, b);
    }
    return b;
  }

  drawTexts(view) {
    const tmp = new Float32Array(FLOATS);
    for (const t of this.sprites.texts) {
      if (LATER_TEXTS.has(t.t)) continue;
      const reach = Math.max(t.w, t.h) + t.size * t.k * 4;
      if (t.x + reach < view.x0 || t.x - reach > view.x1 || t.y + reach < view.y0 || t.y - reach > view.y1) continue;
      if (this.text.size(t.src) * t.k * view.scale < 2.5) continue;
      const b = this.bakedText(t.src);
      if (!b) continue;
      quad(tmp, 0, t.x, t.y, rot2(t.r), b.x0, b.top - b.ch / b.px, b.x0 + b.cw / b.px, b.top, 0, 0, 1, 1, 1, 1, 1, t.a ?? 1);
      this.gl.drawNow(tmp, 1, b.tex);
    }
  }

  drawImages(view) {
    const out = this.frame, spr = this.base.scene.sprites, AW = this.tex.scene.w, AH = this.tex.scene.h;
    let n = 0;
    for (const im of this.sprites.images) {
      const reach = Math.hypot(im.w, im.h);
      if (im.x + reach < view.x0 || im.x - reach > view.x1 || im.y + reach < view.y0 || im.y - reach > view.y1) continue;
      const [sx, sy, sw, sh, , , bl = 0, bb = 0, brd = 0, bt = 0] = spr[im.s], m = rot2(im.r), a = im.a ?? 1;
      const L = -im.w / 2, T = im.h / 2;
      if (!im.b) { quad(out, n++, im.x, im.y, m, L, -im.h / 2, im.w / 2, T, sx / AW, sy / AH, (sx + sw) / AW, (sy + sh) / AH, 1, 1, 1, a); continue; }
      const [wl, wb, wr, wt] = im.b;
      const srcX = [sx, sx + bl, sx + sw - brd, sx + sw], srcY = [sy, sy + bt, sy + sh - bb, sy + sh];
      const dstX = [L, L + wl, L + im.w - wr, L + im.w], dstY = [T, T - wt, T - im.h + wb, T - im.h];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if (srcX[i + 1] <= srcX[i] || srcY[j + 1] <= srcY[j] || dstX[i + 1] <= dstX[i] || dstY[j] <= dstY[j + 1]) continue;
        quad(out, n++, im.x, im.y, m, dstX[i], dstY[j + 1], dstX[i + 1], dstY[j], srcX[i] / AW, srcY[j] / AH, srcX[i + 1] / AW, srcY[j + 1] / AH, 1, 1, 1, a);
        if ((n + 10) * FLOATS > out.length) { this.gl.drawNow(out, n, this.tex.scene); n = 0; }
      }
    }
    this.gl.drawNow(out, n, this.tex.scene);
  }

  // ---- picking ----
  // Whether a scene sprite has paint at its own pixel (u, v).
  opaque(sprite, u, v) {
    if (!this.alpha) this.alpha = new Map();
    let a = this.alpha.get(sprite);
    if (!a) {
      const [sx, sy, w, h] = this.base.scene.sprites[sprite];
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, w); cv.height = Math.max(1, h);
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(this.images.scene, sx, sy, w, h, 0, 0, w, h);
      a = { w, h, data: g.getImageData(0, 0, cv.width, cv.height).data };
      this.alpha.set(sprite, a);
    }
    const x = Math.floor(u), y = Math.floor(v);
    return x >= 0 && y >= 0 && x < a.w && y < a.h && a.data[(y * a.w + x) * 4 + 3] > 24;
  }
  // The entity drawn on top at a world point (its painted pixels, its text or image box), or null.
  entityAt(wx, wy) {
    if (!this.sprites || this.sceneRev !== this.doc.rev) this.buildScene();
    const { items, texts, images } = this.sprites;
    for (const t of texts) {
      const c = Math.cos(-t.r), s = Math.sin(-t.r), dx = wx - t.x, dy = wy - t.y, lx = c * dx - s * dy, ly = s * dx + c * dy;
      if (Math.abs(lx) <= t.w / 2 && Math.abs(ly) <= t.h / 2 && !LATER_TEXTS.has(t.t)) return t.e;
    }
    for (const im of images) {
      const c = Math.cos(-im.r), s = Math.sin(-im.r), dx = wx - im.x, dy = wy - im.y;
      if (Math.abs(c * dx - s * dy) <= im.w / 2 && Math.abs(s * dx + c * dy) <= im.h / 2) return im.e;
    }
    const spr = this.base.scene.sprites;
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i];
      if (p.tileArt) { if (Math.abs(wx - p.x) <= 16 && Math.abs(wy - p.y) <= 16) return p.e; continue; }
      if (p.image) { const sz = this.spriteSize(p.ent); if (Math.abs(wx - p.x) <= sz.w / 2 && Math.abs(wy - p.y) <= sz.h / 2) return p.e; continue; }
      if (p.board || p.group || p.ghost || p.a === 0 || p.n === 'InactiveSprite') continue;
      if (Math.abs(wx - p.x) > p.reach || Math.abs(wy - p.y) > p.reach) continue;
      const [, , w, h, pvx, pvy] = spr[p.s];
      const W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h;
      const [a, b, c, d] = p.m, det = a * d - b * c;
      if (!det) continue;
      const dx = wx - p.x, dy = wy - p.y;
      const u = (d * dx - b * dy) / det + pvx * W, v = (1 - pvy) * H - (-c * dx + a * dy) / det;
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      if (this.opaque(p.s, (u * w) / W, (v * h) / H)) return p.e;
    }
    return null;
  }
  // The visible layers, drawn order: [{ l, meta }].
  layerList() {
    return [...this.doc.tiles.layers.values()].map((l) => ({ l, meta: layerInfo(this.base, l.name) })).filter((x) => x.meta.visible && !this.hidden?.has(x.l.name)).sort((a, b) => a.meta.order - b.meta.order);
  }
  // The topmost visible tile at a world point: { layer, x, y } on its layer's grid, or null.
  tileAt(wx, wy, only = null) {
    const list = this.layerList();
    for (let i = list.length - 1; i >= 0; i--) {
      const { l } = list[i];
      if (only && l.name !== only) continue;
      const x = Math.floor((wx - l.ox) / l.size), y = Math.floor((wy - l.oy) / l.size);
      if (this.doc.tiles.cell(l.name, x, y)) return { layer: l.name, x, y };
    }
    return null;
  }
  // World boxes of an entity's drawn parts: [x0, y0, x1, y1].
  boundsOf(id) { return this.allBounds().get(id) || null; }
  // The box things not in the map yet would take (what's about to be placed).
  boundsOfScene(ents) {
    if (!this.sprites || this.sceneRev !== this.doc.rev) this.buildScene();
    const keep = this.sprites;
    this.sprites = this.buildScene(ents, [], false);
    let b = null;
    for (const c of this.allBounds().values()) b = b ? [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[2]), Math.max(b[3], c[3])] : c;
    this.sprites = keep;
    return b;
  }
  // Every thing's box at once (selection outlines, alignment), kept with the scene it's from.
  allBounds() {
    if (!this.sprites || this.sceneRev !== this.doc.rev) this.buildScene();
    const scene = this.sprites;
    if (scene.bounds) return scene.bounds;
    const out = new Map(), spr = this.base.scene.sprites;
    const add = (id, x0, y0, x1, y1) => { const b = out.get(id); out.set(id, b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]); };
    for (const p of scene.items) {
      if (p.group || p.board || p.ghost) continue;
      if (p.tileArt) { add(p.e, p.x - 16, p.y - 16, p.x + 16, p.y + 16); continue; }
      if (p.image) { const sz = this.spriteSize(p.ent); add(p.e, p.x - sz.w / 2, p.y - sz.h / 2, p.x + sz.w / 2, p.y + sz.h / 2); continue; }
      const [, , w, h, pvx, pvy] = spr[p.s];
      const W = p.dm ? p.sz[0] : w, H = p.dm ? p.sz[1] : h, [a, bb, c, d] = p.m;
      const pts = [[-pvx * W, -pvy * H], [(1 - pvx) * W, -pvy * H], [-pvx * W, (1 - pvy) * H], [(1 - pvx) * W, (1 - pvy) * H]].map(([lx, ly]) => [p.x + a * lx + bb * ly, p.y + c * lx + d * ly]);
      add(p.e, Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1])));
    }
    for (const t of [...scene.texts, ...scene.images]) {
      const c = Math.abs(Math.cos(t.r || 0)), sn = Math.abs(Math.sin(t.r || 0)), hw = (c * t.w + sn * t.h) / 2, hh = (sn * t.w + c * t.h) / 2;
      add(t.e, t.x - hw, t.y - hh, t.x + hw, t.y + hh);
    }
    return (scene.bounds = out);
  }

  // ---- the area's background behind it all ----
  // The level area at a point: the zone of the nearest zone cells (rings out), else area 1.
  zoneAt(x, y) {
    const sc = this.base.scene;
    if (!this.zoneSets) this.zoneSets = Object.entries(sc.zones || {}).map(([k, v]) => [k, new Set(v)]);
    const cx = Math.floor(x / sc.zoneCell), cy = Math.floor(y / sc.zoneCell);
    for (let r = 0; r <= 8; r++) {
      const hits = {};
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const [zone, set] of this.zoneSets) if (set.has((cx + dx) + ',' + (cy + dy))) hits[zone] = (hits[zone] || 0) + 1;
      }
      const best = Object.entries(hits).sort((a, b) => b[1] - a[1])[0];
      if (best) return best[0];
    }
    return 'zone 1';
  }
  bg(src) {
    let t = this.bgTex.get(src);
    if (t === undefined) { const img = this.images['bg:' + src]; t = img ? this.gl.texture(img) : null; this.bgTex.set(src, t); }
    return t;
  }
  drawBackground(view, cam) {
    // Far out the backdrop would be hundreds of tiny copies: it fades and the level sits on plain dark.
    const fade = Math.max(0, Math.min(1, (cam.scale / (cam.dpr || 1) - 0.1) / 0.1));
    if (!fade) return;
    const sc = this.base.scene, zone = this.zoneAt(cam.x, cam.y);
    const tmp = new Float32Array(FLOATS * 64);
    // The map's own background: your image, drifting with the view by its parallax, tiled.
    const own = this.doc.meta.background;
    if (own?.image) {
      const t = this.spriteTex({ image: own.image });
      if (!t) return;
      const k = own.scale ?? 1, p = own.parallax ?? 0.8, w = t.w * k, h = t.h * k;
      const ox = cam.x - (((cam.x * (1 - p)) % w) + w) % w - w / 2, oy = cam.y - (((cam.y * (1 - p)) % h) + h) % h - h / 2;
      let n = 0;
      for (let tx = Math.floor((view.x0 - ox) / w) - 1; ox + tx * w < view.x1 && n < 64; tx++) {
        for (let ty = Math.floor((view.y0 - oy) / h) - 1; oy + ty * h < view.y1 && n < 64; ty++) quad(tmp, n++, ox + (tx + 0.5) * w, oy + (ty + 0.5) * h, ID, -w / 2, -h / 2, w / 2, h / 2, 0, 0, 1, 1, 1, 1, 1, fade);
      }
      this.gl.drawNow(tmp, n, t);
      return;
    }
    for (const b of sc.backgrounds || []) {
      if (b.zone !== zone || (b.state !== 'always' && b.state !== this.doc.state)) continue;
      const t = this.bg(b.img);
      if (!t) continue;
      const w = b.size[0] * Math.abs(b.sx), h = b.size[1] * Math.abs(b.sy);
      const ox = cam.x * b.fx - w / 2, oy = cam.y * b.fy - h / 2;
      let n = 0;
      for (let tx = Math.floor((view.x0 - ox) / w); ox + tx * w < view.x1; tx++) {
        for (let ty = Math.floor((view.y0 - oy) / h); oy + ty * h < view.y1; ty++) {
          if (n >= 64) break;
          const flip = b.sx < 0;
          quad(tmp, n++, ox + (tx + 0.5) * w, oy + (ty + 0.5) * h, ID, -w / 2, -h / 2, w / 2, h / 2, flip ? 1 : 0, 0, flip ? 0 : 1, 1, 1, 1, 1, (b.a ?? 1) * fade);
        }
      }
      this.gl.drawNow(tmp, n, t);
    }
    this.drawWorldBackdrops(view, cam, zone, fade);
  }
  // Area 3's wallpaper: big tiled strips, each drifting with the view by its parallax,
  // only while the view is in their area.
  drawWorldBackdrops(view, cam, zone, fade) {
    const list = this.base.scene.worldBackdrops;
    if (!list?.length || zone !== String(list[0].path || '').split('/')[0].toLowerCase()) return;
    const out = this.frame;
    for (const b of list) {
      const t = this.bg(b.img);
      if (!t) continue;
      const at = b.par ? { x: b.px + (cam.x - b.px) * b.par[0], y: b.py + (cam.y - b.py) * b.par[1] } : { x: b.x, y: b.y };
      const [a, bb, c, d] = b.m, det = a * d - bb * c;
      if (!det) continue;
      const [w, h] = b.size, [tw, th] = b.tile;
      // The view's corners in the strip's own units (u right, v down).
      const pts = [[view.x0, view.y0], [view.x1, view.y0], [view.x0, view.y1], [view.x1, view.y1]].map(([x, y]) => {
        const dx = x - at.x, dy = y - at.y;
        return [(d * dx - bb * dy) / det, -(-c * dx + a * dy) / det];
      });
      const u0 = Math.max(-w / 2, Math.min(...pts.map((q) => q[0]))), u1 = Math.min(w / 2, Math.max(...pts.map((q) => q[0])));
      const v0 = Math.max(-h / 2, Math.min(...pts.map((q) => q[1]))), v1 = Math.min(h / 2, Math.max(...pts.map((q) => q[1])));
      if (u1 <= u0 || v1 <= v0) continue;
      const su = -w / 2 + Math.floor((u0 + w / 2) / tw) * tw, sv = -h / 2 + Math.floor((v0 + h / 2) / th) * th;
      let n = 0;
      for (let u = su; u < u1; u += tw) for (let v = sv; v < v1; v += th) {
        const cw = Math.min(tw, w / 2 - u), chh = Math.min(th, h / 2 - v);
        if ((n + 1) * FLOATS > out.length) { this.gl.drawNow(out, n, t); n = 0; }
        quad(out, n++, at.x, at.y, b.m, u, -(v + chh), u + cw, -v, 0, 0, cw / tw, chh / th, 1, 1, 1, (b.a ?? 1) * fade);
      }
      this.gl.drawNow(out, n, t);
    }
  }

  // ---- the game's credits, played while simulating ----
  // What the game's scripts do, second by second (their fades step every 0.02 s).
  creditsTimeline(g, t, vman) {
    const sc = g.scroll, scrollFor = sc ? (sc.to - sc.from) / sc.rate : 0, out = { scrollAt: null, alpha: {} };
    if (g.kind === 'end') {
      out.scrollAt = sc ? sc.from + sc.rate * Math.min(t, scrollFor) : null;
      out.alpha.logo = t < 0.75 ? 0 : t < 1 ? (t - 0.75) / 0.25 : t < 4.2 ? 1 : Math.max(0, 1 - (t - 4.2) / 1.25);
      out.length = Math.max(scrollFor, 5.5) + 3;
    } else if (vman) {
      const n = g.texts.filter((x) => x.role === 'vman').length, each = 1.11 + 1.2, holdTo = n * each + 4, fadeTo = holdTo + 1;
      out.alpha.vman = (i) => (t < i * each ? 0 : t < holdTo ? Math.min(1, (t - i * each) / 1.11) : Math.max(0, 1 - (t - holdTo) / (fadeTo - holdTo)));
      out.alpha.message = () => 0;
      out.length = fadeTo + 2;
    } else {
      const n = g.texts.filter((x) => x.role === 'message').length, each = 1.11 + 1.2, fadeAt = n * each + 1.2, scrollFrom = fadeAt + n;
      out.alpha.message = (i) => (t < i * each ? 0 : t < fadeAt ? Math.min(1, (t - i * each) / 1.11) : Math.max(0, 1 - (t - fadeAt) / n));
      out.alpha.vman = () => 0;
      out.scrollAt = sc && t >= scrollFrom ? sc.from + sc.rate * Math.min(t - scrollFrom, scrollFor) : null;
      out.length = scrollFrom + scrollFor + 3;
    }
    return out;
  }
  drawCredits(kind, view, cam, W, H, now) {
    const list = this.base.scene.credits;
    if (!this.simulate || !list?.length) return;
    const cls = kind === 'end' ? 'EndCreditsTrigger' : 'FakeCreditsControlScript', zone = this.zoneAt(cam.x, cam.y), gl = this.gl.gl;
    const tmp = new Float32Array(FLOATS);
    for (const g of list) {
      if (g.kind !== kind) continue;
      for (const e of this.doc.entities) {
        const u = e.kind === 'unit' && this.base.scene.units[e.lv];
        if (!u || u.object?.cls !== cls || u.path !== g.trigger?.path) continue;
        const mode = e.creditsMode || (e.vmanOnly ? 'vman' : 'game'), vman = mode === 'vman';
        // The end credits ride area 3's sky (a parallax layer), only while the view is in area 3.
        if (g.layer && zone !== String(g.trigger.path).split('/')[0].toLowerCase()) continue;
        const lay = g.layer ? { x: g.layer.px + (cam.x - g.layer.px) * g.layer.par[0], y: g.layer.py + (cam.y - g.layer.py) * g.layer.par[1] } : null;
        const ox = (lay ? lay.x - g.layer.x : 0) + e.x - u.x, oy = (lay ? lay.y - g.layer.y : 0) + e.y - u.y;
        const all = this.creditsTimeline(g, 0, vman), st = this.creditsTimeline(g, (now - (this.simStart || 0)) % all.length, vman);
        // The fake credits are masked to the screen they play on (inside its frame).
        const screen = u.parts.find((p) => p.is === 'image');
        let clip = null;
        if (kind === 'fake') {
          const [bl, bb, br, bt] = screen?.b || [0, 0, 0, 0];
          clip = screen ? { x: e.x + screen.x + (bl - br) / 2, y: e.y + screen.y + (bb - bt) / 2, w: screen.w - bl - br, h: screen.h - bb - bt } : { x: e.x + (g.trigger.box?.dx || 0), y: e.y + (g.trigger.box?.dy || 0), w: g.trigger.box?.w || 1440, h: g.trigger.box?.h || 1080 };
          const x0 = Math.round((clip.x - clip.w / 2 - cam.x) * cam.scale + W / 2), y0 = Math.round((clip.y - clip.h / 2 - cam.y) * cam.scale + H / 2);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(x0, y0, Math.max(0, Math.round(clip.w * cam.scale)), Math.max(0, Math.round(clip.h * cam.scale)));
        }
        for (const tx of g.texts) {
          let x = tx.x + ox, y = tx.y + oy, alpha = 1;
          if (tx.role === 'scroll') {
            if (st.scrollAt == null) continue;
            const dd = st.scrollAt - (g.scroll.y0 || 0);
            x += g.scroll.up[0] * dd; y += g.scroll.up[1] * dd;
          } else if (tx.role === 'logo') alpha = st.alpha.logo;
          else if (tx.role === 'message') alpha = st.alpha.message(tx.n);
          else if (tx.role === 'vman') alpha = st.alpha.vman ? st.alpha.vman(tx.n) : 0;
          else if (tx.role === 'end') alpha = st.scrollAt != null && st.scrollAt >= g.scroll.to ? 1 : 0;
          if (alpha <= 0.01 || x < view.x0 - 3000 || x > view.x1 + 3000 || y < view.y0 - 3000 || y > view.y1 + 3000) continue;
          const b = this.bakedText(tx);
          if (!b) continue;
          quad(tmp, 0, x, y, rot2(tx.r || 0), b.x0, b.top - b.ch / b.px, b.x0 + b.cw / b.px, b.top, 0, 0, 1, 1, 1, 1, 1, alpha * (tx.a ?? 1));
          this.gl.drawNow(tmp, 1, b.tex);
        }
        if (clip) gl.disable(gl.SCISSOR_TEST);
      }
    }
  }

  // ---- a frame ----
  draw(cam, W, H, now = performance.now() / 1000) {
    const doc = this.doc;
    if (!doc) return;
    if (!this.sprites || this.sceneRev !== doc.rev) this.buildScene();
    const view = { x0: cam.x - W / 2 / cam.scale, x1: cam.x + W / 2 / cam.scale, y0: cam.y - H / 2 / cam.scale, y1: cam.y + H / 2 / cam.scale, scale: cam.scale };
    this.gl.begin(W, H, cam, [16 / 255, 16 / 255, 16 / 255]);
    this.drawBackground(view, cam);
    this.drawCredits('end', view, cam, W, H, now);
    const layers = this.layerList();
    const items = this.sprites.items;
    let next = 0;
    for (const { l, meta } of layers) {
      let to = next;
      while (to < items.length && items[to].o <= meta.order) to++;
      if (to > next) this.drawItems(items, next, to, view, now);
      next = to;
      this.drawLayer(l, view);
      this.drawVines(l, view);
    }
    if (next < items.length) this.drawItems(items, next, items.length, view, now);
    this.drawImages(view);
    this.drawTexts(view);
    this.drawCredits('fake', view, cam, W, H, now);
    this.drawGhost(view, now);
  }
}

// Your images, kept by the editors in IndexedDB.
let assetDbP = null;
function assetBlob(file) {
  assetDbP ||= new Promise((ok, fail) => { const r = indexedDB.open('rechargeMapAssets', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
  return assetDbP.then((db) => new Promise((ok) => { const r = db.transaction('files').objectStore('files').get(file); r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); }), () => null);
}
