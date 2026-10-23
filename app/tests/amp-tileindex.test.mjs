import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackedMap, TrackedSet, TrackedTiles, CHUNK } from '../src/maps/tileindex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');

test('60000 notes on 100 keys stay incremental and rollback restores exactly', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 100; i++) m.set(i + ',0', i);
  const frozen = m.freeze();
  for (let i = 0; i < 60000; i++) {
    const k = (i % 100) + ',0';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const dirty = m.takeDirty();
  assert.ok(dirty !== null, 'dirty state is incremental, not null');
  assert.ok(dirty.size <= 100, 'repeated keys coalesce');
  assert.equal(dirty.chunked, false, 'few keys, no chunk buckets needed');
  assert.equal(m.rollback(frozen), true);
  for (let i = 0; i < 100; i++) assert.equal(m.get(i + ',0'), i, 'rollback restores value ' + i);
  assert.equal(m.size, 100, 'no keys left over');
});

test('tracked sets coalesce repeated notes', () => {
  const s = new TrackedSet();
  for (let i = 0; i < 60000; i++) s.add((i % 100) + ',0');
  const d = s.takeDirty();
  assert.ok(d !== null && d.size <= 100);
});

test('tracked tiles coalesce repeated notes', () => {
  const t = new TrackedTiles();
  for (let i = 0; i < 60000; i++) t.set('layer|' + (i % 100) + ',0', { layer: 'layer', tile: 'x', m: [1, 0, 0, 1] });
  const d = t.takeDirty();
  assert.ok(d !== null && d.size <= 100);
});

test('a long drag keeps notes coalesced and the undo cheap', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 100; i++) m.set(i + ',0', i);
  const frozen = m.freeze();
  // The same hundred cells, dragged over and over: one note each, not one per pass.
  for (let i = 0; i < 60000; i++) m.set((i % 100) + ',0', i);
  assert.equal(m.dirty.size, 100, 'the drag costs one note per cell');
  assert.equal(m.journal.size, 100, 'the journal coalesces too');
  assert.equal(m.journalChunks, false, 'a hundred cells is nowhere near the budget');
  assert.equal(m.rollback(frozen), true, 'the undo steps back over the drag');
  for (let i = 0; i < 100; i++) assert.equal(m.get(i + ',0'), i, 'rollback restores value ' + i);
});

test('past the budget the notes fall back on chunk buckets, not on null', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 60000; i++) m.set(i + ',0', i); // 60000 distinct cells
  const dirty = m.takeDirty();
  assert.ok(dirty !== null, 'dirty state stays incremental, not null');
  assert.ok(dirty.chunked, 'past the budget the notes are chunk buckets');
  assert.ok(dirty.size < 60000, 'the buckets are fewer than the cells: ' + dirty.size);
  assert.ok(dirty.size > 0, 'there are buckets to redraw');
  // The buckets are the cells' own chunks, so a redraw can still find them.
  const first = [...dirty][0];
  assert.match(first, /^\d+,\d+$/, 'a bucket key, not a cell key');
});

test('past the budget the rollback still restores exactly', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 2000; i++) m.set(i + ',0', 'v' + i);
  const frozen = m.freeze();
  const before = new Map(m);
  for (let i = 0; i < 60000; i++) m.set(i + ',0', 'w' + i); // past the budget
  for (let i = 0; i < 1000; i++) m.delete(i + ',0'); // and some taken away
  assert.equal(m.journalChunks, true, 'the journal fell back on buckets');
  assert.equal(m.rollback(frozen), true, 'the undo still steps back');
  assert.equal(m.size, before.size, 'the same keys as before');
  for (const [k, v] of before) assert.equal(m.get(k), v, 'rollback restores ' + k);
});

test('past the budget a set and a map of tiles come back whole', () => {
  const s = new TrackedSet();
  for (let i = 0; i < 500; i++) s.add(i + ',0');
  const sFrozen = s.freeze();
  const sBefore = new Set(s);
  for (let i = 0; i < 60000; i++) s.add(i + ',0');
  for (let i = 0; i < 200; i++) s.delete(i + ',0');
  assert.equal(s.rollback(sFrozen), true, 'the set undoes');
  assert.deepEqual([...s].sort(), [...sBefore].sort(), 'the set is whole again');

  const t = new TrackedTiles();
  for (let i = 0; i < 500; i++) t.set('L|' + i + ',0', 'v' + i);
  const tFrozen = t.freeze();
  const tBefore = new Map(t);
  for (let i = 0; i < 60000; i++) t.set('L|' + i + ',0', 'w' + i);
  for (let i = 0; i < 200; i++) t.delete('L|' + i + ',0');
  assert.equal(t.rollback(tFrozen), true, 'the tiles undo');
  assert.equal(t.size, tBefore.size, 'the same tiles as before');
  for (const [k, v] of tBefore) assert.equal(t.get(k), v, 'rollback restores ' + k);
});

test('a rollback leaves the collection incremental again', () => {
  const m = new TrackedMap();
  m.set('1,1', 'a');
  const frozen = m.freeze();
  m.set('1,1', 'b');
  assert.equal(m.rollback(frozen), true);
  assert.equal(m.get('1,1'), 'a', 'the value is back');
  assert.equal(m.takeDirty().size, 1, 'the undo itself is a change to redraw');
  m.set('2,2', 'c');
  const d = m.takeDirty();
  assert.equal(d.size, 1, 'notes are incremental again');
  assert.equal(d.chunked, false, 'and not buckets');
});

test('the frozen copy is shared until the next change', () => {
  const m = new TrackedMap();
  m.set('1,1', 'a');
  const f1 = m.freeze();
  assert.equal(m.freeze(), f1, 'the same copy is handed out again');
  m.set('1,1', 'b');
  const f2 = m.freeze();
  assert.notEqual(f2, f1, 'a change makes a new copy');
  assert.equal(m.journal.size, 0, 'the journal is bounded by the undo step');
  assert.equal(m.rollback(f1), false, 'another step\'s copy is not this one\'s own');
});

test('clearing still means everything changed', () => {
  const m = new TrackedMap();
  m.set('1,1', 'a');
  m.clear();
  assert.equal(m.takeDirty(), null, 'a cleared collection redraws everything');
  m.set('2,2', 'b');
  const d = m.takeDirty();
  assert.equal(d.size, 1, 'and the notes start again afterwards');
});

test('the area index still walks only the buckets it is asked for', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 100; i++) m.set(i + ',3', i);
  const seen = [];
  m.forEachIn(0, 3, 49, 3, (k, v, x, y) => seen.push(k));
  assert.equal(seen.length, 50, 'forEachIn over the rect');
  const t = new TrackedTiles();
  for (let i = 0; i < 10; i++) t.set('L|' + i + ',2', i);
  assert.equal(t.size, 10, 'tiles keep their keys');
  const s = new TrackedSet();
  for (let i = 0; i < 10; i++) s.add(i + ',0');
  assert.equal(s.size, 10, 'sets keep their keys');
});

test('the editor draws the chunk buckets the notes fall back on', () => {
  const src = fs.readFileSync(path.join(mapsDir, 'editor.js'), 'utf8');
  assert.match(src, /import \{[^}]*CHUNK[^}]*\} from '\.\/tileindex\.js'/, 'the editor knows the chunk size');
  assert.match(src, /cellChunkRect/, 'cells have chunk rects');
  assert.match(src, /mossChunkRect/, 'moss has chunk rects');
  assert.match(src, /tileChunkRect/, 'tiles have chunk rects');
  assert.equal(CHUNK, 32, 'the bucket size the editor draws with');
});

// ---- the bucketed, shared copies (undo steps share every area that didn't change) ----
const sameContent = (live, ref) => { assert.equal(live.size, ref.size); for (const [k, v] of ref) assert.equal(live.get(k), v, 'value of ' + k); for (const k of live.keys()) assert.ok(ref.has(k), 'no extra ' + k); };

test('a frozen copy reads like the map it was taken from and shares the areas that did not change', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 4000; i++) m.set((i % 200) + ',' + Math.floor(i / 200), 'ground');
  const f1 = m.freeze();
  assert.equal(f1.size, 4000);
  assert.equal(f1.get('5,5'), 'ground');
  assert.equal(f1.has('999,999'), false);
  assert.equal([...f1].length, 4000);
  m.set('3,3', 'dark');
  m.delete('150,10');
  const f2 = m.freeze();
  assert.equal(f2.get('3,3'), 'dark');
  assert.equal(f1.get('3,3'), 'ground', 'the older copy is untouched');
  assert.equal(f2.size, 3999);
  let shared = 0, total = 0;
  for (const [ck, c] of f2.chunks) { total++; if (f1.chunks.get(ck) === c) shared++; }
  assert.ok(shared >= total - 2, 'only the touched areas were copied again (' + shared + '/' + total + ')');
  assert.ok(m.copied < 2500, 'the copy cost is the touched areas, not the map: ' + m.copied);
});

test('restore puts the map back to any older copy, touching only the areas that differ', () => {
  const m = new TrackedMap();
  const ref = [];
  const snap = () => ref.push([m.freeze(), new Map(m)]);
  for (let i = 0; i < 3000; i++) m.set((i % 100) + ',' + Math.floor(i / 100), 'a' + (i % 3));
  snap();
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < 12; step++) {
    for (let j = 0; j < 40; j++) {
      const k = Math.floor(rnd() * 120) + ',' + Math.floor(rnd() * 40);
      if (rnd() < 0.4) m.delete(k); else m.set(k, 'v' + step + '_' + j);
    }
    snap();
  }
  for (const idx of [3, 11, 0, 7, 12, 1, 6, 6]) {
    const [f, want] = ref[idx];
    assert.equal(m.restore(f), true, 'restored in place');
    sameContent(m, want);
    assert.equal(m.freeze(), f, 'the restored state is that copy');
    assert.equal(m.keysInChunks(new Set(['0,0'])).size > 0, true);
    for (const k of m.keys()) assert.ok([...m.buckets.get(m.chunkKeyOf(k))].includes(k), 'indexed ' + k);
  }
});

test('restore notes what changed so the picture cache redraws only that', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 2000; i++) m.set((i % 80) + ',' + Math.floor(i / 80), 'g');
  const f1 = m.freeze();
  m.set('5,5', 'x'); m.delete('70,20');
  const f2 = m.freeze();
  m.takeDirty();
  assert.equal(m.restore(f1), true);
  const d = m.takeDirty();
  assert.ok(d.size > 0 && d.size < 100, 'a few notes, not everything: ' + d.size);
  assert.equal(m.get('5,5'), 'g');
  assert.equal(m.get('70,20'), 'g');
  assert.equal(m.restore(f2), true);
  assert.equal(m.get('5,5'), 'x');
  assert.equal(m.has('70,20'), false);
});

test('restore keeps the entries in exactly the order the copy had, whatever was done since', () => {
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const Make of [TrackedMap, TrackedTiles]) {
    const key = (i, j) => (Make === TrackedMap ? i + ',' + j : (i % 2 ? 'a' : 'b') + '|' + i + ',' + j);
    const m = new Make();
    const copies = [];
    for (let step = 0; step < 40; step++) {
      for (let j = 0; j < 30; j++) {
        const k = key(Math.floor(rnd() * 90), Math.floor(rnd() * 70));
        if (rnd() < 0.45) m.delete(k); else m.set(k, { v: step * 100 + j });
      }
      if (step % 2) copies.push([m.freeze(), [...m]]);
    }
    for (const idx of [5, 17, 2, 19, 0, 11, 11, 18, 3]) {
      const [f, want] = copies[idx];
      assert.equal(m.restore(f), true);
      assert.deepEqual([...m].map(([k, v]) => [k, v.v]), want.map(([k, v]) => [k, v.v]), 'copy ' + idx + ': same entries in the same order');
      // and the live index agrees with its entries
      for (const k of m.keys()) assert.ok(m.keysInChunks(new Set([m.chunkKeyOf(k)])).has(k));
      assert.equal(m.freeze(), f);
      // a few more edits (the restored map goes on being edited)
      m.set(key(1, 1), { v: -1 }); m.delete(key(2, 2));
    }
  }
});

test('tiles restore across layers, and a cleared map restores from a fresh copy', () => {
  const t = new TrackedTiles();
  t.set('front|1,1', { tile: 'a' }); t.set('back|40,3', { tile: 'b' });
  const f1 = t.freeze();
  t.set('front|70,70', { tile: 'c' }); t.delete('back|40,3');
  const f2 = t.freeze();
  assert.equal(t.restore(f1), true);
  assert.deepEqual([...t.keys()].sort(), ['back|40,3', 'front|1,1']);
  assert.equal(t.get('front|1,1').tile, 'a');
  assert.equal(t.restore(f2), true);
  assert.deepEqual([...t.keys()].sort(), ['front|1,1', 'front|70,70']);
  t.clear();
  assert.equal(t.restore(f1), true, 'a cleared map has no journal: it is rebuilt from the copy');
  assert.deepEqual([...t.keys()], ['front|1,1', 'back|40,3']);
  assert.equal(t.get('back|40,3').tile, 'b');
  const rebuilt = new TrackedTiles(f1);
  assert.equal(rebuilt.size, 2);
});

test('past the note budget restore still lands exactly', () => {
  const m = new TrackedMap();
  for (let i = 0; i < 300; i++) m.set(i + ',0', 1);
  const f1 = m.freeze();
  for (let i = 0; i < 60000; i++) m.set((i % 400) + ',' + (1 + Math.floor(i / 400)), i);
  m.delete('3,0');
  assert.equal(m.journalChunks, true);
  assert.equal(m.restore(f1), true);
  assert.equal(m.size, 300);
  for (let i = 0; i < 300; i++) assert.equal(m.get(i + ',0'), 1);
});

test('extent reads the box off the outermost areas and matches a full walk', () => {
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const m = new TrackedMap();
  assert.equal(m.extent(), null);
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < 400; i++) {
      const k = (Math.floor(rnd() * 600) - 250) + ',' + (Math.floor(rnd() * 500) - 120);
      if (rnd() < 0.3) m.delete(k); else m.set(k, 'g');
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of m.keys()) { const [x, y] = k.split(',').map(Number); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    assert.deepEqual(m.extent(), m.size ? [x0, y0, x1, y1] : null, 'round ' + round);
  }
});

test('copies and restores keep the Map\'s order through rollbacks too, as copying the whole Map would', () => {
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const Make of [TrackedMap, TrackedTiles]) {
    const key = (i, j) => (Make === TrackedMap ? i + ',' + j : ['a', 'b', 'c'][(i * 7 + j) % 3] + '|' + i + ',' + j);
    const m = new Make();
    const order = new Map(); // a copy -> the entries the Map had when the copy was made
    const copies = [];
    for (let step = 0; step < 120; step++) {
      for (let j = 0; j < 12; j++) {
        const k = key(Math.floor(rnd() * 60), Math.floor(rnd() * 50));
        if (rnd() < 0.45) m.delete(k); else m.set(k, step * 100 + j);
      }
      const r = rnd();
      if (r < 0.4) {
        const f = m.freeze();
        if (!order.has(f)) { order.set(f, [...m]); copies.push(f); assert.deepEqual([...f], [...m], 'a new copy lists the Map as it is'); }
      } else if (r < 0.6 && m.frozen) {
        assert.equal(m.rollback(m.frozen), true); // a drag's rollback to the last copy
      } else if (r < 0.9 && copies.length) {
        const f = copies[Math.floor(rnd() * copies.length)];
        assert.equal(m.restore(f), true);
        assert.deepEqual([...m], order.get(f), 'restored: the entries in the copy\'s order');
        if (Make === TrackedTiles) assert.deepEqual([...m.layers.keys()], [...new Set([...m.keys()].map((k) => k.slice(0, k.indexOf('|'))))], 'layers in the order of their first tile');
        for (const k of m.keys()) assert.ok(m.keysInChunks(new Set([m.chunkKeyOf(k)])).has(k), 'indexed');
        // every bucket lists its keys in the Map's order
        const seen = new Map();
        for (const k of m.keys()) { const ck = m.chunkKeyOf(k); (seen.get(ck) || seen.set(ck, []).get(ck)).push(k); }
        for (const [ck, ks] of seen) assert.deepEqual([...m.bucketOf(ck)], ks, 'bucket ' + ck + ' in the Map\'s order');
      }
    }
  }
});
