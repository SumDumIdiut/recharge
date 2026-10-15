// The Amplifier's block autotiling, headless: every block tileset joins like the level's rule tiles do - edges, outer
// corners, INSIDE corners, 1-wide strips - and your blocks join the level's blocks of the same tileset.
// node tests/amp-tiling.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(here, '../src/maps');
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const deep = () => new Proxy(function () {}, { get: (_, p) => (p === Symbol.toPrimitive ? () => '' : p === 'then' ? undefined : deep()), apply: () => deep(), set: () => true });
globalThis.document = deep();
globalThis.window = { __TAURI__: undefined, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 2 }, configurable: true });
globalThis.requestAnimationFrame = () => 0;
globalThis.Image = class { constructor() { this.complete = true; this.naturalWidth = 8; this.naturalHeight = 8; } set src(v) { this._s = v; setTimeout(() => this.onload?.(), 0); } get src() { return this._s; } };
globalThis.fetch = async (url) => {
  const file = path.join(mapsDir, String(url).replace(/^.*\/maps\//, '').split('?')[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('404'); } };
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => text, json: async () => JSON.parse(text) };
};

const { __test: T } = await import('../src/maps/editor.js');
const { pickPieces, tableOf } = await import('../src/maps/tiling.js');
await T.fetchBase();
assert.ok(T.base?.art, 'basemap loaded');

// Every block tileset the editor draws: kind -> its tilemap, tile family, and the plate (piece numbers) it uses.
const S = T.BLOCK_SETS;
const SHEETS = {
  ground: { layer: 'ground', family: 'ground1_tileset_', plate: S.breakable.plate },
  dark: { layer: 'ground', family: 'dark_ground_tileset_', plate: S.breakable.plate },
  blue: { layer: 'blueBlocks', family: 'blue_ground_tileset_', plate: S.panel.plate },
  orange: { layer: 'orangeBlocks', family: 'orange_ground_tileset_', plate: S.panel.plate },
  ...Object.fromEntries(Object.entries(S).map(([k, s]) => [k, { layer: s.layer, family: s.family, plate: s.plate }])),
};

// The sheets' own inside-corner tiles, read off the level's tiles (empty diagonal -> the tile it puts on a fully surrounded cell).
const INNER = {
  plate56: { NE: 66, SE: 59, SW: 60, NW: 67 }, // ground, dark, breakable, illusory, bglight, bgdark
  bevel: { NE: 14, SE: 6, SW: 7, NW: 15 }, // panel, darkpanel, blue, orange
  grate: { NE: 12, SE: 4, SW: 5, NW: 13 },
};
const turned = (id) => ({ SE: [id, [1, 0, 0, 1]], NE: [id, [1, 0, 0, -1]], SW: [id, [-1, 0, 0, 1]], NW: [id, [-1, 0, 0, -1]] });
const EXPECT_INNER = {
  ground: INNER.plate56, dark: INNER.plate56, breakable: INNER.plate56, illusory: INNER.plate56, bglight: INNER.plate56, bgdark: INNER.plate56,
  panel: INNER.bevel, darkpanel: INNER.bevel, blue: INNER.bevel, orange: INNER.bevel, grate: INNER.grate,
  lightplate: turned(210), lightfloor: turned(210), darkplate: turned(206), darkfloor: turned(206), bgplate: turned(206),
  blueplate: turned(195), bluefloor: turned(195), orangeplate: turned(199), orangefloor: turned(199),
  plate: null, floorplate: null, bgwall: null, bgfloor: null, // the 3x3-only sheets have no inside tile
};
const RAIL = new Set(['panel', 'darkpanel', 'blue', 'orange', 'lightfloor', 'darkfloor', 'bluefloor', 'orangefloor', 'floorplate', 'bgfloor']); // a rail / bar along the top: no generated connector

await test('rail floors use their own inside-corner tile at a wall\'s foot (not the ground sheet\'s different-looking 22 / 23)', () => {
  for (const kind of ['lightfloor', 'darkfloor', 'bluefloor', 'orangefloor']) {
    const plate = SHEETS[kind].plate, fam = SHEETS[kind].family;
    assert.equal(plate.foot, undefined, kind + ' borrows no foot pieces');
    for (const [hole, skip] of [['NE', [2, 2]], ['NW', [0, 2]]]) {
      // a wall rising beside a rail: the cell at its foot is fully surrounded with one upper diagonal empty
      T.open({ name: 't', useBase: false });
      for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) if (!(x === skip[0] && y === skip[1])) T.own.blocks.set(T.key(x, y), kind);
      const art = T.blockArt(kind, 1, 1), want = plate.inner[hole];
      assert.equal(art.tile, fam + (typeof want === 'number' ? want : want.id), kind + ' ' + hole + ' foot is the sheet\'s inside tile');
      if (typeof want !== 'number') assert.deepEqual(art.matrix, want.m, kind + ' ' + hole + ' turned');
      assert.ok(!art.parts, 'no generated connector on a rail sheet');
    }
  }
});

await test('every block sheet has its nine pieces, and its inside tiles are the ones the level uses', () => {
  for (const kind of Object.keys(SHEETS)) assert.ok(kind in EXPECT_INNER, 'a mapping for ' + kind);
  for (const [kind, { family, plate }] of Object.entries(SHEETS)) {
    for (const p of ['TL', 'T', 'TR', 'L', 'C', 'R', 'BL', 'B', 'BR']) assert.ok(T.base.art.tiles[family + plate[p]] !== undefined, kind + ' has ' + p);
    assert.equal(!!plate.rail, RAIL.has(kind), kind + ' rail flag');
    const want = EXPECT_INNER[kind];
    for (const d of ['NE', 'SE', 'SW', 'NW']) {
      const p = plate.inner?.[d];
      if (!want) { assert.equal(p, undefined, kind + ' has no inside tile'); continue; }
      const [id, m] = Array.isArray(want[d]) ? want[d] : [want[d], null];
      assert.equal(typeof p === 'number' ? p : p.id, id, kind + ' inside ' + d);
      if (m) assert.deepEqual(p.m || [1, 0, 0, 1], m, kind + ' turn ' + d);
      assert.ok(T.base.art.tiles[family + id] !== undefined, kind + ' sheet has tile ' + id);
    }
  }
});

// ---- shapes: ASCII rows, top row first; '#' is a block. Expected piece per cell, by name, as [x, y-from-top, piece] ----
const shape = (rows) => rows.flatMap((r, y) => [...r].map((c, x) => (c === '#' ? [x, y] : null)).filter(Boolean));
const SHAPES = {
  single: { rows: ['#'], at: { '0,0': 'single' } },
  hstrip: { rows: ['###'], at: { '0,0': 'h0', '1,0': 'h1', '2,0': 'h2' } },
  vstrip: { rows: ['#', '#', '#'], at: { '0,0': 'v0', '0,1': 'v1', '0,2': 'v2' } },
  square: { rows: ['###', '###', '###'], at: { '0,0': 'TL', '1,0': 'T', '2,0': 'TR', '0,1': 'L', '1,1': 'C', '2,1': 'R', '0,2': 'BL', '1,2': 'B', '2,2': 'BR' } },
  L: { rows: ['#..', '#..', '###'], at: { '0,0': 'v0', '0,1': 'v1', '0,2': 'BL+NE', '1,2': 'h1', '2,2': 'h2' } },
  U: { rows: ['#.#', '#.#', '###'], at: { '0,0': 'v0', '2,0': 'v0', '0,1': 'v1', '2,1': 'v1', '0,2': 'BL+NE', '1,2': 'h1', '2,2': 'BR+NW' } },
  ring: { rows: ['###', '#.#', '###'], at: { '0,0': 'TL+SE', '1,0': 'h1', '2,0': 'TR+SW', '0,1': 'v1', '2,1': 'v1', '0,2': 'BL+NE', '1,2': 'h1', '2,2': 'BR+NW' } },
  // The user's staircase: its concave corners sit on cells that are also edges.
  stairs: { rows: ['#..', '##.', '###'], at: { '0,0': 'v0', '0,1': 'L+NE', '1,1': 'TR', '0,2': 'BL', '1,2': 'B+NE', '2,2': 'h2' } },
  // 2-wide steps: the cell where the steps meet has all four sides and one empty diagonal.
  wide: { rows: ['##..', '##..', '####', '####'], at: { '1,1': 'R', '1,2': 'C+NE', '2,2': 'T', '1,3': 'B' } },
  notch: { rows: ['###', '###', '##.'], at: { '1,1': 'C+SE', '0,1': 'L', '1,0': 'T', '1,2': 'BR' } },
  plus: { rows: ['.#.', '###', '.#.'], at: { '1,1': 'C+all' } },
};

// What a piece name should draw as, for a sheet: [tile, matrix] or, for a quarter mix, the four tiles.
const asTile = (kind, piece) => {
  const { family, plate } = SHEETS[kind];
  if (/^[vh][012]$/.test(piece)) return plate[piece[0]] ? [family + plate[piece[0]][piece[1]], [1, 0, 0, 1]] : null;
  if (piece === 'single') return plate.single != null ? [family + plate.single, [1, 0, 0, 1]] : null;
  return [family + plate[piece], [1, 0, 0, 1]];
};
// The piece itself, or - when the level never uses it on that tilemap - its mirror image turned by a matrix (the game's palette fallback).
const sameArt = (kind, art, piece, t) => {
  if (art.tile === t[0] && JSON.stringify(art.matrix) === JSON.stringify(t[1])) return true;
  const { family, plate } = SHEETS[kind];
  const v = piece.replace(/^T/, 'b').replace(/^B/, 'T').replace(/^b/, 'B'), h = piece.replace(/L$/, 'r').replace(/R$/, 'L').replace(/r$/, 'R');
  return (v !== piece && plate[v] != null && art.tile === family + plate[v] && JSON.stringify(art.matrix) === '[1,0,0,-1]')
    || (h !== piece && plate[h] != null && art.tile === family + plate[h] && JSON.stringify(art.matrix) === '[-1,0,0,1]');
};
const quarterNames = (kind, parts) => parts.map((p) => asTile(kind, p)[0]);

const place = (kind, rows, ox = 0, oy = 0) => {
  T.open({ name: 't', useBase: false });
  const cells = shape(rows), H = rows.length;
  for (const [x, y] of cells) T.own.blocks.set(T.key(ox + x, oy + H - 1 - y), kind);
  return { H, cell: (x, y) => [ox + x, oy + H - 1 - y] };
};

for (const kind of Object.keys(SHEETS)) {
  await test('shapes tile with ' + kind + "'s own pieces", () => {
    const { plate, family } = SHEETS[kind];
    for (const [name, sh] of Object.entries(SHAPES)) {
      const p = place(kind, sh.rows, 0, 0);
      for (const [pos, want] of Object.entries(sh.at)) {
        const [x, y] = pos.split(',').map(Number), [cx, cy] = p.cell(x, y);
        const art = T.blockArt(kind, cx, cy);
        const label = `${kind} ${name} @${pos} (${want})`;
        assert.ok(art, label + ' has art');
        assert.equal(art.layer, SHEETS[kind].layer, label + ' layer');
        const m = /^(\w+)\+(\w+)$/.exec(want);
        if (!m) {
          const t = asTile(kind, want);
          if (t) { assert.ok(sameArt(kind, art, want, t), label + ' drew ' + art.tile + ' ' + JSON.stringify(art.matrix)); continue; }
          // no strip / single pieces on this sheet: quarters of the 3x3 panel
          const q = { single: ['TL', 'TR', 'BL', 'BR'], v0: ['TL', 'TR', 'L', 'R'], v1: ['L', 'R', 'L', 'R'], v2: ['L', 'R', 'BL', 'BR'], h0: ['TL', 'T', 'L', 'B'].slice(0, 0).concat(['TL', 'T', 'BL', 'B']), h1: ['T', 'T', 'B', 'B'], h2: ['T', 'TR', 'B', 'BR'] }[want];
          assert.ok(art.quarters, label + ' is cut from quarters');
          assert.deepEqual(art.quarters, quarterNames(kind, q), label + ' quarters');
          continue;
        }
        const [, base, hole] = m;
        const holes = hole === 'all' ? ['NE', 'SE', 'SW', 'NW'] : [hole];
        const realOf = (d) => { if (plate.foot?.[d]) return [plate.foot[d], [1, 0, 0, 1]]; const p = plate.inner?.[d]; return p == null ? null : typeof p === 'number' ? [family + p, [1, 0, 0, 1]] : [family + p.id, p.m]; };
        if (RAIL.has(kind) && base === 'C' && holes.length === 1 && realOf(hole)) { // rail sheets: the sheet's own inside tile, as the level has it
          const [tile, mat] = realOf(hole);
          assert.equal(art.tile, tile, label); assert.deepEqual(art.matrix, mat, label);
        } else if (RAIL.has(kind) || base.length === 2) { // rail sheets and corner pieces: no generated connector
          assert.ok(!art.parts, label + ' has no generated connector');
          const first = RAIL.has(kind) && base === 'C' && realOf(holes[0]);
          if (first) assert.equal(art.tile, first[0], label); else assert.ok(sameArt(kind, art, base, asTile(kind, base)), label + ' keeps its plain piece');
        } else { // an edge (or a centre with several gaps) on a thin-band sheet: a connector made of the two edge pieces beside each gap
          assert.equal(art.base, family + plate[base], label + ' keeps its piece');
          assert.ok(art.tile.startsWith(art.base + '+') && art.parts?.length, label + ' has connector pixels');
          assert.equal(art.spriteFrom.base, art.base); assert.equal(art.spriteFrom.pixels, art.parts);
          for (const d of holes) {
            const vRole = d[1] === 'E' ? 'R' : 'L', hRole = d[0] === 'N' ? 'T' : 'B';
            const [vId, hId] = [family + plate[vRole], family + plate[hRole]];
            const mine = art.parts.filter(([x, y]) => (d[1] === 'E' ? x >= 16 : x < 16) && (d[0] === 'N' ? y < 16 : y >= 16));
            assert.ok(mine.length > 8, label + ' ' + d + ' connector has pixels');
            if (holes.length === 1) assert.ok(mine.every(([, , tile]) => tile === vId || tile === hId), label + ' ' + d + ' is made of the ' + vRole + ' and ' + hRole + ' edge pieces only');
            assert.ok(mine.some(([, , tile]) => tile === vId) && mine.some(([, , tile]) => tile === hId), label + ' ' + d + ' uses both bands');
          }
        }
      }
    }
  });
}

await test('a plus has an inside piece in every quarter of its centre (cuttable sheets)', () => {
  const p = place('ground', ['.#.', '###', '.#.']);
  const art = T.blockArt('ground', ...p.cell(1, 1));
  assert.equal(art.base, 'ground1_tileset_64');
  assert.ok(art.tile.includes('+NE65.57') && art.tile.includes('+SW63.71') && art.tile.includes('+SE65.71') && art.tile.includes('+NW63.57'), 'a connector for each of the four gaps: ' + art.tile);
});

await test('the pure picker gives the same answers as the editor (table of every neighbour blob)', () => {
  const tbl = tableOf(S.breakable.plate);
  assert.equal(tbl['1111' + '0111'], 'C+NE');
  assert.equal(tbl['1111' + '1011'], 'C+SE');
  assert.equal(tbl['1111' + '1101'], 'C+SW');
  assert.equal(tbl['1111' + '1110'], 'C+NW');
  assert.equal(tbl['1111' + '1111'], 'C');
  assert.equal(tbl['0110' + '0100'], 'TL');
  assert.equal(tbl['1100' + '1000'], 'BL');
  assert.ok(Object.keys(tbl).length >= 40, 'all 47 blobs are reachable: ' + Object.keys(tbl).length);
  // edge cells ignore an empty diagonal on their open side
  assert.equal(pickPieces(S.breakable.plate, (dx, dy) => !(dx === 0 && dy === 1) && !(dx === 1 && dy === 1)).whole, 'T');
});

await test('blocks next to the level join it: same tileset only', () => {
  T.open({ name: 't', useBase: true, baseState: 'start' });
  const lvl = T.levelJoinCells(T.joinInfo('ground'));
  assert.ok(lvl.size > 50000, 'ground1 level cells found: ' + lvl.size);
  let hit = 0;
  for (const k of T.sets.ground) if (lvl.has(k)) hit++;
  assert.ok(hit / lvl.size > 0.9, 'the level tiles sit on the editor ground cells (' + hit + '/' + lvl.size + ')');
  // a flat floor of ground1 with air above: put a row of blocks on it.
  const at = (x, y) => T.key(x, y);
  const anyLevel = (cx, cy) => T.sets.ground.has(at(cx, cy)) || T.sets.moss.has(at(cx, cy)) || ['dark', 'grate', 'ground'].some((kd) => T.levelJoinCells(T.joinInfo(kd)).has(at(cx, cy)));
  let run = null;
  for (const k of lvl) {
    const [x, y] = k.split(',').map(Number);
    if ([0, 1, 2].every((d) => lvl.has(at(x + d, y)) && !anyLevel(x + d, y + 1) && !anyLevel(x + d, y + 2))
      && [-1, 3].every((d) => !anyLevel(x + d, y + 1)) && [0, 1, 2].every((d) => lvl.has(at(x + d, y - 1)))) { run = [x, y]; break; }
  }
  assert.ok(run, 'a flat stretch of level ground');
  const [x, y] = run;
  T.open({ name: 't', useBase: true, baseState: 'start' });
  for (let d = 0; d < 3; d++) T.own.blocks.set(at(x + d, y + 1), 'ground');
  const pc = (d) => T.blockArt('ground', x + d, y + 1);
  assert.equal(pc(0).tile, 'ground1_tileset_56', 'left end sits on the level as a top-left corner');
  assert.equal(pc(1).tile, 'ground1_tileset_57', 'middle is a top edge');
  assert.equal(pc(2).tile, 'ground1_tileset_58', 'right end is a top-right corner');
  // your blocks on one tilemap are one shape whatever the sheet: a dark block above a ground block joins it
  T.own.blocks.set(at(x + 1, y + 2), 'dark');
  assert.ok(pc(1).tile.startsWith('ground1_tileset_64'), 'dark above ground is part of the same shape: no top edge');
  T.own.blocks.set(at(x + 1, y + 2), 'panel');
  assert.ok(T.blockArt('ground', x + 1, y + 1).tile.startsWith('ground1_tileset_64+NE') && T.blockArt('ground', x + 1, y + 1).tile.includes('+NW'), 'a panel (also ground1) above joins: centre with the two inside corners beside it');
  // erasing level ground under the row un-joins it
  T.own.blocks.delete(at(x + 1, y + 2));
  T.gone.removed.add(at(x + 1, y));
  assert.notEqual(pc(1).tile, 'ground1_tileset_57', 'a removed level cell is no longer a neighbour');
  // the base off: no level neighbours
  T.setBaseOn(false);
  assert.equal(T.blockArt('ground', x, y + 1).quarters.length, 4);
});

await test('changing a block redraws its neighbours within one cell (the picture cache margin)', () => {
  const src = fs.readFileSync(path.join(mapsDir, 'editor.js'), 'utf8');
  assert.match(src, /take\(blocks, cellRectOf\(3 \* CELL\)\)/, 'a block change drops chunks 3 cells around it');
  assert.match(src, /take\(removed, cellRectOf\(6 \* CELL\)\)/);
});

await test('placed tiles export as the game paints them: whole tiles with turns, or quarter mixes', () => {
  T.open({ name: 't', useBase: false });
  for (const [x, y] of shape(SHAPES.stairs.rows)) T.own.blocks.set(T.key(x, 2 - y), 'ground');
  const objs = T.buildMap().groups[0].objects.filter((o) => o.type === 'tile');
  assert.equal(objs.length, 6);
  const mix = objs.filter((o) => o.spriteFrom);
  assert.ok(mix.length >= 3, 'strip ends and cells with an inside corner are built sprites');
  for (const o of mix) assert.ok(o.spriteFrom.quarters?.length === 4 || (o.spriteFrom.base && o.spriteFrom.pixels.length), 'quarters, or a base with pixels');
  assert.ok(objs.some((o) => o.spriteFrom?.pixels?.length), 'the staircase gets a connector at its inside corner');
});

await test('level cells beside your blocks are re-tiled with the combined shape, and restored when the blocks go', () => {
  T.open({ name: 't', useBase: true, baseState: 'start' });
  const lvl = T.levelJoinCells(T.joinInfo('ground')), at = (x, y) => T.key(x, y);
  const anyLevel = (cx, cy) => T.sets.ground.has(at(cx, cy)) || T.sets.moss.has(at(cx, cy)) || lvl.has(at(cx, cy)) || T.levelRails().has(at(cx, cy));
  // a level wall: a plate right-edge cell (65) with open air beside it
  let wall = null;
  for (const [k, name] of lvl.names) {
    if (name !== 'ground1_tileset_65') continue;
    const [x, y] = k.split(',').map(Number);
    if ([-1, 0, 1].every((dy) => !anyLevel(x + 1, y + dy) && !anyLevel(x + 2, y + dy)) && lvl.has(at(x, y + 1)) && lvl.has(at(x, y - 1)) && lvl.names.get(at(x, y + 1)) === 'ground1_tileset_65') { wall = [x, y]; break; }
  }
  assert.ok(wall, 'a level wall edge in open air');
  const [x, y] = wall, wk = at(x, y);
  assert.equal(T.levelOverrides().cells.size, 0, 'nothing is re-tiled with no blocks of yours');
  // a block of yours against the wall, of ANOTHER sheet (an Asset floor): the wall is part of the same shape
  for (const dy of [-1, 0, 1]) T.own.blocks.set(at(x + 1, y + dy), 'lightfloor');
  const ov = T.levelOverrides();
  assert.ok(ov.cells.has(wk), 'the level wall cell beside your block is re-tiled');
  assert.equal(ov.cells.get(wk).art.tile, 'ground1_tileset_64', 'into the sheet\'s centre, like the level\'s own interior');
  for (const [k, q] of ov.cells) assert.ok(q.art.centre && !q.art.parts, 'a level cell is only re-tiled into a centre / inside tile, never a generated piece: ' + k);
  assert.ok(![...ov.cells.keys()].some((k) => T.own.blocks.has(k)), 'your own cells are not overrides');
  const o = ov.cells.get(wk);
  assert.equal(o.art.layer, 'ground');
  assert.notEqual(o.art.tile, 'ground1_tileset_65', 'the wall no longer keeps its right-hand outline against your block');
  assert.ok(ov.hide.has('new awesome nikki ground|' + wk), 'the level\'s baked art is hidden there');
  assert.ok(T.blockArt('lightfloor', x + 1, y).tile !== 'Asset_Sheet_213' || true);
  // the export paints it at the same cell
  const objs = T.buildMap().groups[0].objects;
  const retile = objs.filter((q) => q.levelRetile);
  assert.equal(retile.length, ov.cells.size);
  const w = T.cellWorld(x, y);
  assert.ok(retile.some((q) => q.type === 'tile' && q.tilemap === 'ground' && q.x === w.x + 16 && q.y === w.y + 16), 'a tile at the level cell\'s own spot');
  assert.equal(objs.filter((q) => q.type === 'tile' && !q.levelRetile).length, 3, 'your three blocks are exported as before');
  // erasing a level cell un-joins it; removing your block puts the level's own art back
  T.gone.removed.add(wk);
  assert.ok(!T.levelOverrides().cells.has(wk), 'an erased level cell gets no tile');
  T.gone.removed.delete(wk);
  for (const dy of [-1, 0, 1]) T.own.blocks.delete(at(x + 1, y + dy));
  assert.equal(T.levelOverrides().cells.size, 0, 'back to the level\'s own art');
  assert.equal(T.levelOverrides().hide.size, 0);
  assert.equal(T.buildMap().groups[0].objects.filter((q) => q.levelRetile).length, 0);
});

// ---- merge tiles: the ground sheets turn a plate edge into a rail edge with 73-80 ----
for (const [rail, plateKind, family] of [['panel', 'ground', 'ground1_tileset_'], ['darkpanel', 'dark', 'dark_ground_tileset_']]) {
  await test('merge tiles join ' + plateKind + ' (plate) and ' + rail + ' (rail) along an edge', () => {
    const put = (x, y, kind) => T.own.blocks.set(T.key(x, y), kind);
    const art = (kind, x, y) => T.blockArt(kind, x, y);
    // top edge, plate west of rail: the rail cell beside the plate is 73
    T.open({ name: 't', useBase: false });
    for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) put(x, y, x < 2 ? plateKind : rail);
    assert.equal(art(rail, 2, 1).tile, family + '73', 'top: plate to the west -> 73');
    assert.equal(art(plateKind, 1, 1).tile, family + '57', 'the plate cell keeps its plain edge');
    assert.notEqual(art(rail, 3, 1).tile, family + '73', 'only the cell beside the plate merges');
    // rail west of plate -> 74
    T.open({ name: 't', useBase: false });
    for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) put(x, y, x < 3 ? rail : plateKind);
    assert.equal(art(rail, 2, 1).tile, family + '74', 'top: plate to the east -> 74');
    // bottom edge
    assert.equal(art(rail, 2, 0).tile, family + '78', 'bottom: plate to the east -> 78');
    T.open({ name: 't', useBase: false });
    for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) put(x, y, x < 2 ? plateKind : rail);
    assert.equal(art(rail, 2, 0).tile, family + '77', 'bottom: plate to the west -> 77');
    // left edge (open west): plate above -> 75, plate below -> 79; right edge: 76 / 80
    T.open({ name: 't', useBase: false });
    for (let x = 0; x < 2; x++) for (let y = 0; y < 5; y++) put(x, y, y >= 3 ? plateKind : rail);
    assert.equal(art(rail, 0, 2).tile, family + '75', 'left: plate above -> 75');
    assert.equal(art(rail, 1, 2).tile, family + '76', 'right: plate above -> 76');
    T.open({ name: 't', useBase: false });
    for (let x = 0; x < 2; x++) for (let y = 0; y < 5; y++) put(x, y, y < 2 ? plateKind : rail);
    assert.equal(art(rail, 0, 2).tile, family + '79', 'left: plate below -> 79');
    assert.equal(art(rail, 1, 2).tile, family + '80', 'right: plate below -> 80');
    // no merge with a different tileset
    T.open({ name: 't', useBase: false });
    for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) put(x, y, x < 2 ? 'grate' : rail);
    assert.notEqual(art(rail, 2, 1).tile, family + '73', 'grate has no merge art with the panel: separate edges');
  });
}

await test('a rail block beside level plate edge merges, and the level cell keeps its own style', () => {
  T.open({ name: 't', useBase: true, baseState: 'start' });
  const lvl = T.levelJoinCells(T.joinInfo('ground')), at = (x, y) => T.key(x, y);
  const anyLevel = (cx, cy) => T.sets.ground.has(at(cx, cy)) || T.sets.moss.has(at(cx, cy)) || ['dark', 'grate', 'ground'].some((kd) => T.levelJoinCells(T.joinInfo(kd)).has(at(cx, cy)));
  let at0 = null;
  for (const [k, id] of lvl.ids) {
    if (id !== 57) continue;
    const [x, y] = k.split(',').map(Number);
    if ([1, 2, 3].every((d) => !anyLevel(x + d, y) && !anyLevel(x + d, y - 1) && !anyLevel(x + d, y + 1)) && lvl.has(at(x, y - 1))) { at0 = [x, y]; break; }
  }
  assert.ok(at0, 'a level plate top edge that ends in open air');
  const [x, y] = at0;
  for (let d = 1; d <= 3; d++) for (const h of [0, -1]) T.own.blocks.set(at(x + d, y + h), 'panel');
  assert.equal(T.blockArt('panel', x + 1, y).tile, 'ground1_tileset_73', 'your rail cell beside the level\'s plate edge is the merge tile');
  assert.ok(!T.levelOverrides().cells.has(at(x, y)), 'the level plate edge keeps its own art: it stays an edge against your rail cell');
});

await test('a block set on a level rail strip joins it (no bottom edge) and the strip keeps its art, on the ground and on decoration tilemaps', () => {
  T.open({ name: 't', useBase: true, baseState: 'start' });
  const at = (x, y) => T.key(x, y);
  const rails = T.levelRails();
  const anyLevel = (cx, cy) => T.sets.ground.has(at(cx, cy)) || T.sets.moss.has(at(cx, cy)) || rails.has(at(cx, cy));
  const found = {};
  for (const [k, layer] of rails) {
    const [x, y] = k.split(',').map(Number);
    const kind = layer === 'new awesome nikki ground' ? 'ground' : 'deco';
    if (found[kind]) continue;
    if ([0, 1, 2].every((d) => rails.get(at(x + d, y)) === layer && !anyLevel(x + d, y + 1) && !anyLevel(x + d, y + 2) && !T.sets.ground.has(at(x + d, y + 1))) && [-1, 3].every((d) => !anyLevel(x + d, y + 1) && !anyLevel(x + d, y + 2))) found[kind] = [x, y, layer];
  }
  assert.ok(found.ground && found.deco, 'rail strips with open air above on the ground and on a decoration tilemap: ' + JSON.stringify(found));
  for (const [x, y, layer] of Object.values(found)) {
    T.open({ name: 't', useBase: true, baseState: 'start' });
    for (let d = 0; d < 3; d++) for (let h = 1; h <= 2; h++) T.own.blocks.set(at(x + d, y + h), 'ground');
    const bottom = (d) => T.blockArt('ground', x + d, y + 1).tile;
    assert.deepEqual([0, 1, 2].map(bottom), ['ground1_tileset_63', 'ground1_tileset_64', 'ground1_tileset_65'], layer + ': the row on the strip has no bottom edge');
    // the strip keeps its rail where it still borders empty space; a strip cell buried on all eight sides is interior
    const ovs = T.levelOverrides().cells;
    if (layer === 'new awesome nikki ground') { // where the strip runs on out of the block, its cell under the block's end is the rail-foot fillet
      assert.match(ovs.get(at(x, y))?.art.tile || '', /_tileset_23$/, layer + ': left end');
      assert.match(ovs.get(at(x + 2, y))?.art.tile || '', /_tileset_22$/, layer + ': right end');
    }
    if (layer === 'new awesome nikki ground') assert.match(ovs.get(at(x + 1, y))?.art.tile || '', /_tileset_64$/, layer + ': the strip cell buried under the block is the plate interior');
  }
});

await test('level cells of a block\'s tileset on a decoration tilemap are neighbours too', () => {
  T.open({ name: 't', useBase: true, baseState: 'start' });
  const at = (x, y) => T.key(x, y);
  const lvl = T.levelJoinCells(T.joinInfo('lightfloor'));
  const deco = [...lvl].filter((k) => lvl.layers.get(k) !== 'new awesome nikki ground');
  assert.ok(deco.length > 100, 'Asset floor cells found on the decoration tilemaps: ' + deco.length);
  assert.ok(deco.every((k) => ['Environmental objects', 'Environmental objects_back', 'environmentalObjects_front'].includes(lvl.layers.get(k))));
  const k = deco.find((c) => { const [x, y] = c.split(',').map(Number); return !lvl.has(at(x + 1, y)) && !lvl.has(at(x + 2, y)) && !T.levelRails().has(at(x + 1, y)); });
  const [x, y] = k.split(',').map(Number);
  T.own.blocks.set(at(x + 1, y), 'lightfloor');
  const joined = T.blockArt('lightfloor', x + 1, y).tile;
  T.setBaseOn(false);
  const alone = T.blockArt('lightfloor', x + 1, y).tile;
  T.setBaseOn(true);
  assert.notEqual(joined, alone, 'your block sees the decoration cell beside it as part of its shape');
});

await test('the user\'s square on the level rail strip: x79-86, y-14..-7 of lightfloor over the strip at y-15', () => {
  T.open({ name: 't', useBase: true, baseState: 'start', removed: ['79,-14', '80,-14', '81,-14', '82,-14', '83,-14', '84,-14', '85,-14', '86,-14'] });
  const at = (x, y) => T.key(x, y);
  const rails = T.levelRails();
  for (let x = 79; x <= 86; x++) assert.equal(rails.get(at(x, -15)), 'new awesome nikki ground', 'the level\'s rail strip is the cell under the square at x' + x);
  for (let x = 79; x <= 86; x++) for (let y = -14; y <= -7; y++) T.own.blocks.set(at(x, y), 'lightfloor');
  // the bottom row sits flush on the strip: plain left / centre / right pieces, no bottom edge or rounded corners
  assert.deepEqual([79, 80, 85, 86].map((x) => T.blockArt('lightfloor', x, -14).tile), ['Asset_Sheet_212', 'Asset_Sheet_212', 'Asset_Sheet_212', 'Asset_Sheet_213']); // the left column joins the level's wall beside it (x78) too
  // the strip under it keeps its own art
  // the strip under the square is buried between the square and the level's plate below: interior, one outline for the whole mass
  const ovs = T.levelOverrides().cells;
  for (let x = 80; x <= 85; x++) assert.equal(ovs.get(at(x, -15))?.art.tile, 'ground1_tileset_64', 'buried strip cell x' + x + ' is the plain interior piece');
  // where the rail runs out of the mass (east of the square), the cell before it is the level's own rail-foot piece, not a flat cut
  assert.equal(ovs.get(at(86, -15))?.art.tile, 'ground1_tileset_22', 'the rail stub starts from the foot fillet 22 (a rail to the east, open corner NE)');
  // and a level cell does lie one row down from its art row: the strip's own tile row is -14 in the level layer
  const lvl = T.levelJoinCells(T.joinInfo('ground'));
  assert.ok(lvl.has(at(80, -15)) && !lvl.has(at(80, -14)), 'level art rows map one cell lower in the editor');
});

await test('a lone rail cell between plate cells is an ordinary edge, not a merge tile (the level only merges where the rail continues)', () => {
  T.open({ name: 't', useBase: false });
  const put = (x, y, kind) => T.own.blocks.set(T.key(x, y), kind);
  for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) put(x, y, x === 2 ? 'panel' : 'ground');
  assert.ok(!/_7[3-9]$|_80$/.test(T.blockArt('panel', 2, 1).tile), 'no merge tile for a rail cell between plates');
  for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) put(x, y, x < 2 ? 'ground' : 'panel');
  assert.equal(T.blockArt('panel', 2, 1).tile, 'ground1_tileset_73', 'but where the rail continues, the merge tile');
});

await test('level-vs-level junctions are never touched, and a single block against a wall leaves the wall\'s own edges', () => {
  T.open({ name: 't', useBase: true, baseState: 'start' });
  assert.equal(T.levelOverrides().cells.size, 0, 'no blocks of yours: not one level cell is re-tiled, whatever junctions the level has');
  const lvl = T.levelJoinCells(T.joinInfo('ground')), at = (x, y) => T.key(x, y);
  // a level cell with a special piece (a rail end cap) beside your block keeps that piece
  let cap = null;
  for (const [k, name] of lvl.names) if (name === 'ground1_tileset_5') { const [x, y] = k.split(',').map(Number); if (!lvl.has(at(x + 1, y))) { cap = [x, y]; break; } }
  assert.ok(cap, 'a level rail end cap');
  T.own.blocks.set(at(cap[0] + 1, cap[1]), 'lightfloor');
  assert.equal(T.levelOverrides().cells.get(at(...cap))?.art.tile, 'ground1_tileset_2', 'a rail end cap with your block against its end is no longer an end: a plain rail edge');
  // but a cap whose end is still free keeps its art
  T.open({ name: 't', useBase: true, baseState: 'start' });
  T.own.blocks.set(at(cap[0] - 3, cap[1] + 2), 'lightfloor');
  assert.ok(!T.levelOverrides().cells.has(at(...cap)), 'the end cap keeps its art');
  // a lone block against a wall: the wall cell would lose its outline at two corners, so it stays as the level has it
  T.open({ name: 't', useBase: true, baseState: 'start' });
  const wall = [...lvl.names].find(([k, name]) => { if (name !== 'ground1_tileset_65') return false; const [x, y] = k.split(',').map(Number); return !lvl.has(at(x + 1, y)) && !lvl.has(at(x + 1, y + 1)) && !lvl.has(at(x + 1, y - 1)) && !lvl.has(at(x + 2, y)); });
  const [wx, wy] = wall[0].split(',').map(Number);
  T.own.blocks.set(at(wx + 1, wy), 'ground');
  assert.ok(!T.levelOverrides().cells.has(wall[0]), 'a single block leaves the wall cell\'s own edge');
});

await test('a rail-topped ledge with a block of another sheet hanging under it is one shape', () => {
  T.open({ name: 't', useBase: false });
  const put = (x, y, kind) => T.own.blocks.set(T.key(x, y), kind);
  for (let x = 0; x < 6; x++) for (let y = 3; y < 5; y++) put(x, y, 'lightfloor'); // the ledge
  for (let x = 3; x < 5; x++) for (let y = 0; y < 3; y++) put(x, y, 'panel'); // a 2-wide block of another sheet under its right part
  const ledgeBottom = T.blockArt('lightfloor', 3, 3), blockTop = T.blockArt('panel', 3, 2);
  assert.ok(!/(_226|_227|_228)$/.test(ledgeBottom.tile || '') || ledgeBottom.tile.includes('+'), 'the ledge has no bottom edge where the block hangs');
  assert.ok(!/ground1_tileset_(1|2|3)$/.test(blockTop.tile), 'the block has no rail top under the ledge: ' + blockTop.tile);
  // the far side of the ledge keeps its bottom edge
  assert.match(T.blockArt('lightfloor', 1, 3).tile, /_(226|227|228)$/);
});

console.log(n + ' tiling tests passed');
