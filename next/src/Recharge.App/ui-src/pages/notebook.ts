import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import type { PageModule, ParsedRoute } from '../router.js';
import { go, replace } from '../navigation.js';
import { setSearchText } from '../shell.js';
import { pageTemplate, type PageTemplateElement } from '../components/page.js';
import { button } from '../components/button.js';
import { selectControl } from '../components/select.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { icon } from '../icons.js';
import { notebookHash, parseNotebookRoute, type NotebookRoute } from '../notebook/route.js';
import { listVaults, loadNoteText, loadVault, pickNote, zipUrl, type Vault, type VaultMeta } from '../notebook/data.js';
import {
  formatBytes, propsHtml, renderMarkdown, searchNotes,
  type NoteInfo, type TreeNode,
} from '../notebook/markdown.js';
import { diagramsSettled, disposeDiagrams, openFullscreen, queueDiagrams } from '../notebook/mermaid.js';

const LAST_KEY = 'rechargeNotebookLast'; // { vault, notes: { <vaultId>: <path> } }
const CSS_ID = 'notebook-css';

interface Last { vault: string; notes: Record<string, string> }

function lastRead(): Last {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (v && typeof v === 'object') return { vault: String(v.vault || ''), notes: v.notes && typeof v.notes === 'object' ? v.notes : {} };
  } catch { /* storage unavailable */ }
  return { vault: '', notes: {} };
}

function lastWrite(vault: string, note: string): void {
  const last = lastRead();
  last.vault = vault;
  last.notes[vault] = note;
  try { localStorage.setItem(LAST_KEY, JSON.stringify(last)); } catch { /* storage unavailable */ }
}

function ensureCss(): void {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = new URL('notebook/notebook.css', document.baseURI).href;
  document.head.appendChild(link);
}

/** What survives leaving the page: the folders left open in the sidebar, and where the tree was scrolled. */
const openFolders = new Map<string, Set<string>>();
let treeScroll = 0;

interface View {
  generation: number;
  page: PageTemplateElement;
  vaultHost: HTMLElement;
  downloadHost: HTMLElement;
  side: HTMLElement;
  search: HTMLInputElement;
  tree: HTMLElement;
  scroll: HTMLElement;
  article: HTMLElement;
  backlinks: HTMLElement;
  nb: HTMLElement;
}

let view: View | null = null;
let generation = 0;
let route: NotebookRoute = { vault: '', note: '', anchor: '', q: '' };
let vaults: VaultMeta[] = [];
let vault: Vault | null = null;
let current: NoteInfo | null = null;
let query = '';
let searchTimer = 0;
let openFirstDiagram = false;

function openUrl(url: string): void {
  void call('open.url', { url }).catch((error) => console.error('open.url failed', describeError(error)));
}

function hashFor(extra: Partial<NotebookRoute>): string {
  return notebookHash({ vault: vault?.meta.id || route.vault, note: current?.path || '', q: query, ...extra });
}

function buildView(): View {
  const vaultHost = h('div', { className: 'nb-vaults' });
  const downloadHost = h('div', { className: 'nb-download' });
  const back = button('Back', { icon: 'chevron-left', title: 'Back', onClick: () => window.history.back() });
  const forward = button('Forward', { title: 'Forward', onClick: () => window.history.forward() });
  forward.appendChild(icon('chevron-right', 18));
  const contents = button('Contents', { onClick: () => nb.classList.toggle('side-open') });
  contents.classList.add('nb-side-toggle');
  const page = pageTemplate({
    title: 'Notebook',
    subtitle: 'The Recharge and IGTAP vaults, read in the app.',
    actions: [vaultHost, back, forward, contents, downloadHost],
  });

  const search = h('input', {
    className: 'nb-search',
    attrs: { type: 'search', placeholder: 'Search the notebook...', maxlength: '100', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search the notebook' },
  });
  const tree = h('div', { className: 'nb-tree' });
  const side = h('aside', { className: 'nb-side' }, search, tree);
  const article = h('article', { className: 'nb-article' });
  const backlinks = h('section', { className: 'nb-backlinks', hidden: true });
  const scroll = h('div', { className: 'nb-scroll' }, article, backlinks);
  const nb = h('div', { className: 'nb' }, side, h('section', { className: 'nb-main' }, scroll));
  page.content.appendChild(nb);

  const v: View = { generation, page, vaultHost, downloadHost, side, search, tree, scroll, article, backlinks, nb };

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => setQuery(search.value), 120);
  });
  search.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); search.value = ''; setQuery(''); }
    if (event.key === 'Enter') tree.querySelector<HTMLElement>('.nb-hit')?.click();
  });
  tree.addEventListener('click', onNoteClick);
  backlinks.addEventListener('click', onNoteClick);
  tree.addEventListener('toggle', onFolderToggle, true);
  article.addEventListener('click', onArticleClick);
  return v;
}

function setQuery(value: string): void {
  query = value.trim();
  if (view && view.search.value !== value) view.search.value = value;
  setSearchText(value);
  if (vault) renderTree();
  replace(hashFor({}));
}

// ---- rendering ----
function showState(node: Node): void {
  if (!view) return;
  view.article.replaceChildren(node);
  view.backlinks.hidden = true;
}

function showError(error: unknown, retry: () => void): void {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  showState(errorState((offline ? 'You are offline. ' : 'The notebook could not be reached. ') + describeError(error), retry));
}

function renderHeader(): void {
  if (!view) return;
  view.vaultHost.replaceChildren();
  if (vaults.length > 0) {
    view.vaultHost.appendChild(selectControl(
      vaults.map((m) => ({ value: m.id, label: m.title })),
      { label: 'Vault', value: vault?.meta.id, onChange: (id) => go(notebookHash({ vault: id, q: '' })) },
    ));
  }
  view.downloadHost.replaceChildren();
  const meta = vault?.meta;
  if (meta && meta.zip) {
    view.downloadHost.appendChild(button(`Download vault (${formatBytes(meta.zipBytes)})`, {
      kind: 'primary',
      icon: 'download',
      title: `${meta.title} vault for Obsidian: ${meta.notes} notes, built ${meta.builtAt.slice(0, 10)}`,
      onClick: () => openUrl(zipUrl(meta)),
    }));
  }
}

function leaf(note: NoteInfo): HTMLElement {
  const home = !!vault && note.title === vault.index.home;
  const node = h('button', {
    className: 'nb-leaf' + (home ? ' home' : '') + (current && note.path === current.path ? ' active' : ''),
    title: note.path,
    attrs: { type: 'button' },
    dataset: { note: note.path },
    text: note.title,
  });
  return node;
}

function folder(node: TreeNode, open: Set<string>): HTMLElement {
  const details = h('details', { className: 'nb-folder', dataset: { folder: node.path } });
  details.open = open.has(node.path);
  const body = h('div', { className: 'nb-folder-body' });
  for (const sub of node.folders) body.appendChild(folder(sub, open));
  for (const note of node.notes) body.appendChild(leaf(note));
  details.append(h('summary', { text: node.name }), body);
  return details;
}

function renderTree(): void {
  if (!view || !vault) return;
  if (query) { renderResults(); return; }
  const open = openFolders.get(vault.meta.id) || new Set<string>();
  openFolders.set(vault.meta.id, open);
  view.tree.replaceChildren(
    ...vault.tree.notes.map(leaf),
    ...vault.tree.folders.map((f) => folder(f, open)),
  );
}

function renderResults(): void {
  if (!view || !vault) return;
  const results = searchNotes(vault.index.notes, query, 60);
  if (!results.length) {
    view.tree.replaceChildren(h('div', { className: 'nb-count', text: 'No matches.' }));
    return;
  }
  const rows = results.map((r) => {
    const hit = h('button', {
      className: 'nb-hit' + (current && r.note.path === current.path ? ' active' : ''),
      attrs: { type: 'button' },
      dataset: { note: r.note.path },
    });
    if (r.headHit >= 0 && !r.titleHit && r.note.headings) hit.dataset.anchor = r.note.headings[r.headHit].slug;
    const title = h('span', { className: 'nb-hit-title' });
    title.innerHTML = r.titleHtml; // highlightHtml escapes every piece of note text
    hit.appendChild(title);
    if (r.note.folder) hit.appendChild(h('span', { className: 'nb-hit-folder', text: r.note.folder }));
    const snippet = h('span', { className: 'nb-hit-snip' });
    snippet.innerHTML = r.snippetHtml;
    hit.appendChild(snippet);
    return hit;
  });
  view.tree.replaceChildren(
    h('div', { className: 'nb-count', text: `${results.length}${results.length === 60 ? '+' : ''} result${results.length === 1 ? '' : 's'}` }),
    ...rows,
  );
}

function renderBacklinks(note: NoteInfo): void {
  if (!view || !vault) return;
  const items = (note.backlinks || [])
    .map((title) => ({ title, path: vault!.resolver.note(title) }))
    .filter((x): x is { title: string; path: string } => !!x.path);
  view.backlinks.hidden = items.length === 0;
  if (!items.length) return;
  const list = h('div', { className: 'nb-bl-list' });
  for (const item of items) {
    list.appendChild(h('button', { className: 'chip nb-bl', attrs: { type: 'button' }, dataset: { note: item.path }, text: item.title }));
  }
  view.backlinks.replaceChildren(h('h3', { text: `Linked from (${items.length})` }), list);
}

function scrollToAnchor(anchor: string): void {
  if (!view) return;
  if (!anchor) { view.scroll.scrollTop = 0; return; }
  const target = Array.from(view.article.querySelectorAll<HTMLElement>('[data-slug]')).find((x) => x.dataset.slug === anchor)
    || view.article.querySelector<HTMLElement>(`[id="nb-${CSS.escape(anchor)}"]`);
  if (target) target.scrollIntoView({ block: 'start' });
  else view.scroll.scrollTop = 0;
}

async function showNote(note: NoteInfo, anchor: string, mine: number): Promise<void> {
  if (!view || !vault) return;
  const v = vault;
  const text = await loadNoteText(v, note.path);
  if (mine !== generation || !view) return;
  current = note;
  lastWrite(v.meta.id, note.path);
  const rendered = renderMarkdown(text, { resolver: v.resolver });
  // renderMarkdown escapes all note text and emits only the tags it writes itself.
  view.article.innerHTML = propsHtml(rendered.props) + rendered.html;
  renderBacklinks(note);
  const open = openFolders.get(v.meta.id) || new Set<string>();
  openFolders.set(v.meta.id, open);
  const parts = note.path.split('/');
  parts.pop();
  let acc = '';
  for (const part of parts) { acc = acc ? acc + '/' + part : part; open.add(acc); }
  renderTree();
  view.tree.scrollTop = treeScroll;
  view.tree.querySelector('.nb-leaf.active')?.scrollIntoView({ block: 'nearest' });
  scrollToAnchor(anchor);
  queueDiagrams(view.article, view.scroll);
  document.title = note.title + ' - Notebook · Recharge';
}

// ---- events ----
function onNoteClick(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-note]');
  if (!target || !target.dataset.note) return;
  go(hashFor({ note: target.dataset.note, anchor: target.dataset.anchor || '' }));
}

function onFolderToggle(event: Event): void {
  const details = event.target as HTMLElement;
  if (!vault || !(details instanceof HTMLDetailsElement) || !details.classList.contains('nb-folder')) return;
  const open = openFolders.get(vault.meta.id);
  if (!open) return;
  const path = details.dataset.folder || '';
  if (details.open) open.add(path); else open.delete(path);
}

function onArticleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const diagram = target.closest<HTMLElement>('.nb-mermaid[data-state="done"]');
  if (diagram && !target.closest('a')) { openFullscreen(diagram); return; }
  const a = target.closest<HTMLElement>('a');
  if (!a || !view) return;
  event.preventDefault();
  if (a.dataset.extUrl) { openUrl(a.dataset.extUrl); return; }
  if (a.dataset.note) { go(hashFor({ note: a.dataset.note, anchor: a.dataset.anchor || '' })); return; }
  if (a.dataset.anchor !== undefined) { scrollToAnchor(a.dataset.anchor); return; }
  if (a.dataset.fn) { document.getElementById('nb-fn-' + a.dataset.fn)?.scrollIntoView({ block: 'center' }); return; }
  if (a.dataset.fnback) {
    view.article.querySelector(`[data-fn="${CSS.escape(a.dataset.fnback)}"]`)?.scrollIntoView({ block: 'center' });
  }
}

// ---- the page ----
async function start(mine: number): Promise<void> {
  if (!view) return;
  showState(h('div', { className: 'nb-state', text: 'Loading...' }));
  try {
    vaults = await listVaults();
    if (mine !== generation) return;
    const last = lastRead();
    const id = vaults.some((m) => m.id === route.vault) ? route.vault
      : vaults.some((m) => m.id === last.vault) ? last.vault : vaults[0].id;
    const meta = vaults.find((m) => m.id === id) as VaultMeta;
    vault = await loadVault(meta);
    if (mine !== generation) return;
    renderHeader();
    renderTree();
    const want = route.note || last.notes[id] || '';
    const note = pickNote(vault, want);
    if (!note) {
      showState(emptyState('notebook', 'No notes', 'This vault has no notes yet.'));
      return;
    }
    await showNote(note, route.anchor, mine);
    if (view && mine === generation) await diagramsSettled(view.article, 6000);
    // #/notebook?...&fs=1 opens the first drawn diagram full screen (a deep link, and how the snapshots reach the viewer).
    if (openFirstDiagram && view && mine === generation) {
      const box = view.article.querySelector<HTMLElement>('.nb-mermaid[data-state="done"]');
      if (box) { openFullscreen(box); await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  } catch (error) {
    if (mine === generation) showError(error, () => void start(mine));
  }
}

export const notebookPage: PageModule = {
  title: 'Notebook',
  mount(el: HTMLElement, params: ParsedRoute): void {
    ensureCss();
    el.classList.add('nb-host');
    generation++;
    route = parseNotebookRoute(params);
    query = route.q.trim();
    openFirstDiagram = params.query.fs === '1';
    vault = null;
    current = null;
    view = buildView();
    view.search.value = route.q;
    setSearchText(route.q);
    el.appendChild(view.page);
    return start(generation);
  },
  unmount(): void {
    generation++;
    window.clearTimeout(searchTimer);
    if (view) treeScroll = view.tree.scrollTop;
    disposeDiagrams();
    view = null;
    vault = null;
    current = null;
  },
  filter(value: string): void {
    if (!view) return;
    view.search.value = value;
    setQuery(value);
  },
};
