// A v2 document as the map file the game's Navigator mod reads (the custom-map
// format: tile runs, objects, courses). Draw order travels as orderDelta: the
// same shift of the game's own sorting orders the editor draws with.
import { partsOf } from './render/world.js';
import { courseScreen, RESET_BOX } from './markers.js';
import { spikeTile as spikeTileOf } from './spikes.js';

const OFFSET_Y = 9;
const SIGN_PATH = 'zone 2/Area1/Lighting objects/CoolStatue/StatuePrestigeText';
const SIGN_COLOR = '#7bb652', TRUE_COLOR = '#ff2020';
const SPIKE_LAYER = { spike: 'Spikes', dark: 'Spikes', blue: 'blueSpikes', orange: 'orangeSpikes' };
const DARK_SPIKE_TILES = new Set(['spike_tileset_8', 'spike_tileset_11', 'spike_tileset_13', 'spike_tileset_14']);
const MULTI = new Set(['dash', 'doubleJump', 'clones', 'baseReward', 'cloneMult', 'fastClone', 'bigClone', 'moreWatts', 'greenReward', 'redReward']);
const CURRENCY_ENUM = ['Cash', 'GreenPower', 'AtomicPower', 'regularNumber', 'CloneDust', 'RedPower', 'BluePower'];
const OMNI_LABEL = '-1 Midair jump.\n\nDash in any direction';
const GROUP_KINDS = new Set(['show', 'hide', 'toggle', 'move']);
const MARKER_KINDS = new Set(['teleport', 'respawn']);
const GROUND = 'new awesome nikki ground';
const TILE_SPRITE = /^(.*)@(-?\d+)$/;
const tileAsset = (n) => TILE_SPRITE.exec(n)?.[1] ?? n;
const tilemapName = (layer) => (layer.startsWith(GROUND) ? 'ground' + layer.slice(GROUND.length) : layer);
const rgb = (hex) => hex.match(/\w\w/g).map((h) => Math.round((parseInt(h, 16) / 255) * 1000) / 1000);
const rot2 = (a) => [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];
const mul2 = (p, q) => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const rotMatrix = (k) => { const a = (((k % 4) + 4) % 4) * Math.PI / 2, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a)); return [c, -s, s, c]; };
const AREA_TRACK = { 1: (st) => (st === 'overgrown' ? 'Overgrowth' : 'Area1Track1'), 2: () => 'Area2Track1', 3: () => 'Finale' };

export function backgroundJson(bg) {
  if (!bg?.image) return 'level';
  return { image: bg.image, parallax: bg.parallax ?? 0.8, scale: bg.scale ?? 1 };
}

export function buildMap(ed) {
  const d = ed.doc, base = ed.base, st = d.meta.levelState;
  const origin = { x: 0, y: OFFSET_Y };
  const R = (v) => Math.round(v), rel = (p) => ({ x: R(p.x - origin.x), y: R(p.y - origin.y) });
  const zoneNum = (p) => Number(String(ed.renderer.zoneAt(p.x, p.y) || '').replace(/\D+/g, '')) || 0;
  const complete = d.courses.filter((c) => c.start && c.end);
  const first = complete[0] || d.courses[0];
  const spawn = d.meta.spawn || first?.start || { x: ed.cam.x, y: ed.cam.y };
  const hasGates = !!(first?.start && first?.end);
  const spawnArea = (p) => {
    if (!p) return {};
    const lz = st ? zoneNum(p) : 0, zone = p.zone !== undefined ? p.zone : lz;
    const music = p.music !== undefined ? p.music : zone && st ? 'game:' + AREA_TRACK[zone](st) : '';
    const bg = p.background !== undefined ? p.background : zone ? 'level' : '';
    return { ...(zone ? { zone } : {}), ...(music ? { music } : {}), ...(bg ? { background: backgroundJson(bg === 'level' ? null : bg) } : {}) };
  };

  // ---- tiles: runs per layer; grouped ones, and the old editor's quarter-piece joins, one by one ----
  const objects = [], tileLayers = [], skip = new Map();
  const cellGroups = d.cellGroups || {};
  const single = (layer, x, y, extra) => {
    if (!skip.has(layer)) skip.set(layer, new Set());
    skip.get(layer).add(x + ',' + y);
    const l = d.tiles.layers.get(layer), v = d.tiles.cell(layer, x, y), name = d.tiles.tileName(v);
    const c = { x: l.ox + (x + 0.5) * l.size, y: l.oy + (y + 0.5) * l.size };
    objects.push({ type: 'tile', tilemap: tilemapName(layer), tileName: tileAsset(name), ...rel(c), matrix: d.tiles.matrix(v), ...extra });
  };
  for (const [k, e] of d.tiles.extra) if (e?.spriteFrom) { const bar = k.lastIndexOf('|'), [x, y] = k.slice(bar + 1).split(',').map(Number); single(k.slice(0, bar), x, y, { spriteFrom: e.spriteFrom }); }
  for (const [k, g] of Object.entries(cellGroups)) {
    const bar = k.lastIndexOf('|'), [x, y] = k.slice(bar + 1).split(',').map(Number), layer = k.slice(0, bar);
    if (d.tiles.cell(layer, x, y) && !skip.get(layer)?.has(x + ',' + y)) single(layer, x, y, { group: g });
  }
  for (const layer of d.tiles.layers.keys()) {
    // Names as the game knows its tiles; the editor's own (with the picture a rule tile or an
    // unnamed tile showed) kept beside them, so the map reopens exactly.
    const { names: full, runs } = d.tiles.runs(layer, (n) => n, skip.get(layer));
    const names = full.map(tileAsset);
    if (runs.length) tileLayers.push({ tilemap: tilemapName(layer), names, runs, ...(full.some((n, i) => n !== names[i]) ? { editorNames: full } : {}) });
  }

  // ---- things ----
  const order = (e) => (e.dz ? { orderDelta: e.dz } : {});
  const group = (e) => (e.group ? { group: e.group } : {});
  const byUid = new Map(d.entities.filter((e) => e.uid).map((e) => [e.uid, e]));
  for (const e of d.entities) {
    if (e.kind === 'unit' || e.kind === 'object') {
      const item = partsOf(base, e);
      if (!item) continue;
      objects.push(e.kind === 'unit' ? unitJson(e, item) : { type: 'clone', path: item.path, srcX: item.x, srcY: item.y, ...rel(e), ...order(e), ...group(e), ...cloneConfig(e, item) });
    } else if (e.kind === 'spike') objects.push({ ...(e.grid ? trueSpikeJson(e) : freeSpikeJson(e)), ...order(e), ...group(e) });
    else if (e.kind === 'text') objects.push({ type: 'sign', path: SIGN_PATH, ...rel(e), text: e.t, width: e.w, height: e.h, color: rgb(e.c || SIGN_COLOR), rotation: e.r || 0, ...(e.alpha != null && e.alpha !== 1 ? { alpha: e.alpha } : {}), ...order(e), ...group(e) });
    // Drawn at its own order, as here (0 sits behind the backdrop and ground, in front of the walls).
    else if (e.kind === 'sprite') objects.push({ ...spriteJson(e), drawOrder: e.dz || 0, ...group(e) });
    else if (e.kind === 'trigger') objects.push(triggerJson(e));
  }

  function unitJson(o, item) {
    const u = item, out = { type: 'clone', path: u.path, srcX: u.x, srcY: u.y, x: Math.round((o.x - origin.x) * 10) / 10, y: Math.round((o.y - origin.y) * 10) / 10, world: true };
    if (u.cut) out.cut = u.cut;
    if (u.toggles) out.toggles = Object.fromEntries(Object.entries(u.toggles).map(([k, s]) => [k, s === (st || 'start')]));
    Object.assign(out, order(o), group(o));
    const credits = o.creditsMode || (o.vmanOnly ? 'vman' : 'game');
    if (u.object?.cls === 'FakeCreditsControlScript' && credits !== 'game') out.credits = credits;
    if (u.door != null && base.scene.units[u.door]) out.door = base.scene.units[u.door].path;
    if (o.boxEdit && u.object?.box) {
      const b = { currency: CURRENCY_ENUM[u.object.box.currency] || 'Cash', price: u.object.box.price ?? 10, scale: u.object.box.scale ?? 1.5, add: u.object.box.add ?? 0, power: u.object.box.power ?? 1, max: u.object.box.max ?? 1, prices: [], label: '', ...o.boxEdit };
      out.levelUpgrade = { id: 'level:' + u.path, label: b.label, currency: b.currency, prices: prices(b), scale: b.scale, add: b.add, power: b.power, max: b.max };
    }
    return { ...out, ...cloneConfig(o, item) };
  }

  function cloneConfig(o, item) {
    const cfg = o.cfg || {}, out = {};
    if (item.upgradeBox) {
      const u = { kind: 'dash', currency: 'Cash', price: 10, scale: 1.5, add: 0, power: 1, max: 1, prices: [], label: '', ...(cfg.upgrade || {}) };
      if (!MULTI.has(u.kind)) u.max = 1;
      return { ...transformJson(cfg), ...(linked(o.course) ? { course: o.course } : {}), upgrade: { id: o.uid || 'box' + R(o.x) + '_' + R(o.y), kind: u.kind, label: u.label || (u.kind === 'omniDash' ? OMNI_LABEL : ''), currency: u.currency, prices: prices(u), scale: u.scale, add: u.add, power: u.power, max: u.max } };
    }
    if (item.worldScale) {
      const S = item.worldScale * (cfg.scale || 1);
      const main = item.parts.find((p) => !(p.n === 'InactiveSprite' || p.a === 0)) || item.parts[0], bx = Math.sign(main?.m?.[0]) || 1, by = Math.sign(main?.m?.[3]) || 1;
      return { absolute: true, rotation: cfg.rot || 0, scale: [S * (cfg.sx || 1) * (cfg.fx ? -1 : 1) * bx, S * (cfg.sy || 1) * (cfg.fy ? -1 : 1) * by], tint: [1, 1, 1], ...(cfg.alpha != null && cfg.alpha !== 1 ? { alpha: cfg.alpha } : {}) };
    }
    if (item.stretch && cfg.width && cfg.width !== item.stretch.width) out.width = cfg.width;
    Object.assign(out, transformJson(cfg));
    if (cfg.fields && Object.keys(cfg.fields).length) out.fields = cfg.fields;
    const zip = item.zip && cfg.zip ? zipConfig(o, item) : null;
    if (zip) out.zip = { end: zip.end, time: zip.time, backTime: zip.backTime, size: zip.size, ...(zip.auto ? { auto: true, pauseMove: zip.pauseMove, pauseReturn: zip.pauseReturn } : {}) };
    if (linked(o.course)) out.course = o.course;
    if (item.name === 'Course checkpoint') out.courseCheckpoint = true;
    const sizable = /^(Course )?[Cc]heckpoint$/.test(item.name || '') || /^Long fall/.test(item.name || '');
    if (sizable && cfg.trig) out.trigger = { w: cfg.trig.w, h: cfg.trig.h, dx: cfg.trig.dx, dy: cfg.trig.dy };
    if (item.name === 'Teleporter' || item.tele || o.tp) {
      const ref = (r) => {
        if (!r) return null;
        if (r.startsWith('p:')) { const t = byUid.get(r.slice(2)); return t ? { uid: t.uid } : null; }
        return null;
      };
      out.teleport = { id: o.uid || 'tp' + R(o.x) + '_' + R(o.y), zone: zoneNum(o) || 1, up: ref(o.tp?.up), down: ref(o.tp?.down) };
    }
    return out;
  }
  function linked(id) { return !!(id && d.courses.some((c) => c.id === id)); }

  function triggerJson(t) {
    const k = t.t || 'media', o = { type: 'trigger', kind: k, ...rel(t), w: t.w, h: t.h, ...(t.once ? { once: true } : {}) };
    if (k === 'media') Object.assign(o, t.music ? { music: t.music } : {}, t.background ? { background: backgroundJson(t.background === 'level' ? null : t.background) } : {}, t.zone ? { zone: t.zone } : {}, t.a1 != null ? { a1: t.a1 } : {});
    if (GROUP_KINDS.has(k)) o.group = t.group || '';
    if (k === 'move') Object.assign(o, { dx: t.dx || 0, dy: t.dy || 0, time: t.time ?? 1, ...(t.back ? { back: true } : {}) });
    if (MARKER_KINDS.has(k)) Object.assign(o, { tx: R(t.x + (t.tx || 0) - origin.x), ty: R(t.y + (t.ty || 0) - origin.y) });
    if (k === 'zoom') o.size = t.size || 1;
    if (k === 'message') Object.assign(o, { text: t.text || '', seconds: t.seconds ?? 3 });
    return o;
  }

  const spikeTile = (c, q) => spikeTileOf(base, c, q);
  function trueDef() {
    const t = spikeTile('spike', 0), pts = (t.def?.shape || [[[13, 3], [-13, 3], [-13, -16], [13, -16]]]).flat();
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    const cx = (x0 + x1) / 2, h = y1 - y0, half = Math.max(4, (x1 - x0) / 2 - 1), box = [cx - half, y0, cx + half, y0 + 2 * h];
    return { box, shape: [[[box[2], box[3]], [box[0], box[3]], [box[0], box[1]], [box[2], box[1]]]] };
  }
  function trueSpikeJson(sp) {
    const q = sp.q || 0, t = spikeTile('spike', q);
    return { type: 'trueSpike', tilemap: t.layer, tileName: t.tile, ...rel(sp), matrix: t.matrix, rotation: q * 90, color: rgb(TRUE_COLOR), hitbox: trueDef().box };
  }
  function freeSpikeJson(f) {
    const turn = (shape, m) => shape.map((poly) => poly.map(([x, y]) => [Math.round((m[0] * x + m[1] * y) * 100) / 100, Math.round((m[2] * x + m[3] * y) * 100) / 100]));
    const E = mul2(rot2(((f.r || 0) * Math.PI) / 180), [(f.s || 1) * (f.fx ? -1 : 1), 0, 0, (f.s || 1) * (f.fy ? -1 : 1)]);
    if (f.c === 'true') { const t = spikeTile('spike', f.q || 0); return { type: 'freeSpike', tilemap: t.layer, tileName: t.tile, ...rel(f), matrix: mul2(E, t.matrix), color: rgb(TRUE_COLOR), shape: turn(turn(trueDef().shape, rotMatrix(f.q || 0)), E) }; }
    const t = spikeTile(f.c, f.q || 0);
    return { type: 'freeSpike', tilemap: t.layer, tileName: t.tile, ...rel(f), matrix: mul2(E, t.matrix), shape: turn(turn(t.def?.shape || [[[-12, -16], [12, -16], [0, 14]]], t.matrix), E) };
  }
  function spriteJson(cs) {
    const common = { ...rel(cs), scaleX: (cs.scale || 1) * (cs.sx || 1), scaleY: (cs.scale || 1) * (cs.sy || 1), rotation: cs.r || 0, ...(cs.alpha != null && cs.alpha !== 1 ? { alpha: cs.alpha } : {}), ...(cs.fx ? { flipX: true } : {}), ...(cs.fy ? { flipY: true } : {}) };
    return cs.game ? { type: 'gameSprite', sprite: cs.game, ...common } : { type: 'customSprite', image: cs.image, scale: cs.scale || 1, ...common };
  }
  function zipConfig(o, item) {
    const z = item.zip, c = o.cfg?.zip || {}, end = c.end || z.end;
    const part = item.parts.find((p) => p.n === 'ZipMoverMovingPart'), [w, h] = part?.sz || [96, 384];
    const pb = Math.abs(z.end[1]) < Math.abs(z.end[0]) ? { thick: w, span: h } : { thick: h, span: w };
    const span = c.span ?? pb.span, across = Math.abs(end[1]) < Math.abs(end[0]) * 0.5;
    return { end, time: c.time ?? z.time, backTime: c.backTime ?? z.backTime, auto: !!c.auto, pauseMove: c.pauseMove ?? 1, pauseReturn: c.pauseReturn ?? 0.5, size: across ? [pb.thick, span] : [span, pb.thick] };
  }

  // ---- courses ----
  const courseJson = (c) => {
    const screen = courseScreen(c);
    const out = { id: c.id, startX: R(c.start.x - origin.x), startY: R(c.start.y - origin.y), endX: R(c.end.x - origin.x), endY: R(c.end.y - origin.y), screenX: R(screen.x - origin.x), screenY: R(screen.y - origin.y), reward: c.reward || { currency: 'Cash', amount: 0 },
      ...(c.dz ? { orderDelta: c.dz } : {}),
      ...(c.resets?.length || c.level != null ? { resets: (c.resets || []).map((g) => { const b = g.box || RESET_BOX; return { x: R(g.x - origin.x), y: R(g.y - origin.y), w: b.w, h: b.h, dx: b.dx, dy: b.dy }; }) } : {}) };
    const lc = c.level && base.courses.find((x) => x.n === c.level);
    if (lc?.copy) {
      const cp = lc.copy;
      out.level = { path: cp.path, srcX: cp.x, srcY: cp.y, x: cp.x - origin.x, y: cp.y - origin.y, cut: cp.cut || [], ...(cp.toggles ? { toggles: Object.fromEntries(Object.entries(cp.toggles).map(([k, s]) => [k, s === (st || 'start')])) } : {}),
        startX: lc.start.x - origin.x, startY: lc.start.y - origin.y, endX: lc.end.x - origin.x, endY: lc.end.y - origin.y, ...(lc.screen ? { screenX: lc.screen[0] - origin.x, screenY: lc.screen[1] - origin.y } : {}),
        resets: (lc.resets || []).map((g) => ({ x: g.x - origin.x, y: g.y - origin.y })) };
    }
    return out;
  };

  const startZone = st ? zoneNum(spawn) : 0;
  const xspawns = d.entities.filter((e) => e.kind === 'spawn');
  return {
    ...(tileLayers.length ? { tileLayers, mats: d.tiles.mats } : {}),
    ...(startZone ? { startZone } : {}),
    ...(st ? { areaState: st } : {}),
    formatVersion: 1,
    uid: d.meta.uid,
    name: (d.meta.name || '').trim() || 'Untitled map',
    description: (d.meta.description || '').trim(),
    images: [],
    customImages: [],
    levelOrigin: [origin.x, origin.y],
    ...(!d.meta.ownProgress && d.meta.player ? { player: d.meta.player } : {}),
    music: d.meta.music || 'level',
    background: backgroundJson(d.meta.background),
    editor: { v: 2, meta: d.meta, entities: d.entities, courses: d.courses, cellGroups },
    groups: [{
      startX: R((hasGates ? first.start : spawn).x - origin.x), startY: R((hasGates ? first.start : spawn).y - origin.y),
      endX: R((hasGates ? first.end : spawn).x - origin.x), endY: R((hasGates ? first.end : spawn).y - origin.y),
      spawnX: R(spawn.x - origin.x), spawnY: R(spawn.y - origin.y),
      ...(xspawns.length ? { spawns: xspawns.map((s) => ({ ...rel(s), area: spawnArea(s) })) } : {}),
      spawnArea: spawnArea(spawn),
      gates: hasGates,
      reward: complete[0]?.reward || { currency: 'Cash', amount: 0 },
      courses: complete.map(courseJson),
      objects,
    }],
  };
}

function prices(u, n = u.max) {
  const out = [];
  let c = u.price;
  for (let i = 0; i < n; i++) {
    if (i < u.prices.length) c = u.prices[i];
    else if (i > 0) c = Math.ceil(Math.pow(c + u.add, u.power) * u.scale);
    if (!Number.isFinite(c)) c = out.length ? out[out.length - 1] : 0;
    out.push(c);
  }
  return out;
}
function transformJson(cfg) {
  const out = {}, X = (cfg.scale || 1) * (cfg.sx || 1), Y = (cfg.scale || 1) * (cfg.sy || 1);
  if (cfg.rot) out.rotation = cfg.rot;
  if (X !== 1 || Y !== 1 || cfg.fx || cfg.fy) out.scale = [X * (cfg.fx ? -1 : 1), Y * (cfg.fy ? -1 : 1)];
  if (cfg.alpha != null && cfg.alpha !== 1) out.alpha = cfg.alpha;
  return out;
}
