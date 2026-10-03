// Every tile of a map, per tilemap layer, in 32x32-cell chunks: one Uint32 a
// cell (tile name index + 1 in the low 16 bits, matrix index in the high 16).
// Behaves like the editor's old Map of 'layer|x,y' -> { layer, tile, m }, and
// adds what a whole level needs: rect queries, runs for export, an undo
// journal, and the chunks changed since last asked (for redraws and saving).
const CH = 32;
const matKey = (m) => m.map((v) => Math.round(v * 1e4) / 1e4).join(',');

export class TileStore {
  // grid(layer) -> { size, ox, oy }; toMatrix(value) -> [a, b, c, d]
  constructor(grid, toMatrix, mats = [[1, 0, 0, 1]]) {
    this.grid = grid;
    this.toMatrix = toMatrix;
    this.layers = new Map();
    this.names = [];
    this.nameIdx = new Map();
    this.mats = [];
    this.matIdx = new Map();
    for (const m of mats) this.mat(m);
    this.extra = new Map();
    this.count = 0;
    this.journal = null;
    this.dirty = new Set();
    this.changed = new Map();
    // Bumped on every change: what's worked out from all the tiles is kept until it moves.
    this.rev = 0;
    this.boundsAt = null;
    // Chunks changed since the tile workers were last sent them.
    this.unsent = new Set();
  }

  mat(m) {
    const k = matKey(m);
    let i = this.matIdx.get(k);
    if (i === undefined) { i = this.mats.length; this.mats.push(m.slice(0, 4)); this.matIdx.set(k, i); }
    return i;
  }
  name(n) {
    let i = this.nameIdx.get(n);
    if (i === undefined) { i = this.names.length; this.names.push(n); this.nameIdx.set(n, i); }
    return i;
  }
  layer(name) {
    let l = this.layers.get(name);
    if (!l) {
      const g = this.grid(name);
      l = { name, size: g.size, ox: g.ox, oy: g.oy, chunks: new Map() };
      this.layers.set(name, l);
    }
    return l;
  }

  // ---- by cell ----
  cell(layer, x, y) {
    const l = this.layers.get(layer);
    const c = l?.chunks.get(Math.floor(x / CH) + ',' + Math.floor(y / CH));
    return c ? c[(y - Math.floor(y / CH) * CH) * CH + (x - Math.floor(x / CH) * CH)] : 0;
  }
  put(layer, x, y, packed, extra) {
    const l = this.layer(layer), cx = Math.floor(x / CH), cy = Math.floor(y / CH), ck = cx + ',' + cy;
    let c = l.chunks.get(ck);
    if (!c) { if (!packed) return; c = new Uint32Array(CH * CH); l.chunks.set(ck, c); }
    const i = (y - cy * CH) * CH + (x - cx * CH), old = c[i], k = layer + '|' + x + ',' + y;
    const oldExtra = this.extra.get(k);
    if (old === packed && oldExtra === extra) return;
    if (this.journal) this.journal.push([layer, x, y, old, oldExtra]);
    this.rev++;
    c[i] = packed;
    this.count += (packed ? 1 : 0) - (old ? 1 : 0);
    if (extra) this.extra.set(k, extra); else this.extra.delete(k);
    this.dirty.add(layer + '|' + ck);
    this.unsent.add(layer + '|' + ck);
    const ch = this.changed.get(layer);
    if (ch) { ch[0] = Math.min(ch[0], x); ch[1] = Math.min(ch[1], y); ch[2] = Math.max(ch[2], x); ch[3] = Math.max(ch[3], y); }
    else this.changed.set(layer, [x, y, x, y]);
  }
  setAt(layer, x, y, tile, m, extra) {
    this.put(layer, x, y, (this.name(tile) + 1) | (this.mat(m) << 16), extra);
  }
  unpack(layer, x, y, v) {
    if (!v) return undefined;
    const out = { layer, tile: this.names[(v & 0xffff) - 1], m: this.mats[v >>> 16] };
    const e = this.extra.get(layer + '|' + x + ',' + y);
    return e ? { ...e, ...out } : out;
  }

  // ---- the old Map's interface ----
  static parse(k) {
    const bar = k.lastIndexOf('|'), comma = k.indexOf(',', bar);
    return [k.slice(0, bar), +k.slice(bar + 1, comma), +k.slice(comma + 1)];
  }
  get size() { return this.count; }
  has(k) { const [l, x, y] = TileStore.parse(k); return !!this.cell(l, x, y); }
  get(k) { const [l, x, y] = TileStore.parse(k); return this.unpack(l, x, y, this.cell(l, x, y)); }
  set(k, v) {
    const [l, x, y] = TileStore.parse(k);
    const { layer, tile, m, q, fx, fy, ...rest } = v;
    this.setAt(l, x, y, tile, m || this.toMatrix(v), Object.keys(rest).length ? rest : undefined);
    return this;
  }
  delete(k) { const [l, x, y] = TileStore.parse(k); const had = !!this.cell(l, x, y); this.put(l, x, y, 0); return had; }
  clear() { for (const [k] of [...this]) this.delete(k); }
  *[Symbol.iterator]() {
    for (const l of this.layers.values()) {
      for (const [ck, c] of l.chunks) {
        const [cx, cy] = ck.split(',').map(Number);
        for (let i = 0; i < c.length; i++) {
          if (!c[i]) continue;
          const x = cx * CH + (i % CH), y = cy * CH + Math.floor(i / CH);
          yield [l.name + '|' + x + ',' + y, this.unpack(l.name, x, y, c[i])];
        }
      }
    }
  }
  entries() { return this[Symbol.iterator](); }
  *keys() { for (const [k] of this) yield k; }
  *values() { for (const [, v] of this) yield v; }
  forEach(fn) { for (const [k, v] of this) fn(v, k, this); }

  // ---- fast paths ----
  // Cells x0..x1, y0..y1 (inclusive) of one layer: fn(x, y, packed).
  forRect(layer, x0, y0, x1, y1, fn) {
    const l = this.layers.get(layer);
    if (!l) return;
    for (let cy = Math.floor(y0 / CH); cy <= Math.floor(y1 / CH); cy++) {
      for (let cx = Math.floor(x0 / CH); cx <= Math.floor(x1 / CH); cx++) {
        const c = l.chunks.get(cx + ',' + cy);
        if (!c) continue;
        const ya = Math.max(y0, cy * CH), yb = Math.min(y1, cy * CH + CH - 1), xa = Math.max(x0, cx * CH), xb = Math.min(x1, cx * CH + CH - 1);
        for (let y = ya; y <= yb; y++) {
          const row = (y - cy * CH) * CH - cx * CH;
          for (let x = xa; x <= xb; x++) { const v = c[row + x]; if (v) fn(x, y, v); }
        }
      }
    }
  }
  // Every layer's cells whose centre is inside a world rect: fn(layer, x, y, packed).
  forWorldRect(wx0, wy0, wx1, wy1, fn) {
    for (const l of this.layers.values()) {
      const x0 = Math.ceil((wx0 - l.ox) / l.size - 0.5), x1 = Math.floor((wx1 - l.ox) / l.size - 0.5);
      const y0 = Math.ceil((wy0 - l.oy) / l.size - 0.5), y1 = Math.floor((wy1 - l.oy) / l.size - 0.5);
      if (x1 >= x0 && y1 >= y0) this.forRect(l.name, x0, y0, x1, y1, (x, y, v) => fn(l.name, x, y, v));
    }
  }
  // The cells joined to one (4-way) on its layer, up to `limit`.
  flood(layer, x, y, limit = 20000) {
    const out = [], seen = new Set([x + ',' + y]), queue = [[x, y]];
    if (!this.cell(layer, x, y)) return out;
    while (queue.length && out.length < limit) {
      const [a, b] = queue.pop();
      out.push([a, b]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (a + dx) + ',' + (b + dy);
        if (!seen.has(k) && this.cell(layer, a + dx, b + dy)) { seen.add(k); queue.push([a + dx, b + dy]); }
      }
    }
    return out;
  }
  tileName(v) { return this.names[(v & 0xffff) - 1]; }
  matrix(v) { return this.mats[v >>> 16]; }
  // World box of every tile (cell edges), or null.
  bounds() {
    if (this.boundsAt?.rev === this.rev) return this.boundsAt.b;
    let b = null;
    for (const l of this.layers.values()) {
      for (const [ck, c] of l.chunks) {
        const [cx, cy] = ck.split(',').map(Number);
        for (let i = 0; i < c.length; i++) {
          if (!c[i]) continue;
          const x = l.ox + (cx * CH + (i % CH)) * l.size, y = l.oy + (cy * CH + Math.floor(i / CH)) * l.size;
          if (!b) b = [x, y, x + l.size, y + l.size];
          else { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x + l.size); b[3] = Math.max(b[3], y + l.size); }
        }
      }
    }
    this.boundsAt = { rev: this.rev, b };
    return b;
  }
  // One layer as runs [y, x, n, name, matrix] (rows, then x), with its own name table;
  // rename(name) -> the name written (default: as kept), skip: 'x,y' cells left out.
  runs(layer, rename = (n) => n, skip = null) {
    const l = this.layers.get(layer), names = [], local = new Map(), runs = [];
    if (!l) return { names, runs };
    const rows = new Map();
    for (const [ck, c] of l.chunks) {
      const [cx, cy] = ck.split(',').map(Number);
      for (let i = 0; i < c.length; i++) {
        if (!c[i]) continue;
        const y = cy * CH + Math.floor(i / CH), x = cx * CH + (i % CH);
        if (skip?.has(x + ',' + y)) continue;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push([x, c[i]]);
      }
    }
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(y).sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < row.length;) {
        const [x, v] = row[i];
        let n = 1;
        while (i + n < row.length && row[i + n][0] === x + n && row[i + n][1] === v) n++;
        const nm = rename(this.tileName(v));
        if (!local.has(nm)) { local.set(nm, names.length); names.push(nm); }
        runs.push(y, x, n, local.get(nm), v >>> 16);
        i += n;
      }
    }
    return { names, runs };
  }
  // Runs back in: names are the run file's own, mats its matrix table.
  addRuns(layer, names, runs, mats) {
    const nameAt = names.map((n) => this.name(n)), matAt = new Map();
    for (let i = 0; i < runs.length; i += 5) {
      const mi = runs[i + 4];
      if (!matAt.has(mi)) matAt.set(mi, this.mat(mats[mi] || [1, 0, 0, 1]));
      const packed = (nameAt[runs[i + 3]] + 1) | (matAt.get(mi) << 16);
      for (let n = 0; n < runs[i + 2]; n++) this.put(layer, runs[i + 1] + n, runs[i], packed);
    }
  }

  // ---- undo ----
  // Changes since `mark` (a journal length) put back, unrecorded.
  rollback(mark) {
    const j = this.journal;
    if (!j) return;
    this.journal = null;
    while (j.length > mark) { const [l, x, y, v, e] = j.pop(); this.put(l, x, y, v, e); }
    this.journal = j;
  }
  // A journal undone; returns the journal that redoes it.
  revert(list) {
    const was = this.journal, back = [];
    this.journal = back;
    for (let i = list.length - 1; i >= 0; i--) { const [l, x, y, v, e] = list[i]; this.put(l, x, y, v, e); }
    this.journal = was;
    return back;
  }

  // What changed since last asked, per layer as a cell box [x0, y0, x1, y1].
  takeChanged() { const c = this.changed; this.changed = new Map(); return c; }

  // ---- saving ----
  meta() { return { names: this.names, mats: this.mats, extra: [...this.extra], layers: [...this.layers.keys()] }; }
  takeDirty() {
    const out = [];
    for (const k of this.dirty) {
      const bar = k.lastIndexOf('|'), l = this.layers.get(k.slice(0, bar)), c = l?.chunks.get(k.slice(bar + 1));
      out.push([k, c && c.some((v) => v) ? c.slice() : null]);
    }
    this.dirty.clear();
    return out;
  }
  // For the tile workers: the chunks changed since last time (all of them with `all`), copied.
  takeUnsent(all = false) {
    const keys = all ? [...this.layers.values()].flatMap((l) => [...l.chunks.keys()].map((ck) => l.name + '|' + ck)) : [...this.unsent];
    this.unsent.clear();
    return keys.map((k) => {
      const bar = k.lastIndexOf('|'), c = this.layers.get(k.slice(0, bar))?.chunks.get(k.slice(bar + 1));
      return [k, c ? c.slice() : null];
    });
  }
  // A worker's copy brought up to date: the main store's tables and changed chunks.
  applySent(meta, chunks, all) {
    if (all) { this.layers.clear(); this.count = 0; }
    this.names = meta.names.slice(); this.nameIdx = new Map(this.names.map((n, i) => [n, i]));
    this.mats = meta.mats.slice(); this.matIdx = new Map(this.mats.map((m, i) => [matKey(m), i]));
    this.extra = new Map(meta.extra || []);
    for (const [k, c] of chunks) {
      const bar = k.lastIndexOf('|'), l = this.layer(k.slice(0, bar)), ck = k.slice(bar + 1);
      if (c) l.chunks.set(ck, c); else l.chunks.delete(ck);
    }
    this.rev++;
  }

  // Rebuilt from saved meta + chunks ([key, Uint32Array]).
  load(meta, chunks) {
    this.layers.clear(); this.names = []; this.nameIdx.clear(); this.mats = []; this.matIdx.clear(); this.extra = new Map(meta.extra || []); this.count = 0;
    for (const n of meta.names) this.name(n);
    for (const m of meta.mats) { this.matIdx.set(matKey(m), this.mats.length); this.mats.push(m); }
    for (const [k, c] of chunks) {
      const bar = k.lastIndexOf('|'), l = this.layer(k.slice(0, bar));
      const d = c instanceof Uint32Array ? c : new Uint32Array(c);
      l.chunks.set(k.slice(bar + 1), d);
      for (let i = 0; i < d.length; i++) if (d[i]) this.count++;
    }
    this.dirty.clear();
    this.changed.clear();
    this.rev++;
  }
}
