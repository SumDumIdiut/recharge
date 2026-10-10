// Themed dropdown for every <select>. The native option list is drawn by GTK (cream background, unreadable with
// the app's light text), so each single <select> is hidden and shadowed by a button + our own list panel.
// The real <select> stays in the DOM and stays the source of truth: value, selectedIndex, 'input'/'change' events
// behave exactly as before. Opt out with data-native; <select multiple> is left alone.
//
// Syncing the button/list with the select:
//  - MutationObserver on the select: option rebuilds (childList/subtree), disabled/hidden/class/title/label/selected.
//  - the select's own value/selectedIndex are wrapped on the instance, so `sel.value = x` updates the label at once.
//  - 'change' events and every list open re-read the select (covers option.selected = true and the like).
//  - new selects anywhere in the document are enhanced by a MutationObserver on <body>.

const G = globalThis;
const enhanced = new WeakMap(); // select -> { btn, update }
let doc = null;
let list = null;        // the single shared list panel
let openFor = null;     // state of the currently open dropdown
let idSeq = 0;

export function isEnhanceable(sel) {
  return !!sel && sel.tagName === 'SELECT' && !sel.multiple && !(sel.hasAttribute && sel.hasAttribute('data-native')) && !enhanced.has(sel);
}

// ---- value / selectedIndex wrapping -------------------------------------------------------------------------
function findDescriptor(obj, key) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return d;
  }
  return null;
}
function wrap(sel, key, after) {
  const d = findDescriptor(sel, key);
  if (!d) return;
  let get, set;
  if (d.get || d.set) { get = () => d.get.call(sel); set = (v) => d.set.call(sel, v); }
  else { let store = d.value; get = () => store; set = (v) => { store = v; }; }
  try {
    Object.defineProperty(sel, key, { configurable: true, enumerable: true, get, set(v) { set(v); after(); } });
  } catch { /* keep native behaviour */ }
}

function selectedOption(sel) {
  const i = sel.selectedIndex;
  return i >= 0 && sel.options ? sel.options[i] : null;
}
const optText = (o) => (o.label || o.textContent || '').trim();

// ---- enhance one select -------------------------------------------------------------------------------------
export function enhance(sel) {
  if (!doc || !isEnhanceable(sel) || !sel.parentNode) return;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.setAttribute('role', 'combobox');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = doc.createElement('span');
  label.className = 'dd-label';
  btn.appendChild(label);
  sel.setAttribute('data-dd', '');
  sel.setAttribute('tabindex', '-1');
  sel.setAttribute('aria-hidden', 'true');
  sel.parentNode.insertBefore(btn, sel);

  const state = { sel, btn, label };
  const update = () => {
    const cls = ('dd-btn ' + (sel.className || '')).trim();
    if (btn.className !== cls) btn.className = cls;
    for (const a of ['title', 'aria-label']) {
      const v = sel.getAttribute(a);
      if (v == null) btn.removeAttribute(a); else if (btn.getAttribute(a) !== v) btn.setAttribute(a, v);
    }
    btn.disabled = !!sel.disabled;
    btn.hidden = !!sel.hidden || (sel.style && sel.style.display === 'none');
    const o = selectedOption(sel);
    const text = o ? optText(o) : '';
    if (label.textContent !== text) label.textContent = text;
    if (openFor && openFor.sel === sel) renderList();
  };
  state.update = update;
  enhanced.set(sel, state);
  update();

  wrap(sel, 'value', update);
  wrap(sel, 'selectedIndex', update);
  sel.addEventListener('change', update);
  sel.addEventListener('focus', () => { if (!btn.hidden && !btn.disabled) btn.focus(); });
  if (G.MutationObserver) {
    new G.MutationObserver(update).observe(sel, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['disabled', 'hidden', 'class', 'style', 'title', 'aria-label', 'label', 'selected', 'value'],
    });
  }

  btn.addEventListener('click', () => (openFor && openFor.sel === sel ? closeList() : openList(state)));
  btn.addEventListener('keydown', (e) => onKey(state, e));
  btn.addEventListener('blur', () => { if (openFor && openFor.sel === sel) closeList(); });
}

export function enhanceAll(root) {
  if (!root) return;
  if (root.tagName === 'SELECT') enhance(root);
  if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhance);
}

// ---- list ---------------------------------------------------------------------------------------------------
function ensureList() {
  if (list && list.isConnected !== false) return list;
  list = doc.createElement('div');
  list.className = 'dd-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  // keep focus on the button while clicking inside the list
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.dd-opt') : null;
    if (!row || !openFor || row.getAttribute('aria-disabled') === 'true') return;
    pick(openFor, Number(row.getAttribute('data-index')));
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.dd-opt') : null;
    if (row && openFor && row.getAttribute('aria-disabled') !== 'true') setActive(openFor, Number(row.getAttribute('data-index')), false);
  });
  doc.body.appendChild(list);
  return list;
}

function renderList() {
  const st = openFor;
  if (!st) return;
  const sel = st.sel;
  list.textContent = '';
  const cur = sel.selectedIndex;
  const add = (o) => {
    const row = doc.createElement('div');
    row.className = 'dd-opt' + (o.index === cur ? ' is-selected' : '') + (o.disabled ? ' is-disabled' : '');
    row.id = st.id + '-' + o.index;
    row.setAttribute('role', 'option');
    row.setAttribute('data-index', String(o.index));
    row.setAttribute('aria-selected', o.index === cur ? 'true' : 'false');
    if (o.disabled) row.setAttribute('aria-disabled', 'true');
    row.textContent = optText(o);
    list.appendChild(row);
  };
  for (const child of Array.from(sel.children || [])) {
    if (child.tagName === 'OPTGROUP') {
      const h = doc.createElement('div');
      h.className = 'dd-group';
      h.setAttribute('role', 'presentation');
      h.textContent = child.label || '';
      list.appendChild(h);
      for (const o of Array.from(child.children)) if (o.tagName === 'OPTION') add(o);
    } else if (child.tagName === 'OPTION') add(child);
  }
  if (st.active == null || st.active >= sel.options.length) st.active = cur >= 0 ? cur : firstEnabled(sel, 0, 1);
  markActive(st, true);
}

function firstEnabled(sel, from, dir) {
  const n = sel.options.length;
  for (let i = from; i >= 0 && i < n; i += dir) if (!sel.options[i].disabled) return i;
  return -1;
}
function step(sel, from, dir) {
  const i = firstEnabled(sel, from + dir, dir);
  return i < 0 ? from : i;
}

function markActive(st, scroll) {
  let activeRow = null;
  for (const row of Array.from(list.querySelectorAll('.dd-opt'))) {
    const on = Number(row.getAttribute('data-index')) === st.active;
    row.classList.toggle('is-active', on);
    if (on) activeRow = row;
  }
  if (activeRow) {
    st.btn.setAttribute('aria-activedescendant', activeRow.id);
    if (scroll && activeRow.scrollIntoView) activeRow.scrollIntoView({ block: 'nearest' });
  } else st.btn.removeAttribute('aria-activedescendant');
}
function setActive(st, i, scroll = true) {
  if (i < 0 || i === st.active) return;
  st.active = i;
  markActive(st, scroll);
}

function position(st) {
  const r = st.btn.getBoundingClientRect();
  const vw = G.innerWidth || 1024, vh = G.innerHeight || 768, m = 8;
  list.style.minWidth = Math.round(r.width) + 'px';
  list.style.maxWidth = Math.max(120, vw - 2 * m) + 'px';
  list.style.maxHeight = '';
  const natural = Math.min(list.scrollHeight || 0, 320);
  const below = vh - r.bottom - m, above = r.top - m;
  const up = natural > below && above > below;
  const maxH = Math.max(80, Math.min(320, up ? above : below));
  list.style.maxHeight = maxH + 'px';
  const h = Math.min(natural || maxH, maxH);
  list.style.top = Math.round(up ? r.top - 2 - h : r.bottom + 2) + 'px';
  const w = list.offsetWidth || r.width;
  list.style.left = Math.round(Math.max(m, Math.min(r.left, vw - w - m))) + 'px';
  list.classList.toggle('is-up', up);
}

function openList(st) {
  if (st.btn.disabled) return;
  if (openFor) closeList();
  ensureList();
  openFor = { sel: st.sel, btn: st.btn, id: 'dd' + (++idSeq), active: null, buf: '', bufT: 0 };
  list.hidden = false;
  st.btn.setAttribute('aria-expanded', 'true');
  st.btn.setAttribute('aria-controls', openFor.id + '-list');
  list.id = openFor.id + '-list';
  st.update();           // re-read the select (also renders the list)
  renderList();
  position(openFor);
  const a = list.querySelector('.is-active');
  if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
}

export function closeList() {
  if (!openFor) return;
  const { btn } = openFor;
  openFor = null;
  if (list) { list.hidden = true; list.textContent = ''; }
  btn.setAttribute('aria-expanded', 'false');
  btn.removeAttribute('aria-activedescendant');
  btn.removeAttribute('aria-controls');
}

function pick(st, i) {
  const sel = st.sel;
  const o = sel.options[i];
  if (!o || o.disabled) return;
  const changed = sel.selectedIndex !== i;
  sel.selectedIndex = i;
  closeList();
  if (changed) {
    const mk = (t) => { const ev = new G.Event(t, { bubbles: true }); return ev; };
    sel.dispatchEvent(mk('input'));
    sel.dispatchEvent(mk('change'));
  }
}

function onKey(state, e) {
  const { sel } = state;
  const isOpen = openFor && openFor.sel === sel;
  const k = e.key;
  if (!isOpen) {
    if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); openList(state); }
    return;
  }
  const st = openFor;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === 'Escape') { stop(); closeList(); }
  else if (k === 'Tab') closeList();
  else if (k === 'ArrowDown') { stop(); setActive(st, step(sel, st.active ?? -1, 1)); }
  else if (k === 'ArrowUp') { stop(); setActive(st, step(sel, st.active ?? sel.options.length, -1)); }
  else if (k === 'Home') { stop(); setActive(st, firstEnabled(sel, 0, 1)); }
  else if (k === 'End') { stop(); setActive(st, firstEnabled(sel, sel.options.length - 1, -1)); }
  else if (k === 'Enter' || k === ' ') { stop(); if (st.active != null) pick(st, st.active); else closeList(); }
  else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    stop();
    G.clearTimeout(st.bufT);
    st.buf += k.toLowerCase();
    st.bufT = G.setTimeout(() => { st.buf = ''; }, 600);
    const n = sel.options.length;
    const start = st.buf.length > 1 ? st.active : (st.active ?? -1) + 1;
    for (let j = 0; j < n; j++) {
      const i = (start + j + n) % n;
      const o = sel.options[i];
      if (!o.disabled && optText(o).toLowerCase().startsWith(st.buf)) { setActive(st, i); break; }
    }
  }
}

// ---- boot ---------------------------------------------------------------------------------------------------
export function init(d = G.document) {
  doc = d;
  const closeIfOutside = (e) => {
    if (!openFor) return;
    const t = e.target;
    if (list && list.contains && list.contains(t)) return;
    if (openFor.btn.contains && openFor.btn.contains(t)) return;
    closeList();
  };
  doc.addEventListener('pointerdown', closeIfOutside, true);
  doc.addEventListener('mousedown', closeIfOutside, true);
  if (G.addEventListener) {
    G.addEventListener('resize', closeList);
    G.addEventListener('blur', closeList);
    G.addEventListener('scroll', (e) => { if (openFor && !(list && list.contains && list.contains(e.target))) closeList(); }, true);
    G.addEventListener('wheel', (e) => { if (openFor && !(list && list.contains && list.contains(e.target))) closeList(); }, { capture: true, passive: true });
  }
  const scan = () => enhanceAll(doc.body);
  scan();
  if (G.MutationObserver) {
    new G.MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of Array.from(m.addedNodes)) if (n.nodeType === 1) enhanceAll(n);
        for (const n of Array.from(m.removedNodes)) if (openFor && n.nodeType === 1 && (n === openFor.sel || (n.contains && n.contains(openFor.sel)))) closeList();
      }
    }).observe(doc.body, { childList: true, subtree: true });
  }
}

if (G.document && G.document.body) init();
else if (G.document) G.document.addEventListener('DOMContentLoaded', () => init(), { once: true });
