// Notebook: the Recharge and IGTAP vaults, read from the hub (/api/notebook) and rendered here by ./lib.js.
import { HUB_BASE } from '../hub.js';
import { openExternal } from '../social/text.js';
import { renderMarkdown, propsHtml, createResolver, buildTree, searchNotes, repairMermaid, escapeHtml, formatBytes } from './lib.js';

const API = HUB_BASE + '/api/notebook';
const CACHE_NAME = 'recharge-notebook-v1';
const LAST_KEY = 'rechargeNotebookLast'; // { vault, notes: { <vaultId>: <path> } }
const VAULTS_KEY = 'rechargeNotebookVaults';

const mem = new Map(); // cache key -> text/json, for this session
let el = {};
let vaults = [];
let st = null; // the open vault: { meta, index, resolver, tree, byPath }
let cur = { vault: '', path: '' };
let hist = [], pos = -1;
let loadSeq = 0;
let searchTimer = 0;
let query = '';
let mermaidState = null;

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

// ---- fetching and caching (memory, then the Cache API, keyed by the vault version) ----
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
async function cacheOpen() { try { return await caches.open(CACHE_NAME); } catch { return null; } }

async function getCached(url, version, kind) {
  const key = version ? `${url}?v=${encodeURIComponent(version)}` : url;
  if (mem.has(key)) return mem.get(key);
  const c = version ? await cacheOpen() : null;
  let res = null;
  try { res = c ? await c.match(key) : null; } catch { res = null; }
  let data;
  if (res) {
    data = kind === 'json' ? await res.json() : await res.text();
  } else {
    const net = await fetch(key, { cache: version ? 'default' : 'no-cache' });
    if (!net.ok) throw new Error('HTTP ' + net.status);
    if (c) { try { await c.put(key, net.clone()); } catch { /* quota */ } }
    data = kind === 'json' ? await net.json() : await net.text();
  }
  mem.set(key, data);
  return data;
}

async function dropOldVersions(id, version) {
  const c = await cacheOpen();
  if (!c) return;
  try {
    for (const req of await c.keys()) {
      const u = new URL(req.url);
      if (req.url.startsWith(`${API}/${id}/`) && u.searchParams.get('v') !== version) await c.delete(req);
    }
  } catch { /* best effort */ }
}

async function loadVaultList() {
  try {
    const r = await fetch(API, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j.vaults) || !j.vaults.length) throw new Error('no vaults');
    lsSet(VAULTS_KEY, j.vaults);
    return j.vaults;
  } catch (e) {
    const saved = lsGet(VAULTS_KEY);
    if (Array.isArray(saved) && saved.length) return saved; // offline: the index may still be cached
    throw e;
  }
}

async function openVault(id) {
  const meta = vaults.find((v) => v.id === id) || vaults[0];
  const index = await getCached(`${API}/${meta.id}/index.json`, meta.version, 'json');
  const resolver = createResolver(index, `${API}/${meta.id}/`);
  const byPath = new Map(index.notes.map((n) => [n.path, n]));
  st = { meta, index, resolver, byPath, tree: buildTree(index.notes, index.home), open: new Set() };
  dropOldVersions(meta.id, meta.version);
  return st;
}

// ---- screens ----
function showState(html) { el.article.innerHTML = `<div class="nb-state">${html}</div>`; el.backlinks.hidden = true; }

function errorState(e, retry) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  showState(`<div>${offline ? 'You are offline.' : 'The notebook could not be reached.'}</div><div class="nb-dl-meta">${escapeHtml(e?.message || '')}</div><button class="btn" type="button" id="nb-retry">Try again</button>`);
  document.getElementById('nb-retry')?.addEventListener('click', retry);
}

function renderVaultSwitcher() {
  el.vaults.innerHTML = vaults.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.title)}</option>`).join('');
  if (st) el.vaults.value = st.meta.id;
}

function renderDownload() {
  const m = st?.meta;
  el.download.hidden = !m || !m.zip;
  if (m && m.zip) {
    el.download.textContent = `Download .zip (${formatBytes(m.zipBytes)})`;
    el.download.title = `${m.title} vault for Obsidian - ${m.notes} notes, built ${String(m.builtAt || '').slice(0, 10)}`;
  }
}

function leafBtn(n) {
  const home = n.title === st.index.home;
  return `<button class="nb-leaf${home ? ' home' : ''}${n.path === cur.path ? ' active' : ''}" type="button" data-note="${escapeHtml(n.path)}" title="${escapeHtml(n.path)}">${escapeHtml(n.title)}</button>`;
}
function folderHtml(f) {
  const open = st.open.has(f.path);
  return `<details class="nb-folder" data-folder="${escapeHtml(f.path)}"${open ? ' open' : ''}><summary>${escapeHtml(f.name)}</summary><div class="nb-folder-body">${f.folders.map(folderHtml).join('')}${f.notes.map(leafBtn).join('')}</div></details>`;
}
function renderTree() {
  if (query.trim()) { renderResults(); return; }
  const t = st.tree;
  el.tree.innerHTML = t.notes.map(leafBtn).join('') + t.folders.map(folderHtml).join('');
}
function openAncestors(path) {
  const parts = path.split('/'); parts.pop();
  let acc = '';
  for (const p of parts) { acc = acc ? acc + '/' + p : p; st.open.add(acc); }
}

function renderResults() {
  const res = searchNotes(st.index.notes, query, 60);
  if (!res.length) { el.tree.innerHTML = '<div class="nb-count">No matches.</div>'; return; }
  el.tree.innerHTML = `<div class="nb-count">${res.length}${res.length === 60 ? '+' : ''} result${res.length === 1 ? '' : 's'}</div>` + res.map((r) =>
    `<button class="nb-hit${r.note.path === cur.path ? ' active' : ''}" type="button" data-note="${escapeHtml(r.note.path)}"${r.headHit >= 0 && !r.titleHit ? ` data-anchor="${escapeHtml(r.note.headings[r.headHit].slug)}"` : ''}>`
    + `<span class="nb-hit-title">${r.titleHtml}</span>${r.note.folder ? `<span class="nb-hit-folder">${escapeHtml(r.note.folder)}</span>` : ''}<span class="nb-hit-snip">${r.snippetHtml}</span></button>`).join('');
}

function syncNav() {
  el.back.disabled = pos <= 0;
  el.fwd.disabled = pos >= hist.length - 1;
}

function remember() {
  const last = lsGet(LAST_KEY) || { vault: '', notes: {} };
  last.vault = cur.vault;
  last.notes = last.notes || {};
  last.notes[cur.vault] = cur.path;
  lsSet(LAST_KEY, last);
}

// ---- opening a note ----
async function showNote(vault, path, anchor, { push = true } = {}) {
  const seq = ++loadSeq;
  try {
    if (!st || st.meta.id !== vault) {
      await openVault(vault);
      if (seq !== loadSeq) return;
      renderVaultSwitcher(); renderDownload();
    }
    const note = st.byPath.get(path) || st.byPath.get(st.resolver.note(st.index.home));
    if (!note) { showState('This vault has no notes.'); return; }
    const md = await getCached(`${API}/${st.meta.id}/notes/${encPath(note.path)}`, st.meta.version, 'text');
    if (seq !== loadSeq) return;
    cur = { vault: st.meta.id, path: note.path };
    if (push) {
      const top = hist[pos];
      if (!top || top.vault !== cur.vault || top.path !== cur.path || top.anchor !== (anchor || '')) {
        hist = hist.slice(0, pos + 1); hist.push({ vault: cur.vault, path: cur.path, anchor: anchor || '' }); pos = hist.length - 1;
      }
    }
    remember(); syncNav();
    const r = renderMarkdown(md, { resolver: st.resolver });
    el.article.innerHTML = propsHtml(r.props) + r.html;
    renderBacklinks(note);
    openAncestors(note.path);
    if (query.trim()) renderResults(); else renderTree();
    el.tree.querySelector('.nb-leaf.active')?.scrollIntoView({ block: 'nearest' });
    scrollToAnchor(anchor);
    el.root.classList.remove('side-open');
    queueDiagrams();
  } catch (e) {
    if (seq !== loadSeq) return;
    errorState(e, () => showNote(vault, path, anchor, { push: false }));
  }
}

function renderBacklinks(note) {
  const items = (note.backlinks || []).map((t) => ({ t, path: st.resolver.note(t) })).filter((x) => x.path);
  el.backlinks.hidden = !items.length;
  if (!items.length) return;
  el.backlinks.innerHTML = `<h3>Linked from (${items.length})</h3><div class="nb-bl-list">${items.map((x) => `<button class="chip nb-bl" type="button" data-note="${escapeHtml(x.path)}">${escapeHtml(x.t)}</button>`).join('')}</div>`;
}

function scrollToAnchor(anchor) {
  if (!anchor) { el.scroll.scrollTop = 0; return; }
  const h = [...el.article.querySelectorAll('[data-slug]')].find((x) => x.dataset.slug === anchor) || el.article.querySelector(`[id="nb-${CSS.escape(anchor)}"]`);
  if (h) h.scrollIntoView({ block: 'start' });
  else el.scroll.scrollTop = 0;
}

function goHistory(delta) {
  const p = pos + delta;
  if (p < 0 || p >= hist.length) return;
  pos = p;
  const h = hist[pos];
  showNote(h.vault, h.path, h.anchor, { push: false });
}

// ---- mermaid (vendored, loaded the first time a note has a diagram) ----
function loadMermaid() {
  if (mermaidState) return mermaidState;
  mermaidState = new Promise((resolve, reject) => {
    if (window.mermaid) { resolve(window.mermaid); return; }
    const s = document.createElement('script');
    s.src = '/vendor/mermaid/mermaid.min.js';
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid missing')));
    s.onerror = () => reject(new Error('mermaid failed to load'));
    document.head.appendChild(s);
  }).then((m) => { initMermaid(m); return m; });
  mermaidState.catch(() => { mermaidState = null; });
  return mermaidState;
}

function initMermaid(m) {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
  const text = v('--text', '#f9ffe4'), green = v('--green', '#41f88d'), magenta = v('--magenta', '#c63ed8');
  const panel = v('--panel', '#1c1c1c'), bg = v('--bg', '#141414');
  const font = getComputedStyle(document.body).fontFamily || 'VT323';
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: font || 'VT323, monospace',
    themeVariables: {
      background: bg, darkMode: true, fontFamily: font || 'VT323, monospace', fontSize: '17px',
      primaryColor: panel, primaryTextColor: text, primaryBorderColor: green,
      secondaryColor: bg, secondaryTextColor: text, secondaryBorderColor: magenta,
      tertiaryColor: bg, tertiaryTextColor: text, tertiaryBorderColor: green,
      lineColor: green, textColor: text, mainBkg: panel, nodeBorder: green, nodeTextColor: text,
      clusterBkg: bg, clusterBorder: magenta, edgeLabelBackground: bg, titleColor: text,
      noteBkgColor: panel, noteTextColor: text, noteBorderColor: magenta,
      actorBkg: panel, actorBorder: green, actorTextColor: text, actorLineColor: green, signalColor: text, signalTextColor: text,
      labelBoxBkgColor: panel, labelBoxBorderColor: magenta, labelTextColor: text, loopTextColor: text,
      activationBkgColor: bg, activationBorderColor: green, sequenceNumberColor: bg,
      pie1: green, pie2: magenta, pie3: text, pie4: panel,
    },
  });
}

let diagramObserver = null;
let renderChain = Promise.resolve();
let mmCounter = 0;
function queueDiagrams() {
  diagramObserver?.disconnect();
  const boxes = el.article.querySelectorAll('.nb-mermaid');
  if (!boxes.length) return;
  loadMermaid().catch(() => {});
  diagramObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      diagramObserver.unobserve(e.target);
      renderChain = renderChain.then(() => renderDiagram(e.target)).catch(() => {});
    }
  }, { root: el.scroll, rootMargin: '400px 0px' });
  boxes.forEach((b) => { b.dataset.state = 'idle'; diagramObserver.observe(b); });
}

async function renderDiagram(box) {
  if (!box.isConnected || box.dataset.state === 'done') return;
  const pre = box.querySelector('.nb-mermaid-src');
  const src = pre ? pre.textContent : '';
  box.dataset.state = 'busy';
  const id = 'nbm' + (++mmCounter);
  try {
    const m = await loadMermaid();
    let svg;
    try { ({ svg } = await m.render(id, src)); } catch (first) {
      document.getElementById('d' + id)?.remove(); document.getElementById(id)?.remove();
      ({ svg } = await m.render(id + 'r', repairMermaid(src))); // some sources trip on ';' or escaped quotes
    }
    if (!box.isConnected) return;
    box.innerHTML = svg;
    box.dataset.state = 'done';
  } catch (e) {
    document.getElementById('d' + id)?.remove(); document.getElementById(id)?.remove();
    if (!box.isConnected) return;
    box.dataset.state = 'error';
    box.innerHTML = '<div class="nb-mermaid-note">This diagram could not be drawn - showing its source.</div>';
    const p = document.createElement('pre'); p.className = 'nb-mermaid-src'; p.textContent = src; box.appendChild(p);
  }
}

// ---- full-screen diagram viewer ----
let fs = null;
function closeFullscreen() {
  if (!fs) return;
  const { overlay, off } = fs; fs = null; off(); overlay.remove();
}
function openFullscreen(box) {
  const src = box.querySelector('svg');
  if (!src) return;
  closeFullscreen();
  const svg = src.cloneNode(true);
  const vb = src.viewBox && src.viewBox.baseVal;
  const r = src.getBoundingClientRect();
  const w = (vb && vb.width) || r.width || 800, h = (vb && vb.height) || r.height || 600;
  svg.removeAttribute('style'); svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const overlay = document.createElement('div'); overlay.className = 'nb-fs-overlay';
  const stage = document.createElement('div'); stage.className = 'nb-fs-stage'; stage.appendChild(svg);
  const close = document.createElement('button'); close.className = 'btn nb-fs-close'; close.type = 'button'; close.textContent = 'Close';
  const hint = document.createElement('div'); hint.className = 'nb-fs-hint'; hint.textContent = 'Scroll to zoom \u00b7 drag to pan \u00b7 double-click to fit \u00b7 Esc to close';
  overlay.append(stage, close, hint);
  document.body.appendChild(overlay);
  let fit = 1, k = 1, x = 0, y = 0, drag = null, moved = false;
  const apply = () => { stage.style.transform = `translate(${x}px, ${y}px) scale(${fit * k})`; };
  const reset = () => {
    const M = 48, W = innerWidth - 2 * M, H = innerHeight - 2 * M;
    fit = Math.max(0.01, Math.min(W / w, H / h)); k = 1;
    x = (innerWidth - w * fit) / 2; y = (innerHeight - h * fit) / 2; apply();
  };
  reset();
  const onWheel = (e) => {
    e.preventDefault();
    const nk = Math.min(8, Math.max(0.5, k * Math.exp(-e.deltaY * 0.0015)));
    const f = nk / k;
    x = e.clientX - (e.clientX - x) * f; y = e.clientY - (e.clientY - y) * f; k = nk; apply();
  };
  const onDown = (e) => { if (e.button !== 0 || e.target === close) return; drag = { sx: e.clientX, sy: e.clientY, x, y }; moved = false; };
  const onMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!moved && Math.hypot(dx, dy) > 4) { moved = true; overlay.classList.add('nb-fs-drag'); }
    if (moved) { x = drag.x + dx; y = drag.y + dy; apply(); }
  };
  const onUp = () => { drag = null; overlay.classList.remove('nb-fs-drag'); };
  const onClick = (e) => { if (e.target === overlay && !moved) closeFullscreen(); moved = false; };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFullscreen(); } };
  const onClose = () => closeFullscreen();
  overlay.addEventListener('wheel', onWheel, { passive: false });
  overlay.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  overlay.addEventListener('click', onClick);
  overlay.addEventListener('dblclick', reset);
  addEventListener('keydown', onKey, true);
  addEventListener('resize', reset);
  close.addEventListener('click', onClose);
  fs = { overlay, off() {
    overlay.removeEventListener('wheel', onWheel); overlay.removeEventListener('pointerdown', onDown);
    removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
    overlay.removeEventListener('click', onClick); overlay.removeEventListener('dblclick', reset);
    removeEventListener('keydown', onKey, true); removeEventListener('resize', reset); close.removeEventListener('click', onClose);
  } };
}

// ---- events ----
function onArticleClick(e) {
  const mm = e.target.closest('.nb-mermaid[data-state="done"]');
  if (mm && !e.target.closest('a')) { openFullscreen(mm); return; }
  const a = e.target.closest('a');
  if (a) {
    if (a.dataset.extUrl) { e.preventDefault(); openUrl(a.dataset.extUrl); return; }
    if (a.dataset.note) { e.preventDefault(); showNote(cur.vault, a.dataset.note, a.dataset.anchor || ''); return; }
    if (a.dataset.anchor !== undefined) {
      e.preventDefault();
      const top = hist[pos];
      if (top) { top.scroll = el.scroll.scrollTop; }
      scrollToAnchor(a.dataset.anchor);
      return;
    }
    if (a.dataset.fn) { e.preventDefault(); document.getElementById('nb-fn-' + a.dataset.fn)?.scrollIntoView({ block: 'center' }); return; }
    if (a.dataset.fnback) { e.preventDefault(); el.article.querySelector(`[data-fn="${CSS.escape(a.dataset.fnback)}"]`)?.scrollIntoView({ block: 'center' }); return; }
    e.preventDefault();
  }
}

async function openUrl(url) {
  if (!(await openExternal(url))) { try { window.open(url, '_blank', 'noopener'); } catch { /* ignore */ } }
}

function onTreeClick(e) {
  const b = e.target.closest('[data-note]');
  if (!b) return;
  showNote(cur.vault, b.dataset.note, b.dataset.anchor || '');
}

function onTreeToggle(e) {
  const d = e.target.closest('details.nb-folder');
  if (!d || e.target !== d) return;
  if (d.open) st.open.add(d.dataset.folder); else st.open.delete(d.dataset.folder);
}

async function switchVault(id) {
  if (st && st.meta.id === id) return;
  query = ''; el.search.value = '';
  const last = lsGet(LAST_KEY);
  const path = last?.notes?.[id] || '';
  loadSeq++;
  try {
    await openVault(id);
    renderVaultSwitcher(); renderDownload();
    const home = st.resolver.note(st.index.home);
    await showNote(id, st.byPath.has(path) ? path : home, '');
  } catch (e) { errorState(e, () => switchVault(id)); }
}

function wire() {
  el.vaults.addEventListener('change', () => { if (el.vaults.value && el.vaults.value !== cur.vault) switchVault(el.vaults.value); });
  el.back.addEventListener('click', () => goHistory(-1));
  el.fwd.addEventListener('click', () => goHistory(1));
  el.sideToggle.addEventListener('click', () => el.root.classList.toggle('side-open'));
  el.download.addEventListener('click', () => { if (st?.meta.zip) openUrl(`${API}/${st.meta.zip}`); });
  el.article.addEventListener('click', onArticleClick);
  el.backlinks.addEventListener('click', onTreeClick);
  el.tree.addEventListener('click', onTreeClick);
  el.tree.addEventListener('toggle', onTreeToggle, true);
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = el.search.value; if (st) renderTree(); }, 120);
  });
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { el.search.value = ''; query = ''; renderTree(); }
    if (e.key === 'Enter') el.tree.querySelector('.nb-hit')?.click();
  });
  el.root.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goHistory(-1); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goHistory(1); }
  });
}

async function start() {
  showState('Loading...');
  try {
    vaults = await loadVaultList();
  } catch (e) { errorState(e, start); return; }
  const last = lsGet(LAST_KEY);
  const id = vaults.some((v) => v.id === last?.vault) ? last.vault : vaults[0].id;
  st = null; renderVaultSwitcher();
  try {
    await openVault(id);
    renderVaultSwitcher(); renderDownload();
    const path = last?.notes?.[id];
    await showNote(id, st.byPath.has(path) ? path : st.resolver.note(st.index.home), '');
  } catch (e) { errorState(e, start); }
}

export async function init() {
  const q = (id) => document.getElementById(id);
  el = {
    root: q('nb-root'), vaults: q('nb-vaults'), back: q('nb-back'), fwd: q('nb-fwd'), sideToggle: q('nb-side-toggle'), download: q('nb-download'),
    search: q('nb-search'), tree: q('nb-tree'), article: q('nb-article'), backlinks: q('nb-backlinks'), scroll: q('nb-scroll'),
  };
  wire();
  await start();
}

// Coming back to the tab: keep where we were, but pick up a newer published version if there is one.
export async function onShow() {
  if (!st) return start();
  try {
    const fresh = await loadVaultList();
    const m = fresh.find((v) => v.id === st.meta.id);
    vaults = fresh;
    if (m && m.version !== st.meta.version) {
      const path = cur.path;
      st = null; renderVaultSwitcher();
      await openVault(m.id); renderVaultSwitcher(); renderDownload();
      await showNote(m.id, path, '', { push: false });
    }
  } catch { /* stay on what is open */ }
}
