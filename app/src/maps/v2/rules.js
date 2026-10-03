// Tiles that fit the level: every tileset autotiles the way the level itself does.
// Learned from the level's own tiles, per tilemap layer:
//   - which tiles stand at each neighbourhood (8 neighbours on the layer, and for
//     other layers the 4 sides of the ground layer - spikes sit on ground),
//   - which tile the level puts beside which, side by side.
// A cell is given the tile of its tileset that best fits both: so new tiles
// join the level's (and continue the style they touch) without seams.
const GROUND = 'new awesome nikki ground';
const D8 = [[-1, 1], [0, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [0, -1], [1, -1]];
const D4 = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const matKey = (m) => m.map((v) => Math.round(v * 1e4) / 1e4).join(',');
const asset = (n) => n.replace(/@-?\d+$/, '');
export const familyOf = (name) => asset(name).replace(/\d+$/, '');
const pk = (x, y) => x * 1048576 + y;
// A layer with collision off ("<layer>#ghost") tiles as its layer does.
const baseOf = (layer) => layer.split('#')[0];

export class TileRules {
  constructor(base) {
    this.base = base;
    this.models = new Map();
  }

  // ---- learning ----
  model(layer) {
    layer = baseOf(layer);
    let m = this.models.get(layer);
    if (m) return m;
    m = { table: new Map(), adj: new Map(), cnt: new Map(), fams: new Map(), tiles: new Map() };
    const lt = this.base.art.levelTiles || [];
    const cellsOf = (L) => {
      const cells = new Map(), r = L.runs;
      for (let i = 0; i < r.length; i += 5) {
        const t = L.names[r[i + 3]] + '#' + matKey(this.base.mats[r[i + 4]] || [1, 0, 0, 1]);
        for (let n = 0; n < r[i + 2]; n++) cells.set(pk(r[i + 1] + n, r[i]), t);
      }
      return cells;
    };
    for (const L of lt) {
      if (L.name !== layer) continue;
      const cells = cellsOf(L);
      const G = layer === GROUND ? null : lt.filter((g) => g.name === GROUND && (g.state === 'always' || g.state === L.state)).map(cellsOf);
      const ground = (x, y) => G && G.some((g) => g.has(pk(x, y)));
      for (const [k, t] of cells) {
        const x = Math.round(k / 1048576), y = k - x * 1048576;
        const key = this.keyAt((dx, dy) => cells.has(pk(x + dx, y + dy)), ground, x, y);
        let row = m.table.get(key);
        if (!row) m.table.set(key, (row = new Map()));
        row.set(t, (row.get(t) || 0) + 1);
        m.cnt.set(t, (m.cnt.get(t) || 0) + 1);
        let a = m.adj.get(t);
        if (!a) m.adj.set(t, (a = new Map()));
        D4.forEach(([dx, dy], d) => { const nb = d + '|' + (cells.get(pk(x + dx, y + dy)) || '-'); a.set(nb, (a.get(nb) || 0) + 1); });
        const f = familyOf(t.split('#')[0]);
        if (!m.fams.has(f)) m.fams.set(f, new Set());
        m.fams.get(f).add(key);
        m.tiles.set(t, f);
      }
    }
    this.addPieces(layer, m);
    this.models.set(layer, m);
    return m;
  }
  // The layer the level uses a tileset on most: its rules go with it to any other layer.
  home(family) {
    if (!this.homes) {
      const n = new Map();
      for (const L of this.base.art.levelTiles || []) {
        const fam = L.names.map((t) => familyOf(t));
        for (let i = 0; i < L.runs.length; i += 5) { const k = fam[L.runs[i + 3]] + '|' + L.name; n.set(k, (n.get(k) || 0) + L.runs[i + 2]); }
      }
      this.homes = new Map();
      const best = new Map();
      for (const [k, c] of n) { const [f, l] = k.split('|'); if (c > (best.get(f) || 0)) { best.set(f, c); this.homes.set(f, l); } }
    }
    return this.homes.get(family) || null;
  }
  // [model, its layer] that knows `family`: the layer's own, else the tileset's home layer's.
  modelFor(layer, family) {
    const own = baseOf(layer), m = this.model(own);
    if (m.fams.has(family)) return [m, own];
    const h = this.home(family);
    return h ? [this.model(h), h] : [m, own];
  }

  // The tileset's own shapes (its 3x3 slices, rows, columns, single blocks) as light
  // examples for neighbourhoods the level never shows: a lone row of ground, a column...
  addPieces(layer, m) {
    for (const f of [...m.fams.keys()]) {
      for (const p of this.base.art.pieces?.[f.replace(/_$/, '')] || []) {
        if (!(p.w * p.h === p.n && ((p.w === 3 && p.h === 3) || (p.w === 1 && p.h === 1) || (p.h === 1 && p.w === 3) || (p.w === 1 && p.h === 3)))) continue;
        const at = new Map();
        for (let i = 0; i < p.cells.length; i += 4) at.set(p.cells[i] + ',' + p.cells[i + 1], p.cells[i + 2]);
        for (const [k, name] of at) {
          const [x, y] = k.split(',').map(Number), t = name + '#1,0,0,1';
          // Inside a big shape a slice's edge pieces repeat: their neighbourhood as in a 5x5 of it.
          const key = this.keyAt((dx, dy) => {
            const nx = x + dx, ny = y + dy;
            if (p.w === 3 && p.h === 3) return nx >= 0 && nx < 3 && ny >= 0 && ny < 3;
            return at.has(nx + ',' + ny);
          }, null, x, y);
          let row = m.table.get(key);
          if (!row) m.table.set(key, (row = new Map()));
          if (!row.has(t)) row.set(t, 0.3);
          if (!m.cnt.has(t)) m.cnt.set(t, 0);
          m.tiles.set(t, f);
          m.fams.get(f).add(key);
        }
      }
    }
  }
  // A tileset's looks: each 3x3 slice it has (with its rows, columns and single block),
  // the one the level uses most first. [{ name, tiles: Set of tile names }]
  styles(layer, family) {
    const [m] = this.modelFor(layer, family), pieces = this.base.art.pieces?.[family.replace(/_$/, '')] || [];
    const shared = pieces.filter((p) => p.w * p.h === p.n && (p.w === 1 || p.h === 1)).flatMap((p) => names(p));
    const out = pieces.filter((p) => p.w === 3 && p.h === 3 && p.n === 9).map((p) => ({ name: p.name || 'Plate', tiles: new Set([...names(p), ...shared]) }));
    const used = (st) => [...st.tiles].reduce((n, t) => n + [...m.cnt].filter(([k]) => k.startsWith(t + '#')).reduce((a, [, c]) => a + c, 0), 0);
    return out.map((st) => ({ ...st, used: used(st) })).sort((a, b) => b.used - a.used);
  }
  keyAt(solid, ground, x, y) {
    let s = 0, g = 0;
    D8.forEach(([dx, dy], i) => { if (solid(dx, dy)) s |= 1 << i; });
    if (ground) D4.forEach(([dx, dy], i) => { if (ground(x + dx, y + dy)) g |= 1 << i; });
    return s * 16 + g;
  }

  // The tilesets the level uses on a layer, most used first: [family, tiles].
  families(layer) {
    const m = this.model(layer), n = new Map();
    for (const [t, f] of m.tiles) n.set(f, (n.get(f) || 0) + m.cnt.get(t));
    return [...n].sort((a, b) => b[1] - a[1]);
  }

  // Whether a tileset's tiles are in the tile atlas (thorn vines are drawn from their own images).
  drawable(layer, family) {
    const [m] = this.modelFor(layer, family);
    for (const [t, f] of m.tiles) if (f === family && this.base.art.tiles[asset(t.split('#')[0])] !== undefined) return true;
    return false;
  }

  // ---- picking ----
  // The best tile of `family` for a cell, given what's around it in `store` now.
  pick(store, layer, x, y, family, prefer = null, unknown = null) {
    const [m, ml] = this.modelFor(layer, family);
    const read = (lx, ly) => { const v = store.cell(layer, lx, ly); return v ? store.tileName(v) + '#' + matKey(store.matrix(v)) : null; };
    // Learned beside the ground (not on it): the ground around it, where there is a ground of its own.
    const ground = ml === GROUND ? null : baseOf(layer) === GROUND ? () => false : (gx, gy) => !!store.cell(GROUND, gx, gy);
    const key = this.keyAt((dx, dy) => !!store.cell(layer, x + dx, y + dy), ground, x, y);
    let row = m.table.get(key);
    let cands = row ? [...row].filter(([t]) => m.tiles.get(t) === family) : [];
    if (!cands.length) {
      // No tile of the set was ever seen just so: the nearest neighbourhood it was seen in.
      let best = null, bd = Infinity;
      for (const k of m.fams.get(family) || []) {
        const d = bits((k >> 4) ^ (key >> 4)) + 2 * bits(((k >> 4) ^ (key >> 4)) & 0b01011010) + 0.5 * bits((k & 15) ^ (key & 15));
        if (d < bd) { bd = d; best = k; }
      }
      row = best != null ? m.table.get(best) : null;
      cands = row ? [...row].filter(([t]) => m.tiles.get(t) === family) : [];
    }
    if (!cands.length) return null;
    // Neighbours still to be decided (inside a stroke) don't count yet.
    const nbs = D4.filter(([dx, dy]) => !unknown?.has((x + dx) + ',' + (y + dy))).map(([dx, dy]) => D4.findIndex((q) => q[0] === dx && q[1] === dy) + '|' + (read(x + dx, y + dy) || '-'));
    let best = null, bs = -Infinity;
    for (const [t, n] of cands) {
      const a = m.adj.get(t), c = m.cnt.get(t) + 1;
      let s = Math.log(n + 0.5);
      for (const nb of nbs) s += Math.log(((a?.get(nb) || 0) + 0.1) / c);
      if (prefer && prefer.has(t.split('#')[0])) s += 3;
      if (s > bs) { bs = s; best = t; }
    }
    const hash = best.indexOf('#');
    return { name: best.slice(0, hash), m: best.slice(hash + 1).split(',').map(Number) };
  }

  // Big repeating art (wall panels, the backdrop): one piece tiled over and over.
  // { w, h, at: 'i,j' -> tile, pos: tile -> [i, j], phase } or null for rule tilesets.
  pattern(layer, family) {
    if (!this.patterns) this.patterns = new Map();
    const k = baseOf(layer) + '|' + family;
    if (this.patterns.has(k)) return this.patterns.get(k);
    // A tileset that is one big picture repeated (its only piece, full, bigger than a cell or three).
    const pieces = this.base.art.pieces?.[family.replace(/_$/, '')] || [];
    const piece = pieces.length === 1 && pieces[0].w * pieces[0].h === pieces[0].n && Math.max(pieces[0].w, pieces[0].h) > 3 ? pieces[0] : null;
    let pat = null;
    if (piece) {
      const at = new Map(), pos = new Map();
      for (let i = 0; i < piece.cells.length; i += 4) { at.set(piece.cells[i] + ',' + piece.cells[i + 1], piece.cells[i + 2]); pos.set(piece.cells[i + 2], [piece.cells[i], piece.cells[i + 1]]); }
      const votes = new Map(), on = (this.base.art.levelTiles || []).some((L) => L.name === baseOf(layer) && L.names.some((t) => familyOf(t) === family)) ? baseOf(layer) : this.home(family);
      for (const L of this.base.art.levelTiles || []) {
        if (L.name !== on) continue;
        for (let i = 0; i < L.runs.length; i += 5) {
          const p = pos.get(asset(L.names[L.runs[i + 3]]));
          if (!p) continue;
          const ph = mod(L.runs[i + 1] - p[0], piece.w) + ',' + mod(L.runs[i] - p[1], piece.h);
          votes.set(ph, (votes.get(ph) || 0) + L.runs[i + 2]);
        }
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      pat = { w: piece.w, h: piece.h, at, pos, phase: best ? best[0].split(',').map(Number) : [0, 0] };
    }
    this.patterns.set(k, pat);
    return pat;
  }

  // Paints cells ([x, y] on the layer's grid) with a tileset, then picks again the
  // tiles of the stroke and around it so all of it fits together. erase: take them away.
  paint(store, layer, cells, { family, prefer = null, erase = false }) {
    const pat = !erase && this.pattern(layer, family);
    if (pat) {
      // Carry on the phase of the pattern it touches, else the level's own.
      let phase = null;
      for (const [x, y] of cells) {
        for (const [dx, dy] of D4) {
          const v = store.cell(layer, x + dx, y + dy), p = v && pat.pos.get(asset(store.tileName(v)));
          if (p) { phase = [mod(x + dx - p[0], pat.w), mod(y + dy - p[1], pat.h)]; break; }
        }
        if (phase) break;
      }
      const [px, py] = phase || pat.phase;
      for (const [x, y] of cells) { const t = pat.at.get(mod(x - px, pat.w) + ',' + mod(y - py, pat.h)); if (t) store.setAt(layer, x, y, t, [1, 0, 0, 1]); }
      return;
    }
    const own = new Set(cells.map(([x, y]) => x + ',' + y));
    if (erase) for (const [x, y] of cells) store.put(layer, x, y, 0);
    else {
      // The stroke filled in first (so every cell's neighbourhood is right), then each cell
      // decided from the stroke's edge inward, against the neighbours already decided.
      const [m] = this.modelFor(layer, family), any = [...m.tiles].find(([, f]) => f === family)?.[0];
      const fill = any ? { name: any.split('#')[0], m: any.split('#')[1].split(',').map(Number) } : { name: family + '0', m: [1, 0, 0, 1] };
      for (const [x, y] of cells) store.setAt(layer, x, y, fill.name, fill.m);
      const unknown = new Set(own);
      const known = (x, y) => D4.reduce((n, [dx, dy]) => n + (unknown.has((x + dx) + ',' + (y + dy)) ? 0 : 1), 0);
      while (unknown.size) {
        let best = null, bk = -1;
        for (const k of unknown) { const [x, y] = k.split(',').map(Number), n = known(x, y); if (n > bk) { bk = n; best = [x, y, k]; if (n === 4) break; } }
        const [x, y, k] = best;
        unknown.delete(k);
        const t = this.pick(store, layer, x, y, family, prefer, unknown);
        if (t) store.setAt(layer, x, y, t.name, t.m);
      }
    }
    // The stroke and its edge, each cell keeping its own tileset.
    const area = new Map();
    for (const [x, y] of cells) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const v = store.cell(layer, x + dx, y + dy);
      if (!v) continue;
      const f = familyOf(store.tileName(v));
      if (!this.modelFor(layer, f)[0].fams.has(f) || this.pattern(layer, f)) continue;
      area.set((x + dx) + ',' + (y + dy), [x + dx, y + dy, f, own.has((x + dx) + ',' + (y + dy))]);
    }
    for (let pass = 0; pass < 4; pass++) {
      let moved = 0;
      for (const [x, y, f, mine] of area.values()) {
        const t = this.pick(store, layer, x, y, f, mine ? prefer : null);
        if (!t) continue;
        const v = store.cell(layer, x, y);
        if (v && store.tileName(v) === t.name && matKey(store.matrix(v)) === matKey(t.m)) continue;
        store.setAt(layer, x, y, t.name, t.m);
        moved++;
      }
      if (!moved) break;
    }
  }
}

const mod = (a, n) => ((a % n) + n) % n;
const names = (p) => { const out = []; for (let i = 0; i < p.cells.length; i += 4) out.push(p.cells[i + 2]); return out; };
function bits(v) { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; }
