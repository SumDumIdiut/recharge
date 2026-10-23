// JSON.stringify(value, null, 2), byte for byte, produced in pieces so a big map doesn't hold the page for the whole of it.
// The parts of the map that are small are written at once (so they are one consistent moment); every array or object with more
// than BIG entries is written a slice at a time, handing the page back between slices when a slice's time budget has run out.
// A slice is stringified by the engine itself, wrapped in as many arrays as the container is deep, so its lines come out
// indented for where they sit and need no re-indenting; the wrappers' own lines are cut off.
export const BIG = 2000;
const SMALL = 64; // containers up to this many entries are walked piece by piece (to find big ones inside); the ones between are written whole
const pad = (d) => '  '.repeat(d);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.toJSON !== 'function';
const dropped = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';
// The engine's own pretty text of a value, moved to depth d (a literal newline only ever comes from the indentation).
function leaf(v, d) {
  const s = JSON.stringify(v, null, 2);
  return s === undefined || !d ? s : s.replace(/\n/g, '\n' + pad(d));
}

// Pass 1, at once: the text with a marker where a big container goes.
function plan(v, d, out, big) {
  if (Array.isArray(v)) {
    if (v.length > big) { out.push({ big: v, depth: d }); return; }
    if (v.length > SMALL || !v.length) { out.push(leaf(v, d)); return; }
    out.push('[\n');
    for (let i = 0; i < v.length; i++) {
      out.push(pad(d + 1));
      if (dropped(v[i])) out.push('null'); else plan(v[i], d + 1, out, big);
      out.push(i < v.length - 1 ? ',\n' : '\n');
    }
    out.push(pad(d) + ']');
  } else if (isPlain(v)) {
    const keys = Object.keys(v).filter((k) => !dropped(v[k]));
    if (keys.length > big) { out.push({ big: v, keys, depth: d }); return; }
    if (keys.length > SMALL || !keys.length) { out.push(leaf(v, d)); return; }
    out.push('{\n');
    for (let i = 0; i < keys.length; i++) {
      out.push(pad(d + 1) + JSON.stringify(keys[i]) + ': ');
      plan(v[keys[i]], d + 1, out, big);
      out.push(i < keys.length - 1 ? ',\n' : '\n');
    }
    out.push(pad(d) + '}');
  } else out.push(leaf(v, d));
}

// A slice of a big container as the lines it has at depth d, without its own brackets.
function sliceText(items, d) {
  let w = items;
  for (let i = 0; i < d; i++) w = [w];
  const s = JSON.stringify(w, null, 2);
  // The engine wrote "[\n" at each level above the slice plus the slice's own opening, and the matching closers, each on a line of its own.
  let cut = 0;
  for (let i = 0; i <= d; i++) cut += 2 * i + 2;
  return s.slice(cut, s.length - cut);
}

// Hands the page back for a moment. A timer does it politely (input and frames go first), but a hidden window's timers wait a second
// each, which would stretch a save into minutes; a message does not wait.
function yieldPage() {
  return new Promise((resolve) => {
    if (typeof document !== 'undefined' && document.hidden && typeof MessageChannel === 'function') {
      const c = new MessageChannel();
      c.port1.onmessage = () => { c.port1.close(); resolve(); };
      c.port2.postMessage(0);
    } else setTimeout(resolve, 0);
  });
}

export async function prettyStringify(value, { big = BIG, slice = 1000, budgetMs = 8, yieldNow = yieldPage } = {}) {
  if (dropped(value)) return JSON.stringify(value, null, 2); // undefined, as the engine
  const out = [];
  plan(value, 0, out, big);
  let t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const parts = [];
  for (const p of out) {
    if (typeof p === 'string') { parts.push(p); continue; }
    const { big: v, depth: d } = p;
    const isArr = Array.isArray(v);
    const keys = isArr ? null : p.keys;
    const n = isArr ? v.length : keys.length;
    parts.push(isArr ? '[\n' : '{\n');
    for (let i = 0; i < n; i += slice) {
      const end = Math.min(n, i + slice);
      let items;
      if (isArr) items = v.slice(i, end);
      else { items = Object.create(null); for (let j = i; j < end; j++) items[keys[j]] = v[keys[j]]; }
      parts.push(sliceText(items, d));
      parts.push(end < n ? ',\n' : '\n');
      if (clock() - t0 > budgetMs) { await yieldNow(); t0 = clock(); }
    }
    parts.push(pad(d) + (isArr ? ']' : '}'));
  }
  return parts.join('');
}
