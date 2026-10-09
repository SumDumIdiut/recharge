// The editor's cell collections, tracked: each counts changes, notes which keys changed (picture cache and undo/drag redo only what moved), and indexes keys by area so drawing, hovering and box-select skip distant cells.
const CHUNK = 32; // cells per side of an area bucket
const MAX_NOTES = 50000; // past this many changes, "everything changed" is cheaper

const cellOfKey = (k) => { const c = k.indexOf(','); return [+k.slice(0, c), +k.slice(c + 1)]; };
const tileOfKey = (k) => { const bar = k.lastIndexOf('|'), c = k.indexOf(',', bar); return [k.slice(0, bar), +k.slice(bar + 1, c), +k.slice(c + 1)]; };
const chunkKey = (x, y) => Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK);

// What a tracked collection has in common: rev, the change notes for the picture cache
// (`dirty`), and the journal since its last frozen copy (for undo).
function tracked(Base) {
  return class extends Base {
    init() {
      this.rev = 0;
      this.dirty = []; // keys changed since the picture cache last looked (null: everything)
      this.journal = []; // keys changed since the last frozen copy (null: too many to list)
      this.frozen = null; // a plain copy of this as it was at some rev, shared by undo steps
      this.frozenRev = -1;
    }
    note(k) {
      this.rev++;
      if (this.dirty) { this.dirty.push(k); if (this.dirty.length > MAX_NOTES) this.dirty = null; }
      if (this.journal) { this.journal.push(k); if (this.journal.length > MAX_NOTES) this.journal = null; }
    }
    // The keys changed since the cache last asked (null: redraw everything), and forget them.
    takeDirty() { const d = this.dirty; this.dirty = []; return d; }
    // A plain copy of this as it is now, made once per change and shared until the next one.
    freeze() {
      if (!this.frozen || this.frozenRev !== this.rev) {
        this.frozen = new Base(this);
        this.frozenRev = this.rev;
        this.journal = [];
        this.copied = this.size; // what the copy cost, for the undo budget
      } else this.copied = 0;
      return this.frozen;
    }
    // Back to a frozen copy: only the keys changed since it, when it's this one's own copy.
    // False when it isn't (the caller then builds a fresh one).
    rollback(to) {
      if (this.frozen !== to || !this.journal) return false;
      if (this.rev === this.frozenRev) return true;
      const keys = new Set(this.journal);
      for (const k of keys) {
        if (this instanceof Set) { if (to.has(k)) this.add(k); else this.delete(k); }
        else if (to.has(k)) this.set(k, to.get(k)); else this.delete(k);
      }
      this.journal = [];
      this.frozenRev = this.rev;
      return true;
    }
  };
}

// A Map keyed by cell ("x,y" on the 32px grid, or on the moss layer's own grid).
export class TrackedMap extends tracked(Map) {
  constructor(entries) {
    super();
    this.init();
    this.buckets = new Map();
    if (entries) for (const [k, v] of entries) this.put(k, v);
  }
  put(k, v) {
    if (!super.has(k)) this.bucket(k, true);
    return super.set(k, v);
  }
  set(k, v) { this.note(k); return this.put(k, v); }
  delete(k) {
    if (!super.delete(k)) return false;
    this.bucket(k, false);
    this.note(k);
    return true;
  }
  clear() { super.clear(); this.buckets.clear(); this.rev++; this.dirty = null; this.journal = null; }
  bucket(k, add) {
    const [x, y] = cellOfKey(k), ck = chunkKey(x, y);
    let b = this.buckets.get(ck);
    if (add) { if (!b) this.buckets.set(ck, (b = new Set())); b.add(k); }
    else if (b) { b.delete(k); if (!b.size) this.buckets.delete(ck); }
  }
  // Every [key, value, x, y] whose cell is inside x0..x1, y0..y1 (inclusive, in cells).
  forEachIn(x0, y0, x1, y1, fn) {
    for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
      for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
        const b = this.buckets.get(cx + ',' + cy);
        if (!b) continue;
        for (const k of b) {
          const [x, y] = cellOfKey(k);
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) fn(k, super.get(k), x, y);
        }
      }
    }
  }
}

// A Set of cell keys (the level's erased cells and the like). No area index: it's read by key.
export class TrackedSet extends tracked(Set) {
  constructor(values) {
    super();
    this.init();
    if (values) for (const v of values) super.add(v);
  }
  add(v) { if (!super.has(v)) this.note(v); return super.add(v); }
  delete(v) { if (!super.delete(v)) return false; this.note(v); return true; }
  clear() { super.clear(); this.rev++; this.dirty = null; this.journal = null; }
}

// The placed tiles, keyed "layer|gx,gy" on each layer's own grid, indexed by layer and area.
export class TrackedTiles extends tracked(Map) {
  constructor(entries) {
    super();
    this.init();
    this.layers = new Map(); // layer -> Map<chunkKey, Set<key>>
    if (entries) for (const [k, v] of entries) this.put(k, v);
  }
  put(k, v) {
    if (!super.has(k)) this.bucket(k, true);
    return super.set(k, v);
  }
  set(k, v) { this.note(k); return this.put(k, v); }
  delete(k) {
    if (!super.delete(k)) return false;
    this.bucket(k, false);
    this.note(k);
    return true;
  }
  clear() { super.clear(); this.layers.clear(); this.rev++; this.dirty = null; this.journal = null; }
  bucket(k, add) {
    const [layer, x, y] = tileOfKey(k), ck = chunkKey(x, y);
    let l = this.layers.get(layer);
    if (!l) { if (!add) return; this.layers.set(layer, (l = new Map())); }
    let b = l.get(ck);
    if (add) { if (!b) l.set(ck, (b = new Set())); b.add(k); }
    else if (b) { b.delete(k); if (!b.size) l.delete(ck); }
  }
}

// Which tiles are near the view. gridOf(layer) -> { size, ox, oy }, the same lookup the editor draws with.
export class TileIndex {
  constructor(gridOf) { this.gridOf = gridOf; }
  // Every tile whose cell centre falls inside the world rect, layer by layer in `order`
  // (back to front) when given.
  forEachInRect(get, wx0, wy0, wx1, wy1, fn, order = null) {
    const layers = order ? order(get.layers.keys()) : get.layers.keys();
    for (const layer of layers) {
      const l = get.layers.get(layer);
      if (!l) continue;
      const g = this.gridOf(layer);
      const x0 = Math.ceil((wx0 - g.ox) / g.size - 0.5), x1 = Math.floor((wx1 - g.ox) / g.size - 0.5);
      const y0 = Math.ceil((wy0 - g.oy) / g.size - 0.5), y1 = Math.floor((wy1 - g.oy) / g.size - 0.5);
      if (x1 < x0 || y1 < y0) continue;
      for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
        for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
          const b = l.get(cx + ',' + cy);
          if (!b) continue;
          for (const k of b) {
            const [, x, y] = tileOfKey(k);
            if (x < x0 || x > x1 || y < y0 || y > y1) continue;
            const t = get.get(k);
            if (t !== undefined) fn(t, k, x, y, g);
          }
        }
      }
    }
  }
}
