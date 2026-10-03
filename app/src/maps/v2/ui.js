// The panels floating over the map: tools, palette, inspector, the map menu.
import { TileStore } from '../tilestore.js';
import { layerInfo, baseLayer, GHOST } from './base.js';
import { familyOf } from './rules.js';
import { partsOf } from './render/world.js';
import { fieldsOf, getPath, setPath } from './fields.js';
import { addAsset, pickFile, assetUrl } from './io.js';

const LAYER_NAMES = { 'new awesome nikki ground': 'Ground', 'OOB areas': 'Out of bounds', Ilusorywalls: 'Illusory walls', blueBlocks: 'Blue', orangeBlocks: 'Orange', lightBlocker: 'Light blocker', InvisibleWall: 'Invisible wall', hiddenSpikes: 'Hidden', blueSpikes: 'Blue', orangeSpikes: 'Orange', OvergrowthSpikes: 'Overgrowth', OvergrowthMoss: 'Overgrowth', backgroundSpikes1: 'Background', backgroundSpikes2: 'Background 2', 'Environmental objects': 'Wall art', 'Environmental objects_back': 'Wall art behind', environmentalObjects_front: 'In front', EnvironmentalObjectsFrontOfTiles: 'In front of tiles', Background_moss: 'Moss behind', Background_Moss_Front: 'Moss in front' };
const FAMILY_NAMES = {
  ground1_tileset_: 'Ground', dark_ground_tileset_: 'Dark ground', gril_tileset_: 'Grate', blue_ground_tileset_: 'Blue ground', orange_ground_tileset_: 'Orange ground',
  Asset_Sheet_: 'Metal plates', 'TILE V2 Tileset_': 'Tiled wall', 'FLOOR V2 Tileset_': 'Floor tiles', '@tile_': 'Wall panels', '@tile lighter_': 'Light panels',
  Fresco_: 'Fresco', broken_beam_: 'Beams', 'OOB areas_': 'Backdrop', Black_: 'Black', spike_tileset_: 'Spikes', 'Spikes Tileset_': 'Spike row', Moss: 'Moss',
  'Mossy - Decorations&Hazards_': 'Moss bits', line_tileset_: 'Line', 'Line Start_': 'Line start', 'Line Corner_': 'Line corner', 'Line end_': 'Line end',
  '@ BANNER_': 'Banner', Vent_: 'Vent', 'flux capacitor barnacle_': 'Barnacle',
};
// The build bar's categories: [id, label, icon].
// Blocks: every tileset. Hazards: what kills. Decor: what's only to look at. Objects: what does something.
const CATS = [['blocks', 'Blocks', '▦'], ['hazards', 'Hazards', '▲'], ['decor', 'Decor', '❦'], ['objects', 'Objects', '⚙'], ['course', 'Course', '⚑'], ['triggers', 'Triggers', '◫']];
const GROUND = 'new awesome nikki ground', BG = 'Background', ENV = 'Environmental objects', FRONT = 'environmentalObjects_front';
// The tilesets, each once, on the layer that makes it what it is: [category, group, label, tileset, layer, tip].
// Any other tileset the level has lands in Decor; any layer a tileset is on can be picked in the options.
const TILESETS = [
  ['blocks', 'Ground', 'Ground', 'ground1_tileset_', GROUND], ['blocks', 'Ground', 'Dark ground', 'dark_ground_tileset_', GROUND], ['blocks', 'Ground', 'Grate', 'gril_tileset_', GROUND],
  ['blocks', 'Switch', 'Blue block', 'blue_ground_tileset_', 'blueBlocks', 'Solid while blue is on'], ['blocks', 'Switch', 'Orange block', 'orange_ground_tileset_', 'orangeBlocks', 'Solid while orange is on'],
  ['blocks', 'Walls', 'Wall panels', '@tile_', BG], ['blocks', 'Walls', 'Light panels', '@tile lighter_', ENV], ['blocks', 'Walls', 'Tiled wall', 'TILE V2 Tileset_', BG], ['blocks', 'Walls', 'Metal plates', 'Asset_Sheet_', BG],
  ['blocks', 'Walls', 'Floor tiles', 'FLOOR V2 Tileset_', ENV], ['blocks', 'Walls', 'Fresco', 'Fresco_', ENV], ['blocks', 'Walls', 'Beams', 'broken_beam_', BG],
  ['blocks', 'Walls', 'Backdrop', 'OOB areas_', 'OOB areas', 'The dark out-of-bounds fill'],
  ['blocks', 'Moss', 'Moss', 'Moss', 'moss'],
  ['blocks', 'Lines', 'Line', 'line_tileset_', FRONT], ['blocks', 'Lines', 'Line start', 'Line Start_', BG], ['blocks', 'Lines', 'Line corner', 'Line Corner_', BG], ['blocks', 'Lines', 'Line end', 'Line end_', ENV],
  ['blocks', 'Details', 'Banner', '@ BANNER_', ENV], ['blocks', 'Details', 'Vent', 'Vent_', FRONT], ['blocks', 'Details', 'Barnacle', 'flux capacitor barnacle_', FRONT],
  ['blocks', 'Special', 'Fake wall', 'ground1_tileset_', 'Ilusorywalls', 'Looks solid, the player walks through it'], ['blocks', 'Special', 'Hidden wall', 'ground1_tileset_', 'InvisibleWall', 'Solid, not drawn in the game'],
  ['blocks', 'Special', 'Light blocker', 'Asset_Sheet_', 'lightBlocker', 'Stops light, not drawn in the game'], ['blocks', 'Special', 'Ruined ground', 'ground1_tileset_', 'OvergrowthDestroyedGround', 'Only there in the overgrown level'],
  ['hazards', 'Kill tiles', 'Kill plate', 'TILE V2 Tileset_', 'Spikes', 'A plate that kills on touch'], ['hazards', 'Kill tiles', 'Black tile', 'Black_', 'hiddenSpikes', 'Kills on touch, drawn black'],
];
// Where a tileset brush can paint: these for any tileset, and the layers the level itself uses it on.
const PLACES = [GROUND, BG, ENV, 'Environmental objects_back', FRONT];
const BRUSH_LAYERS = { [GROUND]: 'Solid ground', [BG]: 'Wall (behind)', [ENV]: 'Wall art', 'Environmental objects_back': 'Far back', [FRONT]: 'In front', 'OOB areas': 'Backdrop',
  moss: 'Moss (always there)', OvergrowthMoss: 'Moss (overgrown level only)', Background_moss: 'Moss behind', blueBlocks: 'Blue switch', orangeBlocks: 'Orange switch' };
// Groups whose layer is what they are (a fake wall, a switch block, a kill tile): no layer choice.
const FIXED = new Set(['Switch', 'Special', 'Kill tiles']);
// A tileset the list above doesn't name: its category by the layer the level uses it on most.
const HOME_CAT = (layer) => (/Spikes/.test(layer) ? 'hazards' : 'blocks');
// Plant pictures the level keeps in a tile layer (placed from Decor), and spikes (placed one by one): not painted.
const NOT_TILESETS = new Set(['Mossy - Decorations&Hazards_', 'spike_tileset_', 'Spikes Tileset_']);
// Layers the player collides with: their brushes can paint with collision off.
const SOLID = new Set(['new awesome nikki ground', 'blueBlocks', 'orangeBlocks', 'OvergrowthDestroyedGround']);
const SPIKES = [['spike', 'Spike', '#d0d4c4'], ['dark', 'Dark spike', '#6a6d72'], ['blue', 'Blue spike', '#3f7fe0', 'Kills while blue is on'], ['orange', 'Orange spike', '#e08a3f', 'Kills while orange is on'], ['true', 'Red spike', '#ff2020', 'Kills on any touch']];
const THORNS = { BigThornLoop: 'Thorn loop', BigLoopAlt: 'Thorn loop 2', BigThornTallLoop: 'Tall loop', SmallLoop: 'Small loop', BigThornArc: 'Thorn arch', smallArc: 'Small arch', bigThornTangle: 'Thorn tangle', smallTangle: 'Small tangle', thornBig: 'Big thorn', thornBigAlt: 'Big thorn 2', Thorn: 'Thorn' };
const THORN_LAYERS = { Spikes: 'Normal', hiddenSpikes: 'Hidden', OvergrowthSpikes: 'Overgrown level only' };
const NAMES = { 'Dash refresher': 'Dash refill', 'Full refresher': 'Full refill', 'Jump refresher': 'Jump refill', 'Course checkpoint': 'Course check', 'Long fall start': 'Fall start', 'Long fall end': 'Fall end',
  'Course building': 'Course hut', Rod: 'Metal rod', 'Long cable': 'Cable', 'Long cable (curved)': 'Curved cable', 'Overgrowth trunk': 'Trunk', 'Overgrowth trunk (curved)': 'Curved trunk', 'Overgrowth trunk (vine-wrapped)': 'Vine trunk', 'Overgrowth trunk (wavy)': 'Wavy trunk' };
const PLANTS = { 'Hanging leaves': 'Leaves', 'Hanging vines': 'Vines', 'Leaf sprout': 'Sprout', 'Moss outline': 'Moss patch', 'Small plant': 'Plant' };
// The picture a thing is known by: its first sprite that isn't the faded used-up look.
const thumb = (parts = []) => (parts.find((p) => !p.is && p.n !== 'InactiveSprite') || parts.find((p) => !p.is))?.s;
const ICONS = { 'Long fall start': '⤓', 'Long fall end': '⤒' };
const OBJECT_GROUP = { Spring: 'Movement', 'Dash refresher': 'Movement', 'Full refresher': 'Movement', 'Jump refresher': 'Movement', 'Zip mover': 'Movement', Teleporter: 'Movement', 'Long fall start': 'Movement', 'Long fall end': 'Movement', Checkpoint: 'Progress', 'Upgrade box': 'Progress', 'Course checkpoint': 'Progress' };
const TRIGGERS = { media: 'Area / music', show: 'Show group', hide: 'Hide group', toggle: 'Toggle group', move: 'Move group', teleport: 'Teleport', kill: 'Kill zone', respawn: 'Set respawn', zoom: 'Camera zoom', message: 'Message' };
const TRIGGER_ICON = { media: '♪', show: '◉', hide: '◌', toggle: '⇄', move: '⇢', teleport: '⌁', kill: '☠', respawn: '↺', zoom: '⌕', message: '✉' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Panels {
  constructor(ed) {
    this.ed = ed;
    const root = ed.root;
    root.insertAdjacentHTML('beforeend', `
      <div class="mm2-build">
        <div class="mm2-modes">
          <button class="gd-btn gd-green" data-tool="build" title="Build: paint or place what's picked below (B)">Build</button>
          <button class="gd-btn" data-tool="select" title="Edit: select, box, move, turn (V)">Edit</button>
          <button class="gd-btn gd-danger" data-tool="erase" title="Delete: erase tiles and things (E)">Delete</button>
        </div>
        <div class="mm2-center">
          <div class="mm2-cats">${CATS.map(([id, label, icon]) => `<button class="gd-tab" data-cat="${id}" title="${esc(label)}"><b>${esc(icon)}</b><span>${esc(label)}</span></button>`).join('')}<input class="gd-search" placeholder="Search…"></div>
          <div class="mm2-stripwrap"><button class="gd-page" data-page="-1" title="Back">◀</button><div class="mm2-strip"></div><button class="gd-page" data-page="1" title="More">▶</button></div>
        </div>
        <div class="mm2-opts"></div>
      </div>
      <div class="mm2-dock gd-panel" hidden>
        <div class="mm2-dockhead"><div class="mm2-tabs"><button data-tab="inspect">Selected</button><button data-tab="layers">Layers</button><button data-tab="map">Map</button></div><button class="gd-x" data-act="dockclose" title="Close">✕</button></div>
        <div class="mm2-tabbody" data-body="inspect"></div>
        <div class="mm2-tabbody" data-body="layers" hidden></div>
        <div class="mm2-tabbody" data-body="map" hidden></div>
      </div>
      <div class="mm2-flash" hidden></div>`);
    this.side = root.querySelector('.mm2-dock');
    this.cat = 'blocks';
    root.querySelectorAll('.mm2-modes [data-tool]').forEach((b) => b.addEventListener('click', () => this.mode(b.dataset.tool)));
    root.querySelectorAll('.mm2-tabs button').forEach((b) => b.addEventListener('click', () => this.tab(b.dataset.tab)));
    root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { this.cat = b.dataset.cat; root.querySelector('.gd-search').value = ''; this.palette(''); }));
    root.querySelector('.gd-search').addEventListener('input', (e) => this.palette(e.target.value));
    root.querySelector('[data-act="dockclose"]').addEventListener('click', () => { this.side.hidden = true; });
    root.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { const st = root.querySelector('.mm2-strip'); st.scrollBy({ left: Number(b.dataset.page) * st.clientWidth * 0.9, behavior: 'smooth' }); }));
    root.querySelector('.mm2-strip').addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    ed.on('tool', () => this.syncTools());
    ed.on('selection', () => { this.inspect(); if (ed.selection.size) this.tab('inspect'); ed.root.querySelector('.mm2-build').classList.toggle('none', !ed.selection.size && !ed.tools.region); });
    ed.on('doc', () => { this.inspect(); if (!this.side.hidden) { this.map(); if (this.current === 'layers') this.layers(); } });
    this.syncTools();
    this.palette('');
    this.map();
  }

  // Build: what's picked below goes down (a tileset paints, a thing places).
  mode(tool) {
    const ed = this.ed;
    if (tool === 'build') {
      if (ed.place?.kind === 'arrowTool') ed.tools.setTool('arrow');
      else if (ed.place) ed.tools.setTool('place');
      else if (ed.brush) ed.tools.setTool('brush');
      else ed.tools.setTool('place');
    } else ed.tools.setTool(tool);
  }

  // ---- layers: show / hide and lock each of the game's tilemaps ----
  layers() {
    const ed = this.ed, el = this.side.querySelector('[data-body="layers"]'), r = ed.renderer;
    r.hidden ||= new Set();
    const all = [...ed.doc.tiles.layers.values()].map((l) => ({ l, meta: layerInfo(ed.base, l.name) })).filter((x) => x.meta.visible).sort((a, b) => b.meta.order - a.meta.order);
    el.innerHTML = `<div class="mm2-note">Front to back. Hidden layers aren't drawn here (the game still has them); locked ones can't be painted, erased or boxed.</div>` +
      all.map(({ l, meta }) => `<div class="mm2-layer"><button class="gd-mini" data-hide="${esc(l.name)}" title="Show / hide">${r.hidden.has(l.name) ? '◌' : '●'}</button><button class="gd-mini" data-lock="${esc(l.name)}" title="Lock / unlock">${ed.lockedLayers.has(l.name) ? '🔒' : '🔓'}</button><span>${esc((LAYER_NAMES[baseLayer(l.name)] || baseLayer(l.name)) + (meta.ghost ? ' (no collision)' : ''))}</span><em>${meta.order}</em></div>`).join('');
    el.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', () => { const n = b.dataset.hide; if (r.hidden.has(n)) r.hidden.delete(n); else r.hidden.add(n); ed.dirty = true; this.layers(); }));
    el.querySelectorAll('[data-lock]').forEach((b) => b.addEventListener('click', () => { const n = b.dataset.lock; if (ed.lockedLayers.has(n)) ed.lockedLayers.delete(n); else ed.lockedLayers.add(n); this.layers(); }));
  }

  tab(name) {
    this.current = name;
    this.side.hidden = false;
    if (name === 'layers') this.layers();
    if (name === 'map') this.map();
    this.side.querySelectorAll('.mm2-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    this.side.querySelectorAll('.mm2-tabbody').forEach((b) => { b.hidden = b.dataset.body !== name; });
  }
  syncTools() {
    const t = this.ed.tools.tool, build = t === 'brush' || t === 'place' || t === 'arrow' || t === 'paste';
    this.ed.root.querySelectorAll('.mm2-modes [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === (build ? 'build' : t)));
    // Edit swaps the pieces for the edit buttons, and back.
    const editing = t === 'select';
    if (editing !== this.editing) { this.editing = editing; this.palette(this.ed.root.querySelector('.gd-search').value || ''); }
    this.options();
  }

  // ---- Edit: the buttons that change what's selected (or the boxed part) ----
  editItems() {
    const ed = this.ed, T = ed.tools, out = [];
    const act = (icon, label, tip, fn) => ({ icon, label, tip, act: true, on: () => false, pick: fn });
    out.push({ sep: 'Move' });
    for (const [n, l, w] of [[1, '1px', '1 pixel'], [8, '1/4', 'a quarter tile'], [16, '1/2', 'half a tile'], [32, '1', 'a tile'], [160, '5', '5 tiles']]) {
      out.push(act('↑', l, 'Move up ' + w, () => T.nudge(0, n)), act('↓', l, 'Move down ' + w, () => T.nudge(0, -n)),
        act('←', l, 'Move left ' + w, () => T.nudge(-n, 0)), act('→', l, 'Move right ' + w, () => T.nudge(n, 0)));
    }
    out.push({ sep: 'Turn' });
    for (const d of [90, 45, 15]) out.push(act('⟲', d + '°', 'Turn left ' + d + '°', () => T.turn(-d)), act('⟳', d + '°', 'Turn right ' + d + '°', () => T.turn(d)));
    out.push({ sep: 'Flip' }, act('⇆', 'Across', 'Flip left to right (F)', () => T.flip('x')), act('⇅', 'Up/down', 'Flip upside down (Shift+F)', () => T.flip('y')));
    out.push({ sep: 'Size' }, act('＋', '+10%', 'Bigger', () => T.resize(1.1)), act('－', '-10%', 'Smaller', () => T.resize(1 / 1.1)), act('1:1', 'Reset', 'Its own size', () => T.resize(0)), act('×2', 'Double', 'Twice the size', () => T.resize(2)));
    out.push({ sep: 'Order' }, act('⤒', 'Front', 'In front of everything (Shift+])', () => ed.restack('front')), act('⤓', 'Back', 'Behind everything (Shift+[)', () => ed.restack('back')),
      act('▲', 'Up', 'One step forward (])', () => ed.restack('up')), act('▼', 'Down', 'One step back ([)', () => ed.restack('down')),
      act('▦', 'Behind blocks', 'Under blocks, ground and spikes', () => ed.restack('behindBlocks')), act('▤', 'Behind walls', 'Under every tile layer', () => ed.restack('behindWalls')));
    out.push({ sep: 'Edit' }, act('⧉', 'Copy', 'Copy (Ctrl+C)', () => T.copy()), act('⎘', 'Paste', 'Paste (Ctrl+V)', () => { if (ed.clip) T.setTool('paste'); else ed.flash('Copy something first'); }),
      act('⊕', 'Duplicate', 'Duplicate (Ctrl+D)', () => ed.duplicate()), act('✕', 'Delete', 'Delete (Del)', () => T.erase()),
      act('○', 'Deselect', 'Select nothing (Esc)', () => { T.region = null; ed.select([]); }));
    return out;
  }

  // ---- the build bar: what each category offers ----
  // Every tileset the level has, by category (curated ones first, the rest in Decor).
  tilesets() {
    if (this.sets) return this.sets;
    const ed = this.ed, on = new Map();
    for (const l of new Set((ed.base.art.levelTiles || []).map((x) => x.name))) for (const [fam, n] of ed.rules.families(l)) if (fam && !NOT_TILESETS.has(fam) && ed.rules.drawable(l, fam)) (on.get(fam) || on.set(fam, []).get(fam)).push([l, n]);
    const out = TILESETS.filter(([, , , fam, layer]) => on.get(fam)?.some(([l]) => l === layer)).map(([cat, group, label, fam, layer, tip]) => ({ cat, group, label, fam, layer, tip }));
    // Every tileset once: the ones above, then any other the game has, by where the level uses it.
    const named = new Set(out.map((t) => t.fam));
    for (const [fam, ls] of on) {
      if (named.has(fam)) continue;
      const [layer] = [...ls].sort((a, b) => b[1] - a[1])[0];
      out.push({ cat: HOME_CAT(layer), group: 'More', label: FAMILY_NAMES[fam] || fam.replace(/_$/, '').replace(/_/g, ' ').trim(), fam, layer });
    }
    // Where each can paint: its own layer first, then anywhere a tileset goes (solid ground, the walls,
    // in front), then the layers the level uses it on a lot.
    for (const t of out) {
      const own = (on.get(t.fam) || []).filter(([l, n]) => n >= 100).map(([l]) => l);
      t.layers = FIXED.has(t.group) ? [t.layer] : [...new Set([t.layer, ...PLACES, ...own])];
    }
    return (this.sets = out);
  }
  items(cat) {
    const ed = this.ed, b = ed.base, out = [];
    let group = null;
    const sep = (g) => { if (g && g !== group) out.push({ sep: g }); group = g; };
    const place = (label, p, thumb, tip) => ({ label, tip: tip ? label + ': ' + tip : label, ...thumb, obj: p.kind === 'object' || p.kind === 'unit' || (p.kind === 'sprite' && !!p.game), on: () => this.same(ed.place, p) && (ed.tools.tool === 'place' || ed.tools.tool === 'arrow'),
      pick: () => { ed.brush = null; ed.place = { ...p }; ed.tools.setTool(p.kind === 'arrowTool' ? 'arrow' : 'place'); } });
    if (cat === 'hazards') {
      sep('Spikes');
      for (const [c, l, color, tip] of SPIKES) out.push(place(l, { kind: 'fspike', c }, { icon: '▲', color }, (tip ? tip + '. ' : '') + 'R turns it'));
    }
    for (const t of this.tilesets().filter((x) => x.cat === cat)) {
      const key = t.label + '|' + t.fam;
      sep(t.group);
      out.push({ label: t.label, tip: t.tip ? t.label + ': ' + t.tip : t.label, tiles: { layer: t.layer, fam: t.fam, si: 0, prefer: () => ed.rules.styles(t.layer, t.fam)[0]?.tiles || null },
        on: () => ed.brush?.entry === key && ed.tools.tool === 'brush',
        pick: () => { ed.place = null; ed.brush = { entry: key, set: t, layer: this.withCollision(t.layer), family: t.fam, style: 0, prefer: ed.rules.styles(t.layer, t.fam)[0]?.tiles || null, size: ed.brushSize || 1 }; ed.tools.setTool('brush'); } });
    }
    if (cat === 'hazards') {
      sep('Thorns');
      const seen = new Set();
      for (const d of (b.defs || []).filter((x) => x.kind === 'vine')) {
        if (seen.has(d.tile)) continue;
        seen.add(d.tile);
        out.push({ ...place(THORNS[d.tile] || d.tile.replace(/([a-z])([A-Z])/g, '$1 $2'), { kind: 'vine', layer: 'Spikes', tile: d.tile }, { img: '/maps/vines/' + encodeURIComponent(d.sprite) + '.png' }, 'kills on touch'),
          on: () => ed.place?.kind === 'vine' && ed.place.tile === d.tile && ed.tools.tool === 'place' });
      }
    }
    if (cat === 'hazards') {
      sep('Traps');
      (b.catalog?.objects || []).forEach((it, i) => { if (it.name === 'Spike trap') out.push(place(it.name, { kind: 'object', cat: 'objects', i }, { sprite: thumb(it.parts) })); });
    }
    if (cat === 'decor') {
      sep('Plants');
      const n = new Map();
      for (const p of b.plants || []) {
        const raw = p.label.replace(/\s*\d+$/, ''), kind = PLANTS[raw] || raw, i = (n.get(kind) || 0) + 1;
        n.set(kind, i);
        out.push(place(kind + ' ' + i, { kind: 'sprite', game: p.sprite }, { img: '/maps/plants/' + p.file }));
      }
      sep('Things');
      (b.catalog?.decor || []).forEach((it, i) => out.push(place(NAMES[it.name] || it.name, { kind: 'object', cat: 'decor', i }, { sprite: thumb(it.parts) })));
      sep('Text');
      out.push(place('Sign text', { kind: 'text' }, { icon: 'Aa', color: '#7bb652' }), place('Guide arrow', { kind: 'arrowTool' }, { icon: '↝', color: '#f0a040' }, 'drag a path; Alt+click an end removes it'));
      sep('Your images');
      out.push({ label: 'Add image', tip: 'Add one of your images', icon: '+', color: '#8aa0b8', on: () => false, pick: async () => { const f = await pickFile('image/*'); if (!f) return; const file = await addAsset(ed.doc, 'image', f); ed.brush = null; ed.place = { kind: 'sprite', image: file }; ed.tools.setTool('place'); this.cat = 'decor'; this.palette(''); } });
      for (const a of (ed.doc.meta.assets || []).filter((x) => x.kind === 'image')) out.push(place(a.name, { kind: 'sprite', image: a.file }, { asset: a.file }));
    }
    if (cat === 'objects') {
      const objs = (b.catalog?.objects || []).map((it, i) => [it, i]).filter(([it]) => it.name !== 'Spike trap'), groups = ['Movement', 'Progress'];
      objs.sort((x, y) => groups.indexOf(OBJECT_GROUP[x[0].name] || 'Progress') - groups.indexOf(OBJECT_GROUP[y[0].name] || 'Progress'));
      for (const [it, i] of objs) { sep(OBJECT_GROUP[it.name] || 'Progress'); out.push(place(NAMES[it.name] || it.name, { kind: 'object', cat: 'objects', i }, thumb(it.parts) != null ? { sprite: thumb(it.parts) } : { icon: ICONS[it.name] || '◇', color: '#c8a0f0' })); }
    }
    if (cat === 'course') out.push(
      { sep: 'Course' },
      place('Start gate', { kind: 'start' }, { icon: '▶', color: '#41f88d' }, 'starts a new course'),
      place('End gate', { kind: 'end' }, { icon: '■', color: '#41f88d' }, 'ends the course you\'re on'),
      place('Timer reset', { kind: 'reset' }, { icon: '⟲', color: '#f0a040' }, 'ends a run without finishing it'),
      { sep: 'Player' },
      place('Spawn', { kind: 'spawnMain' }, { icon: '◉', color: '#5ec8f0' }, 'where the player starts'),
      place('Extra spawn', { kind: 'spawn' }, { icon: '◎', color: '#5ec8f0' }, 'Q / E switch between spawns in the game'));
    if (cat === 'triggers') for (const [t, l] of Object.entries(TRIGGERS)) out.push(place(l, { kind: 'trigger', t }, { icon: TRIGGER_ICON[t], color: '#e8d85a' }));
    // Objects and hazards go by their picture alone (the name shows on hover).
    for (const it of out) if (!it.sep && (cat === 'hazards' || it.obj)) it.bare = true;
    return out;
  }
  // A solid layer, or its no-collision copy when collision is switched off.
  withCollision(layer) { return SOLID.has(baseLayer(layer)) && this.ed.noCollision ? baseLayer(layer) + GHOST : baseLayer(layer); }
  same(a, b) { return !!a && !!b && Object.keys(b).every((k) => a[k] === b[k]); }
  // The level's own things, found by name (to bring back one you deleted).
  levelThings(q) {
    const ed = this.ed, seen = new Set();
    return (ed.base.scene.units || []).filter((u) => u && !seen.has(u.name) && seen.add(u.name) && (u.name || '').toLowerCase().includes(q) && !/StatuePrestigeText$/.test(u.path)).slice(0, 40)
      .map((u) => ({ label: u.name, tip: u.name + ' (from the level)', sprite: u.parts?.find((p) => !p.is)?.s, on: () => ed.place?.kind === 'unit' && ed.place.lv === u.id,
        bare: true, pick: () => { ed.brush = null; ed.place = { kind: 'unit', lv: u.id }; ed.tools.setTool('place'); } }));
  }

  palette(query = '') {
    const ed = this.ed, q = query.trim().toLowerCase(), el = ed.root.querySelector('.mm2-strip');
    ed.root.querySelector('.mm2-build').classList.toggle('editing', !!this.editing);
    ed.root.querySelector('.mm2-build').classList.toggle('none', !ed.selection.size && !ed.tools.region);
    ed.root.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('on', !q && b.dataset.cat === this.cat));
    let list = this.editing ? this.editItems() : q ? CATS.flatMap(([id]) => this.items(id)).filter((it) => !it.sep && it.label.toLowerCase().includes(q)) : this.items(this.cat);
    if (!this.editing && q.length >= 2) list = [...list, ...this.levelThings(q)];
    this.list = list;
    el.innerHTML = list.map((it, n) => it.sep ? `<div class="mm2-sep"><span>${esc(it.sep)}</span></div>` : `<button class="gd-item${it.bare ? ' bare' : ''}${it.act ? ' gd-act' : ''}${it.on() ? ' on' : ''}" data-n="${n}" title="${esc(it.tip || it.label)}">${it.icon ? `<i style="color:${it.color}">${esc(it.icon)}</i>` : it.img ? `<img src="${esc(it.img)}" alt="">` : '<canvas width="96" height="72"></canvas>'}${it.bare ? '' : `<span>${esc(it.label)}</span>`}</button>`).join('') || '<div class="mm2-note">Nothing matches.</div>';
    el.scrollLeft = 0;
    el.querySelectorAll('.gd-item').forEach((btn) => {
      const it = list[Number(btn.dataset.n)];
      btn.addEventListener('click', () => { it.pick(); this.syncPicked(); });
      const cv = btn.querySelector('canvas');
      if (it.asset) assetUrl(it.asset).then((u) => { if (u) { btn.insertAdjacentHTML('afterbegin', `<img src="${u}" alt="">`); cv?.remove(); } });
      else if (cv && it.tiles) requestAnimationFrame(() => this.preview(cv, it.tiles.layer, it.tiles.fam, it.tiles.si, it.tiles.prefer()));
      else if (cv && it.sprite != null) requestAnimationFrame(() => this.spriteThumb(cv, it.sprite));
    });
  }
  syncPicked() {
    this.ed.root.querySelectorAll('.mm2-strip .gd-item').forEach((b) => b.classList.toggle('on', !!this.list?.[Number(b.dataset.n)]?.on()));
    this.options();
  }
  // Right of the bar: what the picked thing can be set to before it goes down.
  options() {
    const ed = this.ed, el = ed.root.querySelector('.mm2-opts');
    if (!el) return;
    const t = ed.tools.tool;
    if (t === 'brush') {
      const br = ed.brush, size = br?.size || ed.brushSize || 1;
      const looks = br ? ed.rules.styles(br.layer, br.family) : [];
      const layers = br?.set?.layers || [], solid = br && SOLID.has(baseLayer(br.layer));
      el.innerHTML = `<div class="gd-label">Brush</div><div class="gd-sizes">${[1, 2, 3, 4, 6, 8].map((n) => `<button class="gd-mini${n === size ? ' on' : ''}" data-size="${n}">${n}</button>`).join('')}</div>` +
        (looks.length > 1 ? `<div class="gd-looks">${looks.map((st, i) => `<button class="gd-look${i === (br.style || 0) ? ' on' : ''}" data-look="${i}" title="${esc(st.name)} ${i + 1}"><canvas width="48" height="36"></canvas></button>`).join('')}</div>` : '') +
        (solid ? `<div class="gd-sizes" title="Off: drawn the same, but the player goes through it"><span class="gd-hint">Collision</span><button class="gd-mini${ed.noCollision ? '' : ' on'}" data-collide="1">On</button><button class="gd-mini${ed.noCollision ? ' on' : ''}" data-collide="0">Off</button></div>` : '') +
        (layers.length > 1 ? `<select class="gd-layer" title="Which of the game's layers it paints on">${layers.map((l) => `<option value="${esc(l)}"${l === baseLayer(br.layer) ? ' selected' : ''}>${esc(BRUSH_LAYERS[l] || LAYER_NAMES[l] || l)}</option>`).join('')}</select>` : '');
      el.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => { ed.brushSize = Number(b.dataset.size); if (ed.brush) ed.brush.size = ed.brushSize; this.options(); }));
      el.querySelectorAll('[data-look]').forEach((b) => {
        const i = Number(b.dataset.look);
        requestAnimationFrame(() => this.preview(b.querySelector('canvas'), br.layer, br.family, i, looks[i].tiles));
        b.addEventListener('click', () => { br.style = i; br.prefer = looks[i].tiles; this.options(); });
      });
      el.querySelectorAll('[data-collide]').forEach((b) => b.addEventListener('click', () => { ed.noCollision = b.dataset.collide === '0'; br.layer = this.withCollision(br.layer); this.options(); }));
      el.querySelector('.gd-layer')?.addEventListener('change', (e) => { br.layer = this.withCollision(e.target.value); br.style = 0; br.prefer = ed.rules.styles(br.layer, br.family)[0]?.tiles || null; this.options(); });
    } else if (t === 'select') {
      el.innerHTML = this.snapHtml() + `<div class="gd-sizes" title="What a box dragged over the map takes"><span class="gd-hint">Box takes</span><button class="gd-mini${ed.boxTiles !== false ? ' on' : ''}" data-box="1">+ Tiles</button><button class="gd-mini${ed.boxTiles === false ? ' on' : ''}" data-box="0">Things</button></div><div class="gd-hint">Ctrl lines up · Alt moves freely</div>`;
      this.bindSnap(el);
      el.querySelectorAll('[data-box]').forEach((b) => b.addEventListener('click', () => { ed.boxTiles = b.dataset.box === '1'; this.options(); }));
    }
    else if (t === 'erase') el.innerHTML = '<div class="gd-label">Delete</div><div class="gd-hint">Click or drag over tiles and things</div>';
    else {
      const p = ed.place, layers = p?.kind === 'vine' ? Object.keys(THORN_LAYERS).filter((l) => (ed.base.defs || []).some((d) => d.kind === 'vine' && d.tile === p.tile && d.layer === l)) : [];
      el.innerHTML = this.snapHtml() + '<div class="gd-hint">Click to place · Ctrl lines up · Esc stops</div>' +
        (layers.length > 1 ? `<select class="gd-layer" title="Where it goes in the game">${layers.map((l) => `<option value="${l}"${l === p.layer ? ' selected' : ''}>${THORN_LAYERS[l]}</option>`).join('')}</select>` : '');
      el.querySelector('.gd-layer')?.addEventListener('change', (e) => { p.layer = e.target.value; });
      this.bindSnap(el);
    }
  }
  // The snap grid: what moving and placing land on.
  snapHtml() {
    return `<div class="gd-label">Snap</div><div class="gd-sizes">${[[0, 'Off'], [8, '1/4'], [16, '1/2'], [32, '1']].map(([n, l]) => `<button class="gd-mini${n === this.ed.snap ? ' on' : ''}" data-snap="${n}" title="${n ? 'Land on a ' + l + ' tile grid' : 'Free, to the pixel'}">${l}</button>`).join('')}</div>`;
  }
  bindSnap(el) {
    el.querySelectorAll('[data-snap]').forEach((b) => b.addEventListener('click', () => { this.ed.snap = Number(b.dataset.snap); try { localStorage.setItem('mapEditorSnap', String(this.ed.snap)); } catch {} this.options(); }));
  }
  spriteThumb(cv, s) {
    const sp = this.ed.base.scene.sprites[s], img = this.ed.images.scene;
    if (!sp || !img) return;
    const [sx, sy, w, h] = sp, k = Math.min(cv.width / w, cv.height / h, 2), g = cv.getContext('2d');
    g.drawImage(img, sx, sy, w, h, (cv.width - w * k) / 2, (cv.height - h * k) / 2, w * k, h * k);
  }

  // A small patch of the tileset as the rules lay it out.
  preview(cv, layer, fam, style = 0, prefer = null) {
    const ed = this.ed, li = layerInfo(ed.base, layer), art = ed.base.art, atlas = ed.images.tiles;
    if (!this.scratch) this.scratch = new Map();
    let store = this.scratch.get(layer + '|' + fam + '|' + style);
    if (!store) {
      store = new TileStore(() => li, () => [1, 0, 0, 1]);
      const cells = [];
      for (let x = 0; x < 4; x++) for (let y = 0; y < 3; y++) cells.push([x, y]);
      try { ed.rules.paint(store, layer, cells, { family: fam, prefer }); } catch { /* shown empty */ }
      this.scratch.set(layer + '|' + fam + '|' + style, store);
    }
    const g = cv.getContext('2d'), k = cv.width / (4 * li.size);
    g.clearRect(0, 0, cv.width, cv.height);
    store.forRect(layer, 0, 0, 3, 2, (x, y, v) => {
      const s = art.tiles[store.tileName(v).replace(/@-?\d+$/, '')];
      if (s === undefined) return;
      const [sx, sy, w, h] = art.sprites[s], m = store.matrix(v);
      const cx = (x + 0.5) * li.size * k, cy = (2 - y + 0.5) * li.size * k;
      g.setTransform(k * m[0], -k * m[2], -k * m[1], k * m[3], cx + k * (-m[0] * w / 2 + m[1] * h / 2), cy + k * (m[2] * w / 2 - m[3] * h / 2));
      g.drawImage(atlas, sx, sy, w, h, 0, 0, w, h);
    });
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- the selection ----
  inspect() {
    const ed = this.ed, el = this.side.querySelector('[data-body="inspect"]'), ids = [...ed.selection];
    if (!ids.length) { el.innerHTML = '<div class="mm2-note">Nothing selected. Click a thing in Edit mode (V); drag empty space to box-select.</div>'; return; }
    if (ids.length === 1 && ids[0].startsWith('m:')) { this.inspectMarker(el, ids[0]); return; }
    const ents = ids.map((id) => ed.doc.get(id)).filter(Boolean);
    const one = ents.length === 1 ? ents[0] : null, item = one && partsOf(ed.base, one);
    const name = one ? (item?.name || one.n || one.kind) : `${ents.length} things`;
    const cfg = one?.cfg || {};
    el.innerHTML = `
      <div class="mm2-title2">${esc(name)}<span>${one ? esc(one.kind === 'unit' ? 'level thing' : one.kind) : ''}</span></div>
      ${one ? `<div class="mm2-row"><label>X<input type="number" data-f="x" value="${Math.round(one.x)}"></label><label>Y<input type="number" data-f="y" value="${Math.round(one.y)}"></label></div>
      <div class="mm2-row"><label>Turn<input type="number" data-c="rot" value="${cfg.rot || 0}"></label><label>Size<input type="number" step="0.05" data-c="scale" value="${cfg.scale || 1}"></label></div>
      <div class="mm2-row"><label class="mm2-check"><input type="checkbox" data-c="fx" ${cfg.fx ? 'checked' : ''}>Flip ↔</label><label class="mm2-check"><input type="checkbox" data-c="fy" ${cfg.fy ? 'checked' : ''}>Flip ↕</label></div>` : ''}
      ${one ? this.settingsHtml(one) : ''}
      <div class="mm2-sub">Draw order${one ? ': ' + (one.dz ? (one.dz > 0 ? '+' : '') + one.dz : 'as the level has it') : ''}</div>
      <div class="mm2-row"><button class="mm2-btn" data-st="front">Front</button><button class="mm2-btn" data-st="up">Up</button><button class="mm2-btn" data-st="down">Down</button><button class="mm2-btn" data-st="back">Back</button></div>
      <div class="mm2-row"><button class="mm2-btn" data-st="behindBlocks" title="Under blocks, ground and spikes; over walls and backdrop">Behind blocks</button><button class="mm2-btn" data-st="behindWalls" title="Under every tile layer">Behind walls</button></div>
      <div class="mm2-row"><button class="mm2-btn mm2-danger" data-act="delete">Delete</button><button class="mm2-btn" data-act="dup">Duplicate</button></div>`;
    el.querySelectorAll('[data-f]').forEach((i) => i.addEventListener('change', () => ed.doc.change('Move', () => { ed.doc.touch(one); one[i.dataset.f] = Number(i.value); })));
    el.querySelectorAll('[data-c]').forEach((i) => i.addEventListener('change', () => ed.doc.change('Transform', () => {
      ed.doc.touch(one);
      const c = (one.cfg = { ...(one.cfg || {}) }), f = i.dataset.c;
      if (i.type === 'checkbox') { if (i.checked) c[f] = true; else delete c[f]; } else { const v = Number(i.value); if ((f === 'scale' && v === 1) || (f === 'rot' && !v)) delete c[f]; else c[f] = v; }
    })));
    el.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', () => ed.restack(b.dataset.st)));
    if (one) this.bindSettings(el, one);
    el.querySelector('[data-act="delete"]').addEventListener('click', () => ed.deleteSelection());
    el.querySelector('[data-act="dup"]').addEventListener('click', () => ed.duplicate());
  }

  // A thing's own settings (fields.js), as inputs bound to it.
  settingsHtml(e) {
    const fs = fieldsOf(this.ed, e);
    if (!fs.length) return '';
    this.fieldList = fs;
    const row = (f, i) => {
      const v = getPath(e, f.path) ?? f.def;
      if (f.type === 'check') return `<label class="mm2-check"><input type="checkbox" data-fi="${i}" ${v ? 'checked' : ''}>${esc(f.label)}</label>`;
      if (f.type === 'select') return `<label>${esc(f.label)}<select data-fi="${i}">${f.options.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      if (f.type === 'area') return `<label>${esc(f.label)}<textarea data-fi="${i}" rows="2">${esc(v ?? '')}</textarea></label>`;
      return `<label>${esc(f.label)}<input data-fi="${i}" type="${f.type === 'num' ? 'number' : f.type === 'color' ? 'color' : 'text'}"${f.step ? ` step="${f.step}"` : ''} value="${esc(v ?? '')}"></label>`;
    };
    return `<div class="mm2-group">Settings</div>${fs.map((f, i) => `<div class="mm2-row">${row(f, i)}</div>`).join('')}`;
  }
  bindSettings(el, e) {
    const ed = this.ed, fs = this.fieldList || [];
    el.querySelectorAll('[data-fi]').forEach((input) => input.addEventListener('change', () => {
      const f = fs[Number(input.dataset.fi)];
      let v = f.type === 'check' ? input.checked : f.type === 'num' ? (input.value === '' ? '' : Number(input.value)) : input.value;
      if (f.type === 'select') v = f.options.find(([k]) => String(k) === input.value)?.[0] ?? v;
      ed.doc.change('Settings', () => { ed.doc.touch(e); setPath(e, f.path, v, f.def); });
    }));
  }

  // A course marker: its course's reward, and its place.
  inspectMarker(el, id) {
    const ed = this.ed, d = ed.doc, [, cid, which] = id.split(':'), c = d.courses.find((x) => x.id === cid), at = ed.markers.pos(id);
    const n = d.courses.indexOf(c) + 1, rw = c?.reward || { currency: 'Cash', amount: 0 };
    const what = { start: 'start gate', end: 'end gate', screen: 'screen', reset: 'timer reset' }[which] || which;
    el.innerHTML = id === 'm:spawn' ? `<div class="mm2-title2">Spawn<span>where the player starts</span></div>` : `
      <div class="mm2-title2">Course ${n}<span>${what}${c?.level ? ' · the level\'s course ' + c.level : ''}</span></div>
      ${which === 'reset' ? '<div class="mm2-note">Running through it ends the run without finishing it (no time, no reward).</div>' : ''}
      ${which === 'screen' ? '<div class="mm2-note">Shows the course\'s reward, best time and clones. Delete puts it back beside the start.</div>' : ''}
      <div class="mm2-row"><label>Reward<select data-r="currency">${[['Cash', 'Cash'], ['GreenPower', 'Green power'], ['AtomicPower', 'Nuclear power'], ['CloneDust', 'Clone dust'], ['RedPower', 'Red power'], ['BluePower', 'Blue power']].map(([v, l]) => `<option value="${v}"${v === rw.currency ? ' selected' : ''}>${l}</option>`).join('')}</select></label><label>Amount<input type="number" min="0" data-r="amount" value="${rw.amount || 0}"></label></div>`;
    el.insertAdjacentHTML('beforeend', at ? `<div class="mm2-row"><label>X<input type="number" data-p="x" value="${Math.round(at.x)}"></label><label>Y<input type="number" data-p="y" value="${Math.round(at.y)}"></label></div>
      ${which === 'screen' ? `<div class="mm2-sub">Draw order: ${c?.dz ? (c.dz > 0 ? '+' : '') + c.dz : 'over the walls'}</div>
      <div class="mm2-row"><button class="mm2-btn" data-st="front">Front</button><button class="mm2-btn" data-st="up">Up</button><button class="mm2-btn" data-st="down">Down</button><button class="mm2-btn" data-st="back">Back</button></div>
      <div class="mm2-row"><button class="mm2-btn" data-st="behindBlocks">Behind blocks</button><button class="mm2-btn" data-st="behindWalls">Behind walls</button></div>` : ''}
      <div class="mm2-row"><button class="mm2-btn mm2-danger" data-act="delete">${which === 'start' || which === 'end' ? 'Delete course' : 'Delete'}</button></div>` : '');
    el.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', () => ed.restack(b.dataset.st)));
    el.querySelectorAll('[data-r]').forEach((i) => i.addEventListener('change', () => d.change('Reward', () => { d.touchMeta(); c.reward = { ...(c.reward || { currency: 'Cash', amount: 0 }), [i.dataset.r]: i.dataset.r === 'amount' ? Number(i.value) || 0 : i.value }; })));
    el.querySelectorAll('[data-p]').forEach((i) => i.addEventListener('change', () => d.change('Move', () => { const p = ed.markers.pos(id); ed.markers.set(id, { ...p, [i.dataset.p]: Number(i.value) }); })));
    el.querySelector('[data-act="delete"]')?.addEventListener('click', () => ed.deleteSelection());
  }

  // ---- the map menu ----
  map() {
    const ed = this.ed, el = this.side.querySelector('[data-body="map"]'), d = ed.doc;
    if (!el) return;
    el.innerHTML = `
      <div class="mm2-title2">${esc(d.meta.name || 'Untitled map')}<span>${d.meta.levelState ? 'built from the level (' + d.meta.levelState + ')' : 'your own map'}</span></div>
      <div class="mm2-row"><label>Name<input data-m="name" value="${esc(d.meta.name)}"></label></div>
      <div class="mm2-sub">${d.tiles.size.toLocaleString()} tiles · ${d.entities.length} things · ${d.courses.length} courses</div>
      <div class="mm2-row"><button class="mm2-btn" data-act="undo">Undo</button><button class="mm2-btn" data-act="redo">Redo</button></div>
      <div class="mm2-group">Play and save</div>
      <div class="mm2-row"><button class="mm2-btn mm2-primary" data-act="save" title="Save to your installed maps (Ctrl+S)">Save</button><button class="mm2-btn" data-act="test" title="Install this map and start the game in it">Test in game</button><button class="mm2-btn" data-act="zip">Export .zip</button></div>
      <div class="mm2-sub">${d.meta.savedId ? 'Saves to your maps as ' + esc(d.meta.savedId) + (d.meta.savedAt ? ' · last saved ' + new Date(d.meta.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : 'Not saved yet'}</div>
      <div class="mm2-row"><label>Autosave<select data-m="autosave">${[0, 1, 2, 5, 10, 15].map((m) => `<option value="${m}"${(d.meta.autosave || 0) === m ? ' selected' : ''}>${m ? 'every ' + m + ' min' : 'off'}</option>`).join('')}</select></label><button class="mm2-btn" data-act="history" title="Earlier saves of this map">History…</button></div>
      <div class="mm2-list" data-hist hidden></div>
      <div class="mm2-group">The player</div>
      <div class="mm2-row"><label class="mm2-check"><input type="checkbox" data-own ${d.meta.ownProgress ? 'checked' : ''}>Start from the player's own save</label></div>
      ${d.meta.ownProgress ? '' : `<div class="mm2-row"><label>Dashes<input type="number" min="0" data-pl="dashes" value="${d.meta.player?.dashes ?? 1}"></label><label>Air jumps<input type="number" min="0" data-pl="airJumps" value="${d.meta.player?.airJumps ?? 1}"></label><label>Cash<input type="number" min="0" data-pl="cash" value="${d.meta.player?.cash ?? 0}"></label></div>
      <div class="mm2-row">${[['wallJump', 'Wall jump'], ['blockSwap', 'Block swap'], ['omniDash', 'Omni dash'], ['zipMovers', 'Zip movers'], ['refreshers', 'Refreshers'], ['teleporters', 'Teleporters']].map(([k, l]) => `<label class="mm2-check"><input type="checkbox" data-pl="${k}" ${d.meta.player?.[k] ? 'checked' : ''}>${l}</label>`).join('')}</div>`}
      <div class="mm2-row"><label>Background<select data-bg><option value="">The level's areas</option>${(d.meta.assets || []).filter((a) => a.kind === 'image').map((a) => `<option value="${esc(a.file)}"${d.meta.background?.image === a.file ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>${d.meta.background?.image ? `<label>Drift<input type="number" step="0.05" min="0" max="1" data-bgp="parallax" value="${d.meta.background.parallax ?? 0.8}"></label><label>Size<input type="number" step="0.1" min="0.1" data-bgp="scale" value="${d.meta.background.scale ?? 1}"></label>` : ''}</div>
      <div class="mm2-row"><label>Music<select data-music>${[...(d.meta.assets || []).filter((a) => a.kind === 'music').map((a) => ['asset:' + a.file, a.name]), ['level', 'The level\'s'], ['game:Area1Track1', 'Area 1 - track 1'], ['game:Area1Track2', 'Area 1 - track 2'], ['game:Area2Track1', 'Area 2 - track 1'], ['game:Area2Track2', 'Area 2 - track 2'], ['game:TripBreaker', 'Trip breaker'], ['game:Overgrowth', 'Overgrowth'], ['game:Vman', 'V-man'], ['game:Finale', 'Finale'], ['none', 'Silence']].map(([v, l]) => `<option value="${v}"${(d.meta.music || 'level') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label><button class="mm2-btn" data-act="addmusic">Add music…</button></div>
      <div class="mm2-group">Start over</div>
      <div class="mm2-row"><button class="mm2-btn" data-act="level-start">The whole level</button><button class="mm2-btn" data-act="level-over">…overgrown</button></div>
      <div class="mm2-group">Open</div>
      <div class="mm2-list" data-list></div>`;
    el.querySelector('[data-m="name"]').addEventListener('change', (e) => d.change('Rename', () => { d.touchMeta(); d.meta.name = e.target.value; }));
    el.querySelector('[data-act="undo"]').addEventListener('click', () => ed.afterHistory(d.undo(), 'Undid'));
    el.querySelector('[data-own]').addEventListener('change', (e) => d.change('Player', () => { d.touchMeta(); d.meta.ownProgress = e.target.checked; }));
    el.querySelectorAll('[data-pl]').forEach((i) => i.addEventListener('change', () => d.change('Player', () => { d.touchMeta(); d.meta.player = { ...(d.meta.player || {}), [i.dataset.pl]: i.type === 'checkbox' ? i.checked : Number(i.value) || 0 }; })));
    el.querySelector('[data-music]').addEventListener('change', (e) => d.change('Music', () => { d.touchMeta(); d.meta.music = e.target.value === 'level' ? undefined : e.target.value; }));
    el.querySelector('[data-bg]').addEventListener('change', (e) => d.change('Background', () => { d.touchMeta(); d.meta.background = e.target.value ? { image: e.target.value, parallax: 0.8, scale: 1 } : undefined; }));
    el.querySelectorAll('[data-bgp]').forEach((i) => i.addEventListener('change', () => d.change('Background', () => { d.touchMeta(); d.meta.background = { ...d.meta.background, [i.dataset.bgp]: Number(i.value) }; })));
    el.querySelector('[data-act="addmusic"]')?.addEventListener('click', async () => { const f = await pickFile('audio/*'); if (f) { const file = await addAsset(d, 'music', f); d.change('Music', () => { d.touchMeta(); d.meta.music = 'asset:' + file; }); } });
    el.querySelector('[data-act="save"]').addEventListener('click', () => ed.files.save());
    el.querySelector('[data-act="test"]').addEventListener('click', () => ed.files.test());
    el.querySelector('[data-act="zip"]').addEventListener('click', () => ed.files.exportZip());
    el.querySelector('[data-m="autosave"]').addEventListener('change', (e) => { d.meta.autosave = Number(e.target.value) || 0; ed.files.autoAt = 0; ed.saver.soon(); });
    el.querySelector('[data-act="history"]').addEventListener('click', async () => {
      const list = el.querySelector('[data-hist]');
      if (!list.hidden) { list.hidden = true; return; }
      list.hidden = false;
      if (!d.meta.savedId) { list.innerHTML = '<div class="mm2-note">Save the map first; each save after that keeps the one before.</div>'; return; }
      const versions = await ed.files.history();
      const when = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      list.innerHTML = versions.length ? versions.map((v) => `<button class="mm2-btn mm2-wide" data-file="${esc(v.file)}">${when(v.savedAt)} · ${v.auto ? 'autosave' : 'save'} · ${(v.size / 1e6).toFixed(1)} MB</button>`).join('') : '<div class="mm2-note">No earlier versions yet.</div>';
      list.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', async () => {
        try { await ed.openMapJson(await ed.files.openVersion(b.dataset.file), d.meta.savedId); ed.flash('Opened that version - Save to make it the current one'); } catch (e) { ed.flash('Couldn\'t open it: ' + e); }
      }));
    });
    el.querySelector('[data-act="redo"]').addEventListener('click', () => ed.afterHistory(d.redo(), 'Redid'));
    el.querySelector('[data-act="level-start"]').addEventListener('click', () => ed.startFromLevel('start'));
    el.querySelector('[data-act="level-over"]').addEventListener('click', () => ed.startFromLevel('overgrown'));
    ed.installedMaps().then((maps) => {
      const list = el.querySelector('[data-list]');
      if (!list) return;
      list.innerHTML = maps.length ? maps.map((m) => `<button class="mm2-btn mm2-wide" data-id="${esc(m.id)}">${esc(m.name || m.id)}</button>`).join('') : '<div class="mm2-note">Installed maps open here in the app.</div>';
      list.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => ed.openInstalled(b.dataset.id)));
    });
  }

  flash(msg) {
    const el = this.ed.root.querySelector('.mm2-flash');
    el.textContent = msg; el.hidden = false;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
}

export { familyOf };
