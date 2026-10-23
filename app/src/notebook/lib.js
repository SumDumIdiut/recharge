// Notebook: a pure Markdown (Obsidian flavoured) -> HTML renderer plus the index helpers (tree, resolver, search).
// No DOM needed, so `node --test` covers it. Nothing from a note reaches the output unescaped: every piece of text goes
// through escapeHtml, and the only tags emitted are the ones written in this file.

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Same function as the publisher's (publish-notebook.mjs), so heading links agree with index.json.
export const slug = (t) => String(t ?? '').trim().toLowerCase().replace(/ /g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');

// ---------------------------------------------------------------- frontmatter
export function parseFrontmatter(md) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { props: [], body: md };
  const props = [];
  let cur = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const li = /^\s+-\s+(.*)$/.exec(raw);
    if (li && cur) { cur[1].push(unquote(li[1])); continue; }
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    let v = kv[2].trim();
    const vals = [];
    if (/^\[.*\]$/.test(v)) v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean).forEach((x) => vals.push(x));
    else if (v) vals.push(unquote(v));
    cur = [kv[1].trim(), vals];
    props.push(cur);
  }
  return { props: props.filter(([, v]) => v.length), body: md.slice(m[0].length) };
}
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');

// ---------------------------------------------------------------- callouts
const CALLOUT_ALIAS = {
  summary: 'abstract', tldr: 'abstract', hint: 'tip', check: 'success', done: 'success', help: 'question', faq: 'question',
  caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure', error: 'danger', cite: 'quote',
};
export const CALLOUT_TYPES = ['note', 'abstract', 'info', 'tip', 'success', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote', 'important', 'todo'];
export const calloutType = (t) => { t = String(t).toLowerCase(); t = CALLOUT_ALIAS[t] || t; return CALLOUT_TYPES.includes(t) ? t : 'note'; };

const S = (d) => `<svg class="nb-ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">${d}</svg>`;
export const CALLOUT_ICONS = {
  note: S('<path d="M3 13l1-4 7-7 3 3-7 7z"/>'),
  abstract: S('<rect x="3" y="2" width="10" height="12"/><path d="M5.5 6h5M5.5 9h5"/>'),
  info: S('<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.6v.4"/>'),
  tip: S('<path d="M8 2l1.8 4 4.2.4-3.2 2.8 1 4.2L8 11.2 4.2 13.4l1-4.2L2 6.4 6.2 6z"/>'),
  success: S('<circle cx="8" cy="8" r="6"/><path d="M5 8.2l2.2 2.2L11 6"/>'),
  question: S('<circle cx="8" cy="8" r="6"/><path d="M6.4 6.4a1.7 1.7 0 013.2.6c0 1.2-1.6 1.4-1.6 2.6M8 11.2v.4"/>'),
  warning: S('<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3.2M8 11.4v.4"/>'),
  failure: S('<circle cx="8" cy="8" r="6"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/>'),
  danger: S('<path d="M9 1.8L3.6 9H8l-1 5.2L12.4 7H8z"/>'),
  bug: S('<rect x="5" y="5" width="6" height="8"/><path d="M5 8H2.5M11 8h2.5M5 11H3M11 11h2M6.5 5L5.5 3M9.5 5l1-2"/>'),
  example: S('<path d="M3 4h10M3 8h10M3 12h6"/>'),
  quote: S('<path d="M3 12V8.4c0-2.4 1.2-3.8 3-4.2M9 12V8.4c0-2.4 1.2-3.8 3-4.2"/><path d="M3 8.4h3V12H3zM9 8.4h3V12H9z"/>'),
  important: S('<circle cx="8" cy="8" r="6"/><path d="M8 4.6v4.2M8 10.8v.6"/>'),
  todo: S('<rect x="2.5" y="2.5" width="11" height="11"/><path d="M5.2 8.2l2 2L11 6"/>'),
};

// ---------------------------------------------------------------- index helpers
const baseName = (p) => String(p).replace(/^.*\//, '').replace(/\.md$/i, '');
const noExt = (p) => String(p).replace(/\.md$/i, '');

// Resolves [[targets]] and relative .md links to a note path, and ![[embeds]] to an asset URL.
export function createResolver(index, assetBase = '') {
  const byKey = new Map();
  const add = (k, p) => { k = String(k).toLowerCase(); if (!byKey.has(k)) byKey.set(k, p); };
  for (const n of index.notes) add(noExt(n.path), n.path);
  for (const n of index.notes) add(baseName(n.path), n.path);
  for (const n of index.notes) add(n.title, n.path);
  const assets = index.assets || {};
  const assetKeys = new Map(Object.keys(assets).map((k) => [k.toLowerCase(), k]));
  return {
    note(target) {
      let t = String(target || '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
      try { t = decodeURIComponent(t); } catch { /* keep raw */ }
      if (!t) return null;
      return byKey.get(noExt(t).toLowerCase()) || byKey.get(baseName(t).toLowerCase()) || null;
    },
    asset(name) {
      const base = String(name || '').trim().replace(/^.*[\\/]/, '');
      const k = assets[base] ? base : assetKeys.get(base.toLowerCase());
      return k ? assetBase + assets[k] : null;
    },
    hasNotes: index.notes.length,
  };
}

// Folder tree for the sidebar: { name, path, folders: [...], notes: [...] }; the home note first, the rest by title.
export function buildTree(notes, home) {
  const root = { name: '', path: '', folders: new Map(), notes: [] };
  for (const n of notes) {
    let node = root;
    const parts = n.path.split('/');
    parts.pop();
    let acc = '';
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    node.notes.push(n);
  }
  const fin = (node) => {
    node.notes.sort((a, b) => (b.title === home) - (a.title === home) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    node.folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    node.folders.forEach(fin);
    return node;
  };
  return fin(root);
}

// ---------------------------------------------------------------- search
const lowerCache = new WeakMap();
const lowered = (n) => {
  let l = lowerCache.get(n);
  if (!l) {
    l = { title: n.title.toLowerCase(), heads: (n.headings || []).map((h) => h.text.toLowerCase()), text: String(n.text || '').toLowerCase() };
    lowerCache.set(n, l);
  }
  return l;
};

export function searchNotes(notes, query, limit = 50) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const n of notes) {
    const l = lowered(n);
    let score = 0, ok = true, headHit = -1, textHit = -1, titleHit = false;
    for (const t of terms) {
      let s = 0;
      if (l.title === t) s = 300;
      else if (l.title.startsWith(t)) s = 200;
      else if (l.title.includes(t)) { s = 150; }
      if (s) titleHit = true;
      if (!s) {
        const hi = l.heads.findIndex((h) => h.includes(t));
        if (hi >= 0) { s = 40; if (headHit < 0) headHit = hi; }
      }
      const ti = l.text.indexOf(t);
      if (ti >= 0) {
        if (textHit < 0) textHit = ti;
        let c = 0, p = ti;
        while (p >= 0 && c < 20) { c++; p = l.text.indexOf(t, p + t.length); }
        s += Math.min(c, 20);
      }
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    out.push({ note: n, score, titleHit, headHit, textHit, terms });
  }
  out.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title));
  return out.slice(0, limit).map((r) => ({ ...r, titleHtml: highlightHtml(r.note.title, terms), snippetHtml: snippetFor(r) }));
}

export function highlightHtml(text, terms) {
  const s = String(text ?? '');
  const ts = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ts.length) return escapeHtml(s);
  const re = new RegExp(ts.join('|'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += escapeHtml(s.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

function snippetFor(r) {
  const n = r.note;
  if (r.headHit >= 0 && !(r.textHit >= 0 && r.titleHit)) {
    const h = n.headings[r.headHit];
    return '<span class="nb-snip-head"># ' + highlightHtml(h.text, r.terms) + '</span>' + (r.textHit >= 0 ? ' ' + textSnippet(n.text, r.textHit, r.terms) : '');
  }
  if (r.textHit >= 0) return textSnippet(n.text, r.textHit, r.terms);
  return escapeHtml(String(n.text || '').slice(0, 110));
}
function textSnippet(text, at, terms) {
  const t = String(text || '');
  const from = Math.max(0, at - 50);
  const to = Math.min(t.length, at + 110);
  return (from > 0 ? '… ' : '') + highlightHtml(t.slice(from, to).replace(/\s+/g, ' '), terms) + (to < t.length ? ' …' : '');
}

// ---------------------------------------------------------------- code highlighting
const KW = {
  csharp: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield async await get set value record init when where',
  js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  json: 'true false null',
};
const LANG = { cs: 'csharp', 'c#': 'csharp', csharp: 'csharp', js: 'js', javascript: 'js', mjs: 'js', ts: 'js', typescript: 'js', rust: 'rust', rs: 'rust', json: 'json', jsonc: 'json' };
const KWSET = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v.split(' '))]));
const TOKEN = {
  csharp: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(@?"(?:\\.|""|[^"\\\n])*"|'(?:\\.|[^'\\\n])+')|(\b0x[\da-fA-F]+\b|\b\d[\d_]*\.?\d*(?:[fFdDmMuUlL]{0,2})\b)|([A-Za-z_]\w*)/g,
  js: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b0x[\da-fA-F]+\b|\b\d[\d_]*\.?\d*\b)|([A-Za-z_$][\w$]*)/g,
  rust: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.[^']*|[^'\\\n])')|(\b0x[\da-fA-F]+\b|\b\d[\d_]*\.?\d*(?:[iuf]\d+|usize|isize)?\b)|([A-Za-z_]\w*)/g,
  json: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*")|(-?\b\d[\d.eE+-]*\b)|([A-Za-z_]\w*)/g,
};

export function highlightCode(code, lang) {
  const L = LANG[String(lang || '').toLowerCase()];
  if (!L) return escapeHtml(code);
  const re = new RegExp(TOKEN[L].source, 'g');
  const kw = KWSET[L];
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    last = m.index + m[0].length;
    let cls;
    if (m[1] != null) cls = 'c';
    else if (m[2] != null) cls = L === 'json' && /^\s*:/.test(code.slice(last)) ? 'k' : 's';
    else if (m[3] != null) cls = 'n';
    else if (kw.has(m[4])) cls = 'w';
    else if (L !== 'js' && L !== 'json' && /^[A-Z]/.test(m[4])) cls = 't';
    out += cls ? `<span class="tk-${cls}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
  }
  return out + escapeHtml(code.slice(last));
}

// ---------------------------------------------------------------- inline
const safeExt = (u) => { const s = String(u || '').trim(); return /^(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+)$/i.test(s) ? s : null; };
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const NUL = '\u0000';

function parseWiki(inner) {
  const bar = inner.indexOf('|');
  const target = (bar < 0 ? inner : inner.slice(0, bar)).replace(/\\$/, '');
  const alias = bar < 0 ? null : inner.slice(bar + 1);
  const hash = target.indexOf('#');
  const note = (hash < 0 ? target : target.slice(0, hash)).trim();
  let heading = hash < 0 ? '' : target.slice(hash + 1).trim();
  if (heading.startsWith('^')) heading = ''; // block ids are not indexed
  return { note, heading, alias, target: target.trim() };
}

function ctxOf(ctx) {
  return ctx && ctx.__ok ? ctx : Object.assign({ __ok: true, resolver: null, footnotes: new Map(), fnOrder: [], slugs: new Map() }, ctx || {});
}

function wikiHtml(inner, ctx) {
  const w = parseWiki(inner);
  const label = w.alias != null && w.alias.trim() ? w.alias.trim() : (w.note ? w.note + (w.heading ? ' > ' + w.heading : '') : w.heading);
  if (!w.note) {
    return `<a class="nb-link" href="#${escapeHtml(slug(w.heading))}" data-anchor="${escapeHtml(slug(w.heading))}">${escapeHtml(label)}</a>`;
  }
  const path = ctx.resolver ? ctx.resolver.note(w.note) : null;
  if (!path) return `<span class="nb-link nb-missing" title="No note called &quot;${escapeHtml(w.note)}&quot;">${escapeHtml(label)}</span>`;
  const a = w.heading ? ` data-anchor="${escapeHtml(slug(w.heading))}"` : '';
  return `<a class="nb-link" href="#" data-note="${escapeHtml(path)}"${a}>${escapeHtml(label)}</a>`;
}

function embedHtml(inner, ctx) {
  const bar = inner.indexOf('|');
  const file = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const opt = bar < 0 ? '' : inner.slice(bar + 1).trim();
  if (IMG_RE.test(file)) {
    const url = ctx.resolver ? ctx.resolver.asset(file) : null;
    if (!url) return `<span class="nb-link nb-missing" title="Missing image">${escapeHtml(file)}</span>`;
    const sz = /^(\d+)(?:x(\d+))?$/.exec(opt);
    const alt = sz ? file : (opt || file);
    return `<img class="nb-img" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy"${sz ? ` width="${+sz[1]}"` : ''}${sz && sz[2] ? ` height="${+sz[2]}"` : ''}>`;
  }
  return wikiHtml(inner, ctx); // an embedded note: shown as a link
}

// Inline spans. Atoms (code, links, embeds, escapes) are built first and parked behind placeholders so emphasis can run
// across them, then the rest is escaped and the placeholders put back.
export function renderInline(src, ctxIn) {
  const ctx = ctxOf(ctxIn);
  const atoms = [];
  const park = (html) => { atoms.push(html); return NUL + (atoms.length - 1) + NUL; };
  let s = String(src ?? '').replace(/\u0000/g, '');
  let out = '';
  let i = 0, buf = '';
  const flush = () => { out += buf; buf = ''; };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) { buf += park(escapeHtml(s[i + 1])); i += 2; continue; }
    if (c === '\\' && s[i + 1] === '\n') { buf += park('<br>'); i += 2; continue; }
    if (c === '`') {
      let n = 1; while (s[i + n] === '`') n++;
      const close = s.indexOf('`'.repeat(n), i + n);
      if (close > 0) {
        let code = s.slice(i + n, close).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        buf += park(`<code>${escapeHtml(code)}</code>`); i = close + n; continue;
      }
      buf += '`'.repeat(n); i += n; continue;
    }
    if (c === '!' && s.startsWith('![[', i)) {
      const e = s.indexOf(']]', i + 3);
      if (e > 0) { buf += park(embedHtml(s.slice(i + 3, e), ctx)); i = e + 2; continue; }
    }
    if (c === '[' && s.startsWith('[[', i)) {
      const e = s.indexOf(']]', i + 2);
      if (e > 0 && !s.slice(i + 2, e).includes('\n')) { buf += park(wikiHtml(s.slice(i + 2, e), ctx)); i = e + 2; continue; }
    }
    if (c === '[' && s[i + 1] === '^') {
      const m = /^\[\^([^\]\s]+)\]/.exec(s.slice(i));
      if (m && ctx.footnotes.has(m[1])) {
        let n = ctx.fnOrder.indexOf(m[1]) + 1;
        if (!n) { ctx.fnOrder.push(m[1]); n = ctx.fnOrder.length; }
        buf += park(`<sup class="nb-fnref"><a href="#" data-fn="${escapeHtml(m[1])}">${n}</a></sup>`); i += m[0].length; continue;
      }
    }
    if ((c === '[' || (c === '!' && s[i + 1] === '[')) && !s.startsWith('[[', c === '!' ? i + 1 : i)) {
      const img = c === '!';
      const st = img ? i + 1 : i;
      const link = parseLink(s, st);
      if (link) {
        const html = linkHtml(link, img, ctx);
        buf += park(html); i = link.end; continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) { buf += park(extLink(m[1], m[1])); i += m[0].length; continue; }
    }
    if (c === 'h' && /^https?:\/\//i.test(s.slice(i, i + 8)) && !/[\w]/.test(s[i - 1] || ' ')) {
      const m = /^https?:\/\/[^\s<>"]+/i.exec(s.slice(i));
      let url = m[0];
      const trail = /[.,;:!?)\]*_~'"]+$/.exec(url);
      if (trail) url = url.slice(0, url.length - trail[0].length);
      if (url.length > 8) { buf += park(extLink(url, url)); i += url.length; continue; }
    }
    buf += c; i++;
  }
  flush();
  let h = escapeHtml(out);
  h = h.replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '<strong>$1</strong>')
    .replace(/\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*/g, '<em>$1</em>')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '<em>$1</em>')
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/==(?=\S)([\s\S]+?)(?<=\S)==/g, '<mark class="nb-hl">$1</mark>');
  // placeholders may nest (a link label holds atoms); resolve until stable
  for (let k = 0; k < 6 && h.includes(NUL); k++) h = h.replace(/\u0000(\d+)\u0000/g, (_, n) => atoms[+n] ?? '');
  return h.replace(/\u0000/g, '');
}

function extLink(url, label) {
  return `<a class="nb-ext" href="${escapeHtml(url)}" data-ext-url="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

// [label](dest "title") starting at s[i] === '['
function parseLink(s, i) {
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '`') { const e = s.indexOf('`', j + 1); if (e > 0) j = e; continue; }
    if (s[j] === '[') depth++;
    else if (s[j] === ']' && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== '(') return null;
  const label = s.slice(i + 1, j);
  let k = j + 2, d = 1, dest = '';
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0) return null;
    dest = s.slice(k + 1, e); k = e + 1;
    while (s[k] === ' ') k++;
    if (s[k] !== ')') { const e2 = s.indexOf(')', k); if (e2 < 0) return null; k = e2; }
  } else {
    for (; k < s.length; k++) {
      if (s[k] === '\\') { dest += s[k + 1] ?? ''; k++; continue; }
      if (s[k] === '(') d++;
      else if (s[k] === ')' && --d === 0) break;
      else if (/\s/.test(s[k]) && d === 1) { const e2 = s.indexOf(')', k); if (e2 < 0) return null; k = e2; break; }
      dest += s[k];
    }
    if (k >= s.length) return null;
  }
  return { label, dest: dest.trim(), end: k + 1 };
}

function linkHtml({ label, dest }, img, ctx) {
  if (img) {
    const url = safeExt(dest) ? null : (ctx.resolver ? ctx.resolver.asset(dest) : null);
    if (url) return `<img class="nb-img" src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy">`;
    return escapeHtml(label || dest); // remote and unknown images are never loaded
  }
  const inner = renderInline(label, ctx);
  const ext = safeExt(dest);
  if (ext) return `<a class="nb-ext" href="${escapeHtml(ext)}" data-ext-url="${escapeHtml(ext)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) return inner; // javascript:, data:, file: ... are dropped
  const hash = dest.indexOf('#');
  const file = hash < 0 ? dest : dest.slice(0, hash);
  let anchor = hash < 0 ? '' : dest.slice(hash + 1);
  try { anchor = decodeURIComponent(anchor); } catch { /* keep */ }
  if (!file) return `<a class="nb-link" href="#${escapeHtml(slug(anchor))}" data-anchor="${escapeHtml(slug(anchor))}">${inner}</a>`;
  const path = ctx.resolver ? ctx.resolver.note(file) : null;
  if (!path) return `<span class="nb-link nb-missing" title="Missing note">${inner}</span>`;
  return `<a class="nb-link" href="#" data-note="${escapeHtml(path)}"${anchor ? ` data-anchor="${escapeHtml(slug(anchor))}"` : ''}>${inner}</a>`;
}

// ---------------------------------------------------------------- blocks
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEAD_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const QUOTE_RE = /^ {0,3}>/;
const DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-])?[ \t]*(.*)$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', wiki = 0, code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') code = !code;
    if (!code && c === '[' && s[i + 1] === '[') { wiki++; cur += '[['; i++; continue; }
    if (!code && wiki && c === ']' && s[i + 1] === ']') { wiki--; cur += ']]'; i++; continue; }
    if (c === '|' && !wiki && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isTableStart = (lines, i) => i + 1 < lines.length && lines[i].includes('|') && DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes('-') && (lines[i + 1].includes('|') || splitRow(lines[i]).length > 1);

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || HEAD_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || isTableStart(lines, i);
}

const indentOf = (l) => /^ */.exec(l)[0].length;

function renderBlocks(lines, ctx, tight = false) {
  let out = '';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = FENCE_RE.exec(line);
    if (m) {
      const ch = m[2][0], len = m[2].length, ind = m[1].length;
      const body = [];
      i++;
      while (i < n) {
        const cm = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (cm && cm[1][0] === ch && cm[1].length >= len) { i++; break; }
        body.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), ''));
        i++;
      }
      out += codeBlock(body.join('\n'), m[3]);
      continue;
    }
    if ((m = HEAD_RE.exec(line))) {
      const level = m[1].length;
      const base = slug(m[2]);
      const seen = ctx.slugs.get(base) || 0;
      ctx.slugs.set(base, seen + 1);
      const id = seen ? `${base}-${seen}` : base;
      (ctx.headings || (ctx.headings = [])).push({ level, text: m[2], slug: base });
      out += `<h${level} id="nb-${escapeHtml(id)}" data-slug="${escapeHtml(base)}">${renderInline(m[2], ctx)}</h${level}>`;
      i++; continue;
    }
    if (HR_RE.test(line)) { out += '<hr>'; i++; continue; }
    if (QUOTE_RE.test(line)) {
      const q = [];
      while (i < n && QUOTE_RE.test(lines[i])) { q.push(lines[i].replace(/^ {0,3}> ?/, '')); i++; }
      out += quoteBlock(q, ctx);
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const al = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < n && lines[i].trim() && lines[i].includes('|') && !HEAD_RE.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      const cell = (tag, t, k) => `<${tag}${al[k] ? ` style="text-align:${al[k]}"` : ''}>${renderInline(t, ctx)}</${tag}>`;
      out += '<div class="nb-table-wrap"><table class="nb-table"><thead><tr>' + head.map((t, k) => cell('th', t, k)).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] ?? '', k)).join('') + '</tr>').join('') + '</tbody></table></div>';
      continue;
    }
    if (LIST_RE.test(line)) {
      const r = renderList(lines, i, ctx);
      out += r.html; i = r.next; continue;
    }
    // paragraph
    const p = [line.replace(/^\s+/, '')];
    i++;
    while (i < n && lines[i].trim() && !startsBlock(lines, i)) { p.push(lines[i].replace(/^\s+/, '')); i++; }
    const html = paragraphHtml(p, ctx);
    out += tight ? html : `<p>${html}</p>`;
  }
  return out;
}

// One renderInline call for the whole paragraph, so **bold**, ==highlight== etc. can span
// line breaks; hard breaks travel through it as \u0001 and become <br> afterwards.
function paragraphHtml(p, ctx) {
  const src = p.map((l, k) => {
    const last = k === p.length - 1;
    const hard = !last && (/ {2,}$/.test(l) || /\\$/.test(l));
    return (hard ? l.replace(/( {2,}|\\)$/, '') : l.replace(/ +$/, '')) + (last ? '' : hard ? '\u0001\n' : '\n');
  }).join('');
  return renderInline(src, ctx).replace(/\u0001\n?/g, '<br>');
}

function codeBlock(code, langRaw) {
  const lang = String(langRaw || '').toLowerCase().replace(/[^a-z0-9+#-]/g, '');
  if (lang === 'mermaid') return `<div class="nb-mermaid"><pre class="nb-mermaid-src">${escapeHtml(code)}</pre></div>`;
  return `<pre class="nb-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${highlightCode(code, lang)}</code></pre>`;
}

function quoteBlock(q, ctx) {
  const c = q.length ? CALLOUT_RE.exec(q[0].trim()) : null;
  if (!c) return `<blockquote>${renderBlocks(q, ctx)}</blockquote>`;
  const type = calloutType(c[1]);
  const fold = c[2] || '';
  const title = c[3].trim() || c[1].charAt(0).toUpperCase() + c[1].slice(1).toLowerCase();
  const body = renderBlocks(q.slice(1), ctx);
  const head = `${CALLOUT_ICONS[type]}<span class="nb-callout-title-text">${renderInline(title, ctx)}</span>`;
  if (fold) {
    return `<details class="nb-callout" data-type="${type}"${fold === '+' ? ' open' : ''}><summary class="nb-callout-title">${head}</summary><div class="nb-callout-body">${body}</div></details>`;
  }
  return `<div class="nb-callout" data-type="${type}"><div class="nb-callout-title">${head}</div>${body ? `<div class="nb-callout-body">${body}</div>` : ''}</div>`;
}

function renderList(lines, start, ctx) {
  const first = LIST_RE.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) {
      // a different marker at a smaller or bigger indent ends this list unless it is nested (handled in the item)
      break;
    }
    const offset = m[0].length;
    const itemLines = [lines[i].slice(offset)];
    let loose = false;
    let j = i + 1;
    while (j < n) {
      const l = lines[j];
      if (!l.trim()) {
        let k = j + 1;
        while (k < n && !lines[k].trim()) k++;
        if (k < n && indentOf(lines[k]) > base) { loose = true; for (; j < k; j++) itemLines.push(''); continue; }
        break;
      }
      const ind = indentOf(l);
      if (ind > base) { itemLines.push(l.slice(Math.min(ind, offset))); j++; continue; }
      // lazy continuation of a paragraph
      const prev = itemLines[itemLines.length - 1];
      if (prev.trim() && !startsBlock(lines, j) && !FENCE_RE.test(prev)) { itemLines.push(l.replace(/^\s+/, '')); j++; continue; }
      break;
    }
    i = j;
    let task = null;
    const t = /^\[([ xX])\]\s+/.exec(itemLines[0]);
    if (t) { task = t[1] !== ' '; itemLines[0] = itemLines[0].slice(t[0].length); }
    const inner = renderBlocks(itemLines, ctx, !loose);
    const box = task == null ? '' : `<span class="nb-task${task ? ' done' : ''}" aria-hidden="true"></span>`;
    items.push(`<li${task == null ? '' : ' class="nb-task-item"'}>${box}${inner}</li>`);
    while (i < n && !lines[i].trim() && i + 1 < n && LIST_RE.test(lines[i + 1]) && LIST_RE.exec(lines[i + 1])[1].length === base && /\d/.test(LIST_RE.exec(lines[i + 1])[2]) === ordered) i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  const hasTask = items.some((x) => x.startsWith('<li class="nb-task-item"'));
  return { html: `<${tag}${startAttr}${hasTask ? ' class="nb-tasks"' : ''}>${items.join('')}</${tag}>`, next: i };
}

// ---------------------------------------------------------------- document
export function renderMarkdown(md, opts = {}) {
  const ctx = ctxOf({ resolver: opts.resolver || null });
  const { props, body } = parseFrontmatter(String(md ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    '));
  const lines = body.split('\n');
  // footnote definitions are lifted out first
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(lines[i]);
    if (!m) { kept.push(lines[i]); continue; }
    const parts = [m[2]];
    while (i + 1 < lines.length && /^( {2,})\S/.test(lines[i + 1])) { parts.push(lines[++i].trim()); }
    ctx.footnotes.set(m[1], parts.join(' '));
  }
  let html = renderBlocks(kept, ctx);
  if (ctx.fnOrder.length) {
    html += '<section class="nb-footnotes"><hr><ol>' + ctx.fnOrder.map((id) =>
      `<li id="nb-fn-${escapeHtml(id)}">${renderInline(ctx.footnotes.get(id), ctx)} <a href="#" class="nb-fnback" data-fnback="${escapeHtml(id)}" aria-label="Back">&#8617;</a></li>`).join('') + '</ol></section>';
  }
  return { html, props, headings: ctx.headings || [] };
}

export function propsHtml(props) {
  if (!props.length) return '';
  return '<div class="nb-props">' + props.map(([k, vs]) =>
    `<span class="nb-prop"><span class="nb-prop-k">${escapeHtml(k)}</span>${vs.map((v) => `<span class="nb-prop-v">${escapeHtml(v)}</span>`).join('')}</span>`).join('') + '</div>';
}

export function formatBytes(b) {
  const n = Number(b) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

// A second try for a diagram mermaid rejected: in mermaid a ';' ends a statement, so one inside a label or message
// breaks the parse. Written as the entity #59; it prints as ';'. A backslash-escaped quote inside a label becomes #quot;.
export function repairMermaid(src) {
  return String(src).replace(/;(?=[^\s;])|;(?=\s+\S)/g, '#59;').replace(/\\"/g, '#quot;');
}
