// The editor's cell collections, tracked: each counts changes, notes which keys changed (picture cache and undo/drag redo only what moved), and indexes keys by area so drawing, hovering and box-select skip distant cells.
export const CHUNK = 32; // cells per side of an area bucket
const MAX_NOTES = 50000; // past this many distinct keys, notes coalesce onto their CHUNK buckets

const cellOfKey = (k) => { const c = k.indexOf(','); return [+k.slice(0, c), +k.slice(c + 1)]; };
const tileOfKey = (k) => { const bar = k.lastIndexOf('|'), c = k.indexOf(',', bar); return [k.slice(0, bar), +k.slice(bar + 1, c), +k.slice(c + 1)]; };
const chunkKey = (x, y) => Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK);

// A persistent copy of a cell collection as it was at some rev: its entries grouped by area bucket (CHUNK cells a side).
// The next copy shares every bucket that didn't change, so taking one costs the touched buckets, not the whole map, and
// two copies differ only in the buckets that are not the same object. Reads like the Map it was copied from, in the same order:
// every entry carries the number it was inserted under (`seq`, which only goes up), and a Map's order is by that number.
class Frozen {
  constructor(chunks, size, chunkOf) {
    this.chunks = chunks; // bucket key -> { m: Map(key -> value), q: [seq of each entry, in m's order] }, never modified once made
    this.size = size;
    this.chunkOf = chunkOf;
  }
  has(k) { const c = this.chunks.get(this.chunkOf(k)); return c !== undefined && c.m.has(k); }
  get(k) { const c = this.chunks.get(this.chunkOf(k)); return c === undefined ? undefined : c.m.get(k); }
  // [seq, key, value] of every entry, in the order of the Map this was copied from.
  ordered() {
    const n = this.size, ks = new Array(n), vs = new Array(n), qs = new Float64Array(n);
    let j = 0;
    for (const c of this.chunks.values()) { let i = 0; for (const [k, v] of c.m) { ks[j] = k; vs[j] = v; qs[j++] = c.q[i++]; } }
    return { ks, vs, qs, order: orderBy(qs, j) };
  }
  *entries() { const { ks, vs, order } = this.ordered(); for (let i = 0; i < order.length; i++) yield [ks[order[i]], vs[order[i]]]; }
  *keys() { const { ks, order } = this.ordered(); for (let i = 0; i < order.length; i++) yield ks[order[i]]; }
  *values() { const { vs, order } = this.ordered(); for (let i = 0; i < order.length; i++) yield vs[order[i]]; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(fn) { for (const [k, v] of this.entries()) fn(v, k, this); }
}
// The indices 0..n-1 sorted by qs (unique numbers); a packed native sort when they fit, a comparator sort when not.
function orderBy(qs, n) {
  if (n < 131072) {
    let big = false;
    for (let i = 0; i < n; i++) if (!(qs[i] < 4e9)) { big = true; break; }
    if (!big) {
      const pk = new Float64Array(n);
      for (let i = 0; i < n; i++) pk[i] = qs[i] * 131072 + i;
      pk.sort();
      const out = new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = pk[i] - Math.floor(pk[i] / 131072) * 131072;
      return out;
    }
  }
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => qs[a] - qs[b]);
  return idx;
}

// What a tracked collection has in common: rev, the change notes for the picture cache
// (`dirty`), and the journal since its last frozen copy (for undo). Notes coalesce by key,
// and past MAX_NOTES distinct keys collapse onto their CHUNK buckets instead of becoming null.
function tracked(Base, chunkOf) {
  const toChunk = chunkOf || ((k) => k);
  return class extends Base {
    chunkKeyOf(k) { return toChunk(k); }
    init() {
      this.rev = 0;
      this.dirty = new Set(); // keys changed since the picture cache last looked (null: everything)
      this.dirtyChunks = false; // whether `dirty` holds chunk keys
      this.journal = new Set(); // keys changed since the last frozen copy (null: not listable)
      this.journalChunks = false; // whether `journal` holds chunk keys
      this.gone = new Set(); // keys taken away since the last frozen copy, by name
      this.drift = new Set(); // keys a rollback put back at the end of the Map, which the last frozen copy has elsewhere in its order
      this.stored = null; // keys changed since the draft was last written out piecemeal (null: not tracking, write everything)
      this.storedChunks = false; // whether `stored` holds chunk keys
      this.frozen = null; // a plain copy of this as it was at some rev, shared by undo steps
      this.frozenRev = -1;
    }
    // One note into a set of keys: a key already there costs nothing, and past the budget
    // the set collapses onto the CHUNK buckets the keys sit in (a rect is all a redraw needs).
    // Returns whether the set now holds chunk keys.
    _noteSet(set, chunkedFlag, k) {
      if (chunkedFlag) { set.add(this.chunkKeyOf(k)); return true; }
      set.add(k);
      if (set.size > MAX_NOTES) {
        const chunks = new Set();
        for (const key of set) chunks.add(this.chunkKeyOf(key));
        set.clear();
        for (const c of chunks) set.add(c);
        return true;
      }
      return false;
    }
    // The keys of this collection inside the given chunk buckets. The bucket index answers
    // this in the time the buckets take; the plain walk is the fallback.
    keysInChunks(chunks) {
      const out = new Set();
      for (const k of this.keys()) if (chunks.has(this.chunkKeyOf(k))) out.add(k);
      return out;
    }
    note(k, removed) {
      this.rev++;
      if (removed && this.gone) this.gone.add(k); // a bucket says where a key was, not which one
      if (this.dirty) this.dirtyChunks = this._noteSet(this.dirty, this.dirtyChunks, k);
      if (this.journal) this.journalChunks = this._noteSet(this.journal, this.journalChunks, k);
      if (this.stored) this.storedChunks = this._noteSet(this.stored, this.storedChunks, k);
    }
    // Note whole buckets as changed (a rebuild changes the order of the entries of some, and the content of those only). A set of notes
    // that is null (everything) stays null; one of cell keys becomes one of buckets.
    noteBuckets(prop, flagProp, cks) {
      const set = this[prop];
      if (!set) return;
      if (!this[flagProp]) {
        const chunks = new Set();
        for (const k of set) chunks.add(this.chunkKeyOf(k));
        this[prop] = chunks;
        this[flagProp] = true;
      }
      for (const ck of cks) this[prop].add(ck);
    }
    // From now on, note what changes for the piecemeal draft write.
    trackStored() { this.stored = new Set(); this.storedChunks = false; }
    // The bucket keys that changed since trackStored (null: everything, the tracking was lost), and start over.
    takeStored() {
      const s = this.stored;
      if (!s) return null;
      const out = new Set();
      for (const k of s) out.add(this.storedChunks ? k : this.chunkKeyOf(k));
      this.stored = new Set();
      this.storedChunks = false;
      return out;
    }
    // The keys changed since the cache last asked (null: redraw everything), and forget them.
    // The set says on its `chunked` flag whether the keys are cells or chunk buckets.
    takeDirty() {
      const d = this.dirty;
      const chunked = this.dirtyChunks;
      this.dirty = new Set();
      this.dirtyChunks = false;
      if (d && typeof d === 'object') d.chunked = chunked;
      return d;
    }
    // A copy of this as it is now, made once per change and shared until the next one.
    freeze() {
      if (!this.frozen || this.frozenRev !== this.rev) {
        const { frozen, copied } = this.snapshotNow();
        this.frozen = frozen;
        this.frozenRev = this.rev;
        this.journal = new Set(); // the journal is bounded by the undo step, not by a count
        this.journalChunks = false;
        this.gone = new Set(); // so are the keys that went away
        this.copied = copied; // what the copy cost, for the undo budget
      } else this.copied = 0;
      return this.frozen;
    }
    // The plain copy (a Set, small); the cell collections override this with the bucketed, shared one.
    snapshotNow() { return { frozen: new Base(this), copied: this.size }; }
    // This put in place to match another frozen copy, touching only what differs; false when it can't (the caller builds a fresh one).
    restore() { return false; }
    // Back to a frozen copy: only the keys changed since it, when it's this one's own copy.
    // False when it isn't (the caller then builds a fresh one).
    rollback(to) {
      if (this.frozen !== to || !this.journal) return false;
      if (this.rev === this.frozenRev) return true;
      const chunks = this.journal;
      const chunked = this.journalChunks;
      const keys = new Set();
      if (chunked) {
        // Buckets, not keys: every key of the touched buckets goes back to its frozen value,
        // which is the frozen state of those buckets. The rest never changed. The keys that
        // went away are named, so they come back too.
        for (const k of this.keysInChunks(chunks)) keys.add(k);
        for (const k of this.gone) keys.add(k);
      } else {
        for (const k of chunks) keys.add(k);
      }
      // A key put back here goes to the end of the Map, not where the copy had it: the copy is no longer this Map's exact
      // order for it. It is remembered, so the next copy made takes its area again, and a restore sees it differ.
      const readded = this.drift;
      for (const k of keys) {
        if (this instanceof Set) { if (to.has(k)) this.add(k); else this.delete(k); }
        else if (to.has(k)) { if (!Map.prototype.has.call(this, k)) readded.add(k); this.set(k, to.get(k)); } else this.delete(k);
      }
      this.journal = new Set();
      this.journalChunks = false;
      this.gone = new Set();
      this.frozenRev = this.rev;
      return true;
    }
  };
}

// The bucketed copy and the in-place restore the two bucketed collections share (they differ in how a bucket is found).
const bucketed = {
  snapshotNow() {
    const prev = this.frozen;
    let chunks, copied = 0;
    const copyChunk = (b) => {
      const m = new Map(), q = new Array(b.size);
      let i = 0;
      for (const k of b) { m.set(k, Map.prototype.get.call(this, k)); q[i++] = this.seqs.get(k); }
      copied += m.size;
      return { m, q };
    };
    if (prev instanceof Frozen && this.journal) {
      // Only the buckets touched since the last copy are made again; the rest are the last copy's own.
      chunks = new Map(prev.chunks);
      const touched = new Set();
      for (const k of this.journal) touched.add(this.journalChunks ? k : this.chunkKeyOf(k));
      for (const k of this.drift) touched.add(this.chunkKeyOf(k));
      for (const ck of touched) {
        const b = this.bucketOf(ck);
        if (b && b.size) chunks.set(ck, copyChunk(b)); else chunks.delete(ck);
      }
      copied += chunks.size >> 4;
    } else {
      chunks = new Map();
      for (const [ck, b] of this.allBuckets()) chunks.set(ck, copyChunk(b));
    }
    this.drift = new Set(); // (the copy has them as they are now)
    return { frozen: new Frozen(chunks, this.size, this.chunkKeyOf.bind(null)), copied }; // (bound to nothing: a copy doesn't keep the live map alive)
  },
  // Put back to another copy. Every bucket that differs between this one's last copy and the target (or was touched since) is made to
  // match and the rest are shared and skipped. Entries of the target that were taken away since go back where they were in its order -
  // the Map is laid out again once, in order, merging them in - so the order is exactly the target's, as a rebuild from it would give.
  restore(to) {
    if (!(to instanceof Frozen)) return false;
    const from = this.frozen;
    if (!(from instanceof Frozen) || !this.journal) { this.rebuildFrom(to); return true; }
    const affected = new Set();
    for (const [ck, c] of to.chunks) if (from.chunks.get(ck) !== c) affected.add(ck);
    for (const ck of from.chunks.keys()) if (!to.chunks.has(ck)) affected.add(ck);
    for (const k of this.journal) affected.add(this.journalChunks ? k : this.chunkKeyOf(k));
    for (const k of this.gone) affected.add(this.chunkKeyOf(k));
    for (const k of this.drift) affected.add(this.chunkKeyOf(k));
    const missing = []; // [seq, key, value]: in the target, absent now (or present under a newer number: taken away and put back)
    for (const ck of affected) {
      const want = to.chunks.get(ck);
      const b = this.bucketOf(ck);
      if (b) for (const k of [...b]) if (!want || !want.m.has(k)) this.delete(k);
      if (!want) continue;
      let i = 0;
      for (const [k, v] of want.m) {
        const q = want.q[i++], have = this.seqs.get(k);
        if (have === q) { if (Map.prototype.get.call(this, k) !== v) this.set(k, v); }
        else { if (have !== undefined) this.delete(k); missing.push([q, k, v]); }
      }
    }
    if (missing.length) {
      // What is left is the target's own entries with its own numbers, so the highest number here is read off the target.
      let top = -1;
      for (const [ck, c] of to.chunks) if (!affected.has(ck)) for (let i = 0; i < c.q.length; i++) if (c.q[i] > top) top = c.q[i];
      for (const ck of affected) {
        const want = to.chunks.get(ck);
        if (!want) continue;
        let i = 0;
        for (const k of want.m.keys()) { const q = want.q[i++]; if (q > top && this.seqs.get(k) === q) top = q; }
      }
      this.reinsert(missing, top);
      // The buckets list their keys in the order the Map has them (an area query walks them in it), so the touched ones are laid out as the copy had them.
      for (const ck of affected) {
        const want = to.chunks.get(ck);
        this.setBucket(ck, want ? [...want.m.keys()] : null);
      }
    }
    this.frozen = to;
    this.frozenRev = this.rev;
    this.journal = new Set();
    this.journalChunks = false;
    this.gone = new Set();
    this.drift = new Set();
    this.reorderLayers?.(to);
    return true;
  },
  // Puts entries back in the Map at the places their numbers give them (the live entries are already in order).
  reinsert(missing, top = Infinity) {
    missing.sort((a, b) => a[0] - b[0]);
    // All of them after every entry here (an undone placement put back): they just go on the end.
    if (missing[0][0] > top) {
      for (const [q, k, v] of missing) {
        Map.prototype.set.call(this, k, v);
        this.seqs.set(k, q);
        if (q >= this.nextSeq) this.nextSeq = q + 1;
        this.note(k);
      }
      return;
    }
    const flat = [];
    let mi = 0;
    for (const [k, v] of this) {
      const q = this.seqs.get(k);
      while (mi < missing.length && missing[mi][0] < q) { flat.push(missing[mi][1], missing[mi][2]); mi++; }
      flat.push(k, v);
    }
    for (; mi < missing.length; mi++) flat.push(missing[mi][1], missing[mi][2]);
    Map.prototype.clear.call(this);
    for (let i = 0; i < flat.length; i += 2) Map.prototype.set.call(this, flat[i], flat[i + 1]);
    for (const [q, k] of missing) {
      this.seqs.set(k, q);
      if (q >= this.nextSeq) this.nextSeq = q + 1;
      this.note(k);
    }
  },
  // `affected`: the buckets that can differ from what this holds now (null: unknown, so all of them).
  rebuildFrom(to, affected = null) {
    const { ks, vs, qs, order } = to.ordered();
    Map.prototype.clear.call(this);
    this.clearIndex();
    this.seqs.clear();
    let top = -1;
    for (let i = 0; i < order.length; i++) {
      const j = order[i], k = ks[j];
      Map.prototype.set.call(this, k, vs[j]);
      this.bucket(k, true);
      this.seqs.set(k, qs[j]);
      if (qs[j] > top) top = qs[j];
    }
    if (top >= this.nextSeq) this.nextSeq = top + 1;
    this.rev++;
    if (affected) { this.noteBuckets('dirty', 'dirtyChunks', affected); this.noteBuckets('stored', 'storedChunks', affected); }
    else { this.dirty = null; this.stored = null; } // everything may have changed: the picture cache draws it all again
    this.frozen = to;
    this.frozenRev = this.rev;
    this.journal = new Set();
    this.journalChunks = false;
    this.gone = new Set();
    this.drift = new Set();
  },
};

// A Map keyed by cell ("x,y" on the 32px grid, or on the moss layer's own grid).
export class TrackedMap extends tracked(Map, (k) => { const c = k.indexOf(','); return chunkKey(+k.slice(0, c), +k.slice(c + 1)); }) {
  constructor(entries) {
    super();
    this.init();
    this.buckets = new Map();
    this.seqs = new Map(); // key -> the number it was inserted under; the Map's order is by it
    this.nextSeq = 0;
    if (entries) for (const [k, v] of entries) this.put(k, v);
  }
  put(k, v) {
    if (!super.has(k)) { this.bucket(k, true); this.seqs.set(k, this.nextSeq++); }
    return super.set(k, v);
  }
  set(k, v) { this.note(k); return this.put(k, v); }
  delete(k) {
    if (!super.delete(k)) return false;
    this.bucket(k, false);
    this.seqs.delete(k);
    this.note(k, true);
    return true;
  }
  snapshotNow() { return bucketed.snapshotNow.call(this); }
  restore(to) { return bucketed.restore.call(this, to); }
  rebuildFrom(to, affected) { return bucketed.rebuildFrom.call(this, to, affected); }
  reinsert(missing, top) { return bucketed.reinsert.call(this, missing, top); }
  clearIndex() { this.buckets.clear(); }
  setBucket(ck, keys) { if (keys && keys.length) this.buckets.set(ck, new Set(keys)); else this.buckets.delete(ck); }
  bucketOf(ck) { return this.buckets.get(ck); }
  allBuckets() { return this.buckets; }
  clear() { super.clear(); this.buckets.clear(); this.seqs.clear(); this.rev++; this.dirty = null; this.journal = null; this.gone = null; this.stored = null; }
  bucket(k, add) {
    const [x, y] = cellOfKey(k), ck = chunkKey(x, y);
    let b = this.buckets.get(ck);
    if (add) { if (!b) this.buckets.set(ck, (b = new Set())); b.add(k); }
    else if (b) { b.delete(k); if (!b.size) this.buckets.delete(ck); }
  }
  // The bucket index knows which keys sit in a bucket, so the touched ones are a lookup.
  keysInChunks(chunks) {
    const out = new Set();
    for (const ck of chunks) { const b = this.buckets.get(ck); if (b) for (const k of b) out.add(k); }
    return out;
  }
  // [x0, y0, x1, y1], the smallest box holding every key (null when empty), from the area index: a key in one of the outermost
  // areas is the extreme in that direction, so only those few areas' keys are read.
  extent() {
    if (!this.size) return null;
    let cx0 = Infinity, cx1 = -Infinity, cy0 = Infinity, cy1 = -Infinity;
    const at = [];
    for (const ck of this.buckets.keys()) {
      const c = ck.indexOf(','), cx = +ck.slice(0, c), cy = +ck.slice(c + 1);
      at.push(cx, cy);
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx; if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i = 0;
    for (const b of this.buckets.values()) {
      const cx = at[i++], cy = at[i++];
      if (cx !== cx0 && cx !== cx1 && cy !== cy0 && cy !== cy1) continue;
      for (const k of b) {
        const [x, y] = cellOfKey(k);
        if (cx === cx0 && x < x0) x0 = x; if (cx === cx1 && x > x1) x1 = x;
        if (cy === cy0 && y < y0) y0 = y; if (cy === cy1 && y > y1) y1 = y;
      }
    }
    return [x0, y0, x1, y1];
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
export class TrackedSet extends tracked(Set, (k) => { const c = k.indexOf(','); return chunkKey(+k.slice(0, c), +k.slice(c + 1)); }) {
  constructor(values) {
    super();
    this.init();
    if (values) for (const v of values) super.add(v);
  }
  add(v) { if (!super.has(v)) this.note(v); return super.add(v); }
  delete(v) { if (!super.delete(v)) return false; this.note(v, true); return true; }
  clear() { super.clear(); this.rev++; this.dirty = null; this.journal = null; this.gone = null; this.stored = null; }
}

// The placed tiles, keyed "layer|gx,gy" on each layer's own grid, indexed by layer and area.
export class TrackedTiles extends tracked(Map, (k) => {
  const bar = k.lastIndexOf('|'), c = k.indexOf(',', bar);
  return k.slice(0, bar) + '|' + chunkKey(+k.slice(bar + 1, c), +k.slice(c + 1));
}) {
  constructor(entries) {
    super();
    this.init();
    this.layers = new Map(); // layer -> Map<chunkKey, Set<key>>
    this.seqs = new Map(); // key -> the number it was inserted under; the Map's order is by it
    this.nextSeq = 0;
    if (entries) for (const [k, v] of entries) this.put(k, v);
  }
  put(k, v) {
    if (!super.has(k)) { this.bucket(k, true); this.seqs.set(k, this.nextSeq++); }
    return super.set(k, v);
  }
  set(k, v) { this.note(k); return this.put(k, v); }
  delete(k) {
    if (!super.delete(k)) return false;
    this.bucket(k, false);
    this.seqs.delete(k);
    this.note(k, true);
    return true;
  }
  snapshotNow() { return bucketed.snapshotNow.call(this); }
  restore(to) { return bucketed.restore.call(this, to); }
  rebuildFrom(to, affected) { return bucketed.rebuildFrom.call(this, to, affected); }
  reinsert(missing, top) { return bucketed.reinsert.call(this, missing, top); }
  clearIndex() { this.layers.clear(); }
  // The layers are listed in the order their first tile has in the Map (which a full rebuild gives, and the area queries go by), so after a
  // restore they are put in that order from the copy, and a layer with no tile left is not listed.
  reorderLayers(to) {
    const first = new Map();
    for (const [ck, c] of to.chunks) {
      const layer = ck.slice(0, ck.lastIndexOf('|'));
      let m = Infinity;
      for (const q of c.q) if (q < m) m = q;
      if (!(first.get(layer) <= m)) first.set(layer, m);
    }
    const order = [...first].sort((a, b) => a[1] - b[1]).map(([layer]) => layer);
    const now = [...this.layers.keys()];
    if (order.length === now.length && order.every((l, i) => l === now[i])) return;
    const next = new Map();
    for (const layer of order) next.set(layer, this.layers.get(layer) || new Map());
    this.layers = next;
  }
  setBucket(ck, keys) {
    const bar = ck.lastIndexOf('|'), layer = ck.slice(0, bar), sub = ck.slice(bar + 1);
    let l = this.layers.get(layer);
    if (keys && keys.length) {
      if (!l) this.layers.set(layer, (l = new Map()));
      l.set(sub, new Set(keys));
    } else if (l) l.delete(sub);
  }
  bucketOf(ck) {
    const bar = ck.lastIndexOf('|'), l = this.layers.get(ck.slice(0, bar));
    return l && l.get(ck.slice(bar + 1));
  }
  *allBuckets() { for (const [layer, l] of this.layers) for (const [ck, b] of l) yield [layer + '|' + ck, b]; }
  clear() { super.clear(); this.layers.clear(); this.seqs.clear(); this.rev++; this.dirty = null; this.journal = null; this.gone = null; this.stored = null; }
  bucket(k, add) {
    const [layer, x, y] = tileOfKey(k), ck = chunkKey(x, y);
    let l = this.layers.get(layer);
    if (!l) { if (!add) return; this.layers.set(layer, (l = new Map())); }
    let b = l.get(ck);
    if (add) { if (!b) l.set(ck, (b = new Set())); b.add(k); }
    else if (b) { b.delete(k); if (!b.size) l.delete(ck); }
  }
  // The bucket index knows which keys sit in a bucket, so the touched ones are a lookup.
  // A tile's bucket key carries its layer, the index keeps the layers apart.
  keysInChunks(chunks) {
    const out = new Set();
    for (const ck of chunks) {
      const bar = ck.lastIndexOf('|'), l = this.layers.get(ck.slice(0, bar));
      if (!l) continue;
      const b = l.get(ck.slice(bar + 1));
      if (b) for (const k of b) out.add(k);
    }
    return out;
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
