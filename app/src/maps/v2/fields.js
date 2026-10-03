// The settings a thing has, by kind: each { label, path, type, options?, def?, step? }.
// path: where the value lives on the entity ("cfg.fields.SpringScript.upForce" splits at dots,
// except inside fields' own names, given as an array).
import { partsOf } from './render/world.js';

const FIELD_LABELS = {
  'SpringScript.upForce': 'Up force', 'SpringScript.strength': 'Strength', 'SpringScript.movementLock': 'Movement lock (s)',
  'JiggleDropScript.cooldownOnUse': 'Regrow time (s)', 'JiggleDropScript.timeStopDuration': 'Time stop (s)',
};
export const UPGRADE_KINDS = [
  ['dash', 'Dash'], ['doubleJump', 'Double jump'], ['wallJump', 'Wall jump'], ['blockSwap', 'Block swap'], ['omniDash', 'Omni dash'], ['zipMovers', 'Zip movers'],
  ['refreshers', 'Refreshers'], ['clones', 'Clones'], ['baseReward', 'Base reward'], ['cloneMult', 'Clone reward multiplier'], ['fastClone', 'Fast clone chance'],
  ['bigClone', 'Big clone chance'], ['moreWatts', 'More watts'], ['greenReward', 'Green clone GP reward'], ['redReward', 'Red clone RP reward'], ['cloneDust', 'Clone dust generation'],
];
export const CURRENCIES = [['Cash', 'Cash'], ['GreenPower', 'Green power'], ['AtomicPower', 'Nuclear power'], ['CloneDust', 'Clone dust'], ['RedPower', 'Red power'], ['BluePower', 'Blue power']];
const SPIKE_COLOURS = [['spike', 'Spike'], ['dark', 'Dark spike'], ['blue', 'Blue spike'], ['orange', 'Orange spike'], ['true', 'Kill on touch']];
const TURNS = [[0, 'Up'], [1, 'Left'], [2, 'Down'], [3, 'Right']];
const AREAS = [['', 'None'], [1, 'Area 1'], [2, 'Area 2'], [3, 'Area 3']];
const TRACKS = [['', 'No change'], ['level', 'The area\'s own'], ['game:Area1Track1', 'Area 1 - track 1'], ['game:Area1Track2', 'Area 1 - track 2'], ['game:Area2Track1', 'Area 2 - track 1'], ['game:Area2Track2', 'Area 2 - track 2'], ['game:TripBreaker', 'Trip breaker'], ['game:Overgrowth', 'Overgrowth'], ['game:Vman', 'V-man'], ['game:Finale', 'Finale'], ['none', 'Silence']];

export function fieldsOf(ed, e) {
  const out = [], item = partsOf(ed.base, e), d = ed.doc;
  const courses = [['', 'None'], ...d.courses.map((c, i) => [c.id, 'Course ' + (i + 1)])];
  if (e.kind === 'unit' || e.kind === 'object') {
    for (const [f, def] of Object.entries(item?.fields || {})) out.push({ label: FIELD_LABELS[f] || f, path: ['cfg', 'fields', f], type: 'num', def, step: 0.1 });
    if (item?.upgradeBox) {
      out.push({ label: 'Upgrade', path: 'cfg.upgrade.kind', type: 'select', options: UPGRADE_KINDS, def: 'dash' });
      out.push({ label: 'Label', path: 'cfg.upgrade.label', type: 'text', def: '' });
      out.push({ label: 'Currency', path: 'cfg.upgrade.currency', type: 'select', options: CURRENCIES, def: 'Cash' });
      out.push({ label: 'Price', path: 'cfg.upgrade.price', type: 'num', def: 10 });
      out.push({ label: 'Times it can be bought', path: 'cfg.upgrade.max', type: 'num', def: 1 });
      out.push({ label: 'Price × each time', path: 'cfg.upgrade.scale', type: 'num', def: 1.5, step: 0.1 });
    }
    // One of the level's own boxes: its price, currency and how often it can be bought, as the map's.
    const box = e.kind === 'unit' && item?.object?.box;
    if (box) {
      const cur = ['Cash', 'GreenPower', 'AtomicPower', 'regularNumber', 'CloneDust', 'RedPower', 'BluePower'][box.currency] || 'Cash';
      out.push({ label: 'Label', path: 'boxEdit.label', type: 'text', def: '' });
      out.push({ label: 'Currency', path: 'boxEdit.currency', type: 'select', options: CURRENCIES, def: cur });
      out.push({ label: 'Price', path: 'boxEdit.price', type: 'num', def: box.price ?? 10 });
      out.push({ label: 'Times it can be bought', path: 'boxEdit.max', type: 'num', def: box.max ?? 1 });
      out.push({ label: 'Price × each time', path: 'boxEdit.scale', type: 'num', def: box.scale ?? 1.5, step: 0.05 });
      out.push({ label: 'Price + each time', path: 'boxEdit.add', type: 'num', def: box.add ?? 0 });
      out.push({ label: 'Price ^ each time', path: 'boxEdit.power', type: 'num', def: box.power ?? 1, step: 0.05 });
    }
    if (item?.upgradeBox || item?.name === 'Course checkpoint') out.push({ label: 'Course', path: 'course', type: 'select', options: courses, def: '' });
    if (item?.name === 'Teleporter' || item?.tele || e.tp) {
      const others = d.entities.filter((x) => x !== e && x.uid && (x.tp || partsOf(ed.base, x)?.name === 'Teleporter' || partsOf(ed.base, x)?.tele));
      const opts = [['', 'Nowhere'], ...others.map((x, i) => ['p:' + x.uid, 'Teleporter ' + (i + 1) + ' (' + Math.round(x.x) + ', ' + Math.round(x.y) + ')'])];
      out.push({ label: 'Up goes to', path: 'tp.up', type: 'select', options: opts, def: '' });
      out.push({ label: 'Down goes to', path: 'tp.down', type: 'select', options: opts, def: '' });
    }
    if (/^(Course )?[Cc]heckpoint$|^Long fall/.test(item?.name || '')) {
      const b = item.box || [-50, -50, 50, 50];
      out.push({ label: 'Area width', path: 'cfg.trig.w', type: 'num', def: b[2] - b[0] });
      out.push({ label: 'Area height', path: 'cfg.trig.h', type: 'num', def: b[3] - b[1] });
    }
    if (item?.object?.cls === 'FakeCreditsControlScript') out.push({ label: 'Plays', path: 'creditsMode', type: 'select', options: [['game', 'As the game: fake credits, V-man\'s ending as V-man'], ['fake', 'Always the fake credits'], ['vman', 'Only as V-man (V-man\'s ending)']], def: 'game' });
    if (item?.zip) {
      out.push({ label: 'Travel time (s)', path: 'cfg.zip.time', type: 'num', def: item.zip.time, step: 0.1 });
      out.push({ label: 'Return time (s)', path: 'cfg.zip.backTime', type: 'num', def: item.zip.backTime, step: 0.1 });
      out.push({ label: 'Goes by itself', path: 'cfg.zip.auto', type: 'check', def: false });
    }
  }
  if (e.kind === 'text') {
    out.push({ label: 'Text', path: 't', type: 'area', def: 'Text' });
    out.push({ label: 'Width', path: 'w', type: 'num', def: 280 }, { label: 'Height', path: 'h', type: 'num', def: 56 });
    out.push({ label: 'Colour', path: 'c', type: 'color', def: '#7bb652' }, { label: 'Turn (°)', path: 'r', type: 'num', def: 0 });
  }
  if (e.kind === 'sprite') {
    out.push({ label: 'Size', path: 'scale', type: 'num', def: 1, step: 0.05 }, { label: 'Turn (°)', path: 'r', type: 'num', def: 0 });
    out.push({ label: 'Flip ↔', path: 'fx', type: 'check', def: false }, { label: 'Flip ↕', path: 'fy', type: 'check', def: false });
    out.push({ label: 'Opacity', path: 'alpha', type: 'num', def: 1, step: 0.05 });
  }
  if (e.kind === 'spike') {
    if (!e.grid) out.push({ label: 'Kind', path: 'c', type: 'select', options: SPIKE_COLOURS, def: 'spike' });
    out.push({ label: 'Points', path: 'q', type: 'select', options: TURNS, def: 0 });
  }
  if (e.kind === 'trigger') {
    out.push({ label: 'Width', path: 'w', type: 'num', def: 256 }, { label: 'Height', path: 'h', type: 'num', def: 256 });
    const t = e.t || 'media';
    if (t === 'media') {
      out.push({ label: 'Loads area', path: 'zone', type: 'select', options: AREAS, def: '' });
      out.push({ label: 'Music', path: 'music', type: 'select', options: TRACKS, def: '' });
    }
    if (['show', 'hide', 'toggle', 'move'].includes(t)) out.push({ label: 'Group', path: 'group', type: 'text', def: '1' });
    if (t === 'move') out.push({ label: 'Move by x', path: 'dx', type: 'num', def: 0 }, { label: 'Move by y', path: 'dy', type: 'num', def: 256 }, { label: 'Time (s)', path: 'time', type: 'num', def: 1, step: 0.1 }, { label: 'Moves back', path: 'back', type: 'check', def: false });
    if (t === 'teleport' || t === 'respawn') out.push({ label: 'Marker x (from the zone)', path: 'tx', type: 'num', def: 512 }, { label: 'Marker y', path: 'ty', type: 'num', def: 0 });
    if (t === 'zoom') out.push({ label: 'Camera size ×', path: 'size', type: 'num', def: 1.5, step: 0.1 });
    if (t === 'message') out.push({ label: 'Message', path: 'text', type: 'text', def: 'Hello!' }, { label: 'Seconds', path: 'seconds', type: 'num', def: 3, step: 0.5 });
    out.push({ label: 'Only once', path: 'once', type: 'check', def: false });
  }
  if (e.kind === 'spawn') {
    out.push({ label: 'Loads area', path: 'zone', type: 'select', options: AREAS, def: '' });
    out.push({ label: 'Music', path: 'music', type: 'select', options: TRACKS, def: '' });
  }
  if (e.kind !== 'spawn' && e.kind !== 'arrow') out.push({ label: 'Group (for triggers)', path: 'group', type: 'text', def: '' });
  return out;
}

const split = (path) => (Array.isArray(path) ? path : path.split('.'));
export function getPath(o, path) { let v = o; for (const k of split(path)) { if (v == null) return undefined; v = v[k]; } return v; }
// Sets a value; the default (or empty) removes it, and empty objects on the way go too.
export function setPath(o, path, value, def) {
  const ks = split(path), chain = [o];
  let v = o;
  for (const k of ks.slice(0, -1)) { v[k] = v[k] && typeof v[k] === 'object' ? { ...v[k] } : {}; v = v[k]; chain.push(v); }
  const last = ks[ks.length - 1];
  if (value === '' || value == null || value === def) delete v[last]; else v[last] = value;
  for (let i = ks.length - 2; i >= 0; i--) if (!Object.keys(chain[i + 1]).length) delete chain[i][ks[i]];
}
