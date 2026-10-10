// Themed dropdown behaviour on a tiny fake DOM.  node tests/dropdown.test.mjs
import assert from 'node:assert/strict';

// ---- minimal DOM ----------------------------------------------------------------------------------------------
class El extends EventTarget {
  constructor(tag) {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
    this.className = ''; this.hidden = false; this.disabled = false; this.style = {}; this._text = ''; this.nodeType = 1;
    this.classList = {
      toggle: (c, on) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); (on ? s.add(c) : s.delete(c)); this.className = [...s].join(' '); },
    };
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document; }
  get childNodes() { return this.children; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  get id() { return this.attrs.id ?? ''; } set id(v) { this.attrs.id = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); this._mut(this, c); return c; }
  insertBefore(c, ref) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); this._mut(this, c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; }
  _mut(p, c) { document._added(c); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches?.(sel)) return n; return null; }
  matches(sel) { return sel[0] === '.' ? this.className.split(/\s+/).includes(sel.slice(1)) : this.tagName === sel.toUpperCase(); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect() { return { left: 10, top: 10, bottom: 30, right: 150, width: 140, height: 20 }; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get scrollHeight() { return 100; } get offsetWidth() { return 140; }
}
class Select extends El {
  constructor() { super('select'); this._i = 0; this.multiple = false; }
  get options() { return this.all().filter((n) => n.tagName === 'OPTION'); }
  get selectedIndex() { return this._i; } set selectedIndex(v) { this._i = v; }
  get value() { return this.options[this._i]?.value ?? ''; }
  set value(v) { const i = this.options.findIndex((o) => o.value === v); this._i = i; }
  appendChild(c) { super.appendChild(c); c.index = this.options.indexOf(c); return c; }
}
const document = new (class extends EventTarget {
  constructor() { super(); this.body = new El('body'); this.body.parentNode = this; this.obs = []; }
  createElement(t) { return t === 'select' ? new Select() : t === 'option' ? Object.assign(new El('option'), { value: '', label: '' }) : new El(t); }
  _added(c) { this.added?.push(c); }
})();
const G = globalThis;
G.document = document; G.innerWidth = 800; G.innerHeight = 600;
G.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} };
G.addEventListener = () => {};
const { init, enhanceAll, closeList } = await import('../src/dropdown.js');
init(document);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const mkSelect = (opts, extra) => {
  const s = document.createElement('select'); s.className = 'settings-input';
  document.body.appendChild(s);
  for (const [v, t, dis] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (dis) o.disabled = true; s.appendChild(o); }
  enhanceAll(s); return s;
};
const btnOf = (s) => s.parentNode.children.find((c) => c.tagName === 'BUTTON' && c.nextSibling !== 0 && s.parentNode.children.indexOf(c) === s.parentNode.children.indexOf(s) - 1);
const key = (b, k) => { let prevented = false; b.dispatchEvent(Object.assign(new Event('keydown'), { key: k, preventDefault() { prevented = true; }, stopPropagation() {} })); return prevented; };
const list = () => document.body.children.find((c) => c.className.includes('dd-list'));
const clickRow = (r) => { const e = new Event('click', { bubbles: true }); Object.defineProperty(e, 'target', { value: r }); list().dispatchEvent(e); };
const rows = () => list().querySelectorAll('.dd-opt');

test('enhances a select: button copies classes and shows the selected label', () => {
  const s = mkSelect([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
  const b = btnOf(s);
  assert.ok(b.className.includes('dd-btn') && b.className.includes('settings-input'));
  assert.equal(b.textContent, 'Alpha');
  assert.ok(s.hasAttribute('data-dd'));
});

test('picking an option sets select.value and fires exactly one change (and one input)', () => {
  const s = mkSelect([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
  let ch = 0, inp = 0; s.addEventListener('change', () => ch++); s.addEventListener('input', () => inp++);
  const b = btnOf(s);
  b.dispatchEvent(new Event('click'));
  assert.equal(list().hidden, false);
  assert.equal(b.getAttribute('aria-expanded'), 'true');
  assert.equal(rows().length, 3);
  clickRow(rows()[2]);
  assert.equal(s.value, 'c'); assert.equal(ch, 1); assert.equal(inp, 1);
  assert.equal(b.textContent, 'Gamma');
  assert.equal(list().hidden, true);
  // picking the already-selected value fires nothing, like a native select
  b.dispatchEvent(new Event('click')); clickRow(rows()[2]);
  assert.equal(ch, 1);
});

test('programmatic value / selectedIndex changes update the label', () => {
  const s = mkSelect([['a', 'Alpha'], ['b', 'Beta']]);
  const b = btnOf(s);
  s.value = 'b'; assert.equal(b.textContent, 'Beta');
  s.selectedIndex = 0; assert.equal(b.textContent, 'Alpha');
});

test('keyboard: ArrowDown opens, arrows move past disabled, Enter selects, Escape closes', () => {
  const s = mkSelect([['a', 'Alpha'], ['b', 'Beta', true], ['c', 'Gamma']]);
  let ch = 0; s.addEventListener('change', () => ch++);
  const b = btnOf(s);
  assert.equal(key(b, 'ArrowDown'), true);
  assert.equal(list().hidden, false);
  key(b, 'ArrowDown');
  assert.equal(b.getAttribute('aria-activedescendant'), rows()[2].id);
  key(b, 'Escape');
  assert.equal(list().hidden, true); assert.equal(s.value, 'a'); assert.equal(ch, 0);
  key(b, 'Enter'); key(b, 'End'); key(b, 'Enter');
  assert.equal(s.value, 'c'); assert.equal(ch, 1);
  key(b, 'Enter'); key(b, 'a'); assert.equal(b.getAttribute('aria-activedescendant'), rows()[0].id);
  closeList();
});

test('disabled select does not open; disabled option cannot be picked', () => {
  const s = mkSelect([['a', 'Alpha'], ['b', 'Beta', true]]);
  const b = btnOf(s);
  s.disabled = true; s.setAttribute('disabled', '');
  b.disabled = true; b.dispatchEvent(new Event('click'));
  assert.ok(!list() || list().hidden);
  b.disabled = false; s.disabled = false;
  b.dispatchEvent(new Event('click'));
  clickRow(rows()[1]);
  assert.equal(s.value, 'a'); closeList();
});

test('selects added later are enhanced (re-render path) and native opt-outs are skipped', () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const s = document.createElement('select'); host.appendChild(s);
  const o = document.createElement('option'); o.value = 'x'; o.textContent = 'Ex'; s.appendChild(o);
  enhanceAll(host);
  assert.equal(host.children[0].tagName, 'BUTTON'); assert.equal(host.children[0].textContent, 'Ex');
  const nat = document.createElement('select'); nat.setAttribute('data-native', ''); host.appendChild(nat);
  const mul = document.createElement('select'); mul.multiple = true; host.appendChild(mul);
  enhanceAll(host);
  assert.ok(!nat.hasAttribute('data-dd') && !mul.hasAttribute('data-dd'));
});

test('Escape and outside pointerdown close the list', () => {
  const s = mkSelect([['a', 'Alpha'], ['b', 'Beta']]);
  const b = btnOf(s);
  b.dispatchEvent(new Event('click')); assert.equal(list().hidden, false);
  { const e = new Event('pointerdown'); Object.defineProperty(e, 'target', { value: document.body }); document.dispatchEvent(e); }
  assert.equal(list().hidden, true);
  b.dispatchEvent(new Event('click')); key(b, 'Escape'); assert.equal(list().hidden, true);
});

console.log(`${n} dropdown tests passed`);
