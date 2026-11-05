import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { buildRoute, type PageModule, type ParsedRoute, type Query } from '../router.js';
import { replace, closePanel, go } from '../navigation.js';
import { setSearchText } from '../shell.js';
import { pageTemplate, type PageTemplateElement } from '../components/page.js';
import { tabs } from '../components/tabs.js';
import { chips } from '../components/chips.js';
import { selectControl } from '../components/select.js';
import { skeletonCards } from '../components/skeleton.js';
import { button } from '../components/button.js';
import { cardGrid } from '../components/cardGrid.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { itemCard, selectableCard, setCellSelected, imagesSettled } from '../components/itemCard.js';
import { call } from '../bridge.js';
import { toast } from '../components/toast.js';
import { uploadsView } from '../account/uploads.js';
import { openUploadForm } from '../account/uploadForm.js';
import { currentUser, sessionReady } from '../account/session.js';
import { openAuthModal } from '../account/index.js';
import { skinPicker } from '../skins/picker.js';
import { buildDetail, loadingDetail, notFoundDetail, type Detail, type DetailOptions } from '../components/detail.js';
import { clearCache, loadInstalled, loadKind, onHubChange, peekInstalled, peekKind } from '../lib/hub.js';
import { perfRouteData } from '../perf.js';
import {
  actionsOf, annotate, installedItems, KINDS, KIND_LABEL, isEmbeddedMod, matchesQuery, setItemBase, SORTS, sortItems, updatesOf,
  type InstalledData, type Item, type Kind, type Lists, type Sort,
} from '../lib/library.js';

/** The Library groups everything by kind: Maps, Mods, Skins, Games and Backgrounds (which includes playlists). */
type Group = 'maps' | 'mods' | 'skins' | 'games' | 'backgrounds';
type View = 'installed' | 'browse' | 'updates' | 'uploads';
/** view null = not chosen yet: Installed when this kind has anything installed, else Browse. */
type State = { kind: Group; view: View | null; show: 'all' | Kind; sort: Sort; q: string };

interface GroupInfo { label: string; icon: string; kinds: Kind[]; views: View[]; empty: string }
const GROUPS: Record<Group, GroupInfo> = {
  maps: { label: 'Maps', icon: 'maps', kinds: ['maps'], views: ['installed', 'browse', 'updates'], empty: 'Maps you install show up here.' },
  mods: { label: 'Mods', icon: 'mods', kinds: ['mods'], views: ['installed', 'browse', 'updates'], empty: 'Mods you install show up here.' },
  skins: { label: 'Skins', icon: 'skins', kinds: ['skins'], views: ['installed', 'browse', 'updates'], empty: 'Skins you install show up here.' },
  games: { label: 'Games', icon: 'gamepad', kinds: ['games'], views: ['browse'], empty: '' },
  backgrounds: { label: 'Backgrounds', icon: 'backgrounds', kinds: ['backgrounds', 'playlists'], views: ['installed', 'browse', 'updates'], empty: 'Backgrounds and playlists you install show up here.' },
};
const GROUP_IDS = Object.keys(GROUPS) as Group[];
const VIEW_LABEL: Record<View, string> = { installed: 'Installed', browse: 'Browse', updates: 'Updates', uploads: 'Your uploads' };
const SORT_LABEL: Record<Sort, string> = { new: 'Newest', updated: 'Recently updated', name: 'Name A–Z', popular: 'Popular' };
const SHOW_CHIPS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'backgrounds', label: 'Backgrounds' },
  { value: 'playlists', label: 'Playlists' },
];

let uploads: { element: HTMLElement; ready: Promise<void>; filter(query: string): void; reload(): void } | null = null;
let picker: { element: HTMLElement; update(items: Item[], loading: boolean): void; dispose(): void } | null = null;

const DEFAULT_STATE: State = { kind: 'maps', view: null, show: 'all', sort: 'new', q: '' };

/** The list state last shown, so a detail panel opens over the same list. */
let lastList: State = { ...DEFAULT_STATE };
let state: State = { ...DEFAULT_STATE };
let page: PageTemplateElement | null = null;
let generation = 0;

let lists: Lists = emptyLists();
let errors: Partial<Record<Kind, string>> = {};
let pending = new Set<string>();
let installed: InstalledData | null = null;
let installedError = '';

let kindHost: HTMLElement | null = null;
let filtersHost: HTMLElement | null = null;
let actionsHost: HTMLElement | null = null;
let summary: HTMLElement | null = null;
let listHost: HTMLElement | null = null;
let detail: Detail | null = null;
let renderTimer = 0;

// The install queue: click a card's corner check to queue it, then install them all one after the other.
type QueueState = { state: 'queued' | 'installing' | 'installed' | 'failed'; message?: string };
const queue = new Map<string, Item>();
const queueState = new Map<string, QueueState>();
let queueRunning = false;
let queueBar: HTMLElement | null = null;
const itemKey = (item: Item): string => item.kind + ':' + item.id;
const gameFound = (): boolean => !installed || !!installed.game;
const canQueue = (item: Item): boolean => state.view === 'browse' && actionsOf(item, gameFound()).canInstall;
const painted = new Map<HTMLElement, string>();

function emptyLists(): Lists {
  return { maps: null, mods: null, skins: null, backgrounds: null, playlists: null, games: null };
}

const groupKinds = (): Kind[] => GROUPS[state.kind].kinds;
const groupViews = (): View[] => GROUPS[state.kind].views;

/** Reads the route. The old ?mode=discover and kind=all links still land somewhere sensible. */
export function readState(route: ParsedRoute, fallback: State): State {
  const base = route.isPanel ? fallback : DEFAULT_STATE;
  const rawKind = route.query.kind || base.kind;
  const kind: Group = (GROUP_IDS as string[]).includes(rawKind) ? (rawKind as Group) : rawKind === 'playlists' ? 'backgrounds' : base.kind;
  const rawView = route.query.view || (route.query.mode === 'discover' ? 'browse' : route.query.mode) || (route.isPanel ? base.view || '' : '');
  const view = (GROUPS[kind].views as string[]).includes(rawView) || rawView === 'uploads' ? (rawView as View) : null;
  const sort = route.query.sort || base.sort;
  const show = route.query.show || (rawKind === 'playlists' ? 'playlists' : base.show);
  return {
    kind,
    view: GROUPS[kind].views.length === 1 ? GROUPS[kind].views[0] : view,
    show: (GROUPS[kind].kinds as string[]).includes(show) ? (show as Kind) : 'all',
    sort: (SORTS as string[]).includes(sort) ? (sort as Sort) : 'new',
    q: route.isPanel ? base.q : route.query.q || '',
  };
}

function queryFor(value: State): Query {
  const query: Query = { kind: value.kind, sort: value.sort };
  if (value.view) query.view = value.view;
  if (value.show !== 'all') query.show = value.show;
  if (value.q) query.q = value.q;
  return query;
}

function baseRoute(value: State): string {
  return buildRoute('/library', queryFor(value));
}

const currentView = (): View => state.view || 'browse';

/** Items for the current view, before search and sort. */
function modeItems(): Item[] {
  const withStatus: Lists = emptyLists();
  for (const kind of KINDS) withStatus[kind] = lists[kind] ? annotate(lists[kind] as Item[], installed) : null;
  const kinds = groupKinds();
  if (currentView() === 'browse') {
    const out: Item[] = [];
    for (const kind of kinds) for (const item of withStatus[kind] || []) if (!isEmbeddedMod(item)) out.push(item);
    return out;
  }
  const mine = installedItems(installed, lists).filter((item) => kinds.includes(item.kind));
  return currentView() === 'updates' ? updatesOf(mine) : mine;
}

function loadingNow(): boolean {
  if (currentView() === 'browse') return groupKinds().some((kind) => pending.has(kind));
  return pending.has('installed') || groupKinds().some((kind) => pending.has(kind));
}

function schedule(): void {
  if (renderTimer) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = 0;
    render();
  }, 16);
}

function fetchKind(kind: Kind, force: boolean): Promise<void> {
  const token = generation;
  pending.add(kind);
  delete errors[kind];
  return loadKind(kind, force).then(
    (items) => {
      if (token !== generation) return;
      lists[kind] = items;
      pending.delete(kind);
      schedule();
    },
    (error) => {
      if (token !== generation) return;
      console.error('hub list ' + kind + ' failed: ' + describeError(error));
      errors[kind] = describeError(error);
      pending.delete(kind);
      schedule();
    }
  );
}

function fetchInstalled(force: boolean): Promise<void> {
  const token = generation;
  pending.add('installed');
  installedError = '';
  return loadInstalled(force).then(
    (data) => {
      if (token !== generation) return;
      installed = data;
      pending.delete('installed');
      schedule();
    },
    (error) => {
      if (token !== generation) return;
      console.error('installed scan failed: ' + describeError(error));
      installedError = describeError(error);
      pending.delete('installed');
      schedule();
    }
  );
}

function loadAll(force: boolean): Promise<unknown> {
  const jobs: Array<Promise<void>> = [fetchInstalled(force)];
  for (const kind of KINDS) jobs.push(fetchKind(kind, force));
  return Promise.all(jobs);
}

function syncRoute(): void {
  lastList = { ...state };
  replace(baseRoute(state));
  render();
}

/** Rebuild a bar section only when what it shows changed, and keep keyboard focus on the same button. */
function paintInto(host: HTMLElement | null, signature: string, build: () => Node[]): void {
  if (!host || painted.get(host) === signature) return;
  painted.set(host, signature);
  const focused = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.value : undefined;
  host.replaceChildren(...build());
  if (focused !== undefined) host.querySelector<HTMLElement>('[data-value="' + focused + '"]')?.focus();
}

/** Opens the Upload form (sign-in first when signed out); afterwards the Your uploads list is shown fresh. */
function startUpload(preset: { repo?: string } = {}): void {
  if (!currentUser()) { openAuthModal('login'); return; }
  openUploadForm(() => {
    if (state.view === 'uploads') uploads?.reload();
    else { state.view = 'uploads'; syncRoute(); }
  }, preset);
}

/** How many items the hub offers for a group (summed over its kinds); -1 until every kind's list has loaded. */
export function availableCount(group: Group, loaded: Lists): number {
  let total = 0;
  for (const kind of GROUPS[group].kinds) {
    const list = loaded[kind];
    if (!list) return -1;
    total += list.filter((item) => !isEmbeddedMod(item)).length;
  }
  return total;
}
function installedCount(group: Group): number {
  return installed ? installedItems(installed, lists).filter((item) => GROUPS[group].kinds.includes(item.kind)).length : -1;
}

function renderBar(shown: number): void {
  const uploadsOn = state.view === 'uploads';
  const counts = GROUP_IDS.map((id) => availableCount(id, lists));
  paintInto(kindHost, GROUP_IDS.map((id, i) => id + counts[i]).join() + (uploadsOn ? '|u' : '|' + state.kind), () => [
    tabs(
      GROUP_IDS.map((id, i) => ({ value: id, label: GROUPS[id].label, icon: GROUPS[id].icon, count: counts[i] > 0 ? counts[i] : undefined })),
      { value: uploadsOn ? 'none' : state.kind, onChange: (value) => chooseKind(value as Group) }
    ),
  ]);
  paintInto(actionsHost, 'a' + uploadsOn + state.kind, () => [
    ...(state.kind === 'maps' && !uploadsOn
      ? [button('New map', { kind: 'ghost', icon: 'plus', title: 'The Amplifier is coming soon', onClick: () => toast('Making maps in Recharge is coming soon.', 'info') })]
      : []),
    button('Upload', {
      kind: 'primary',
      icon: 'plus',
      title: 'Publish a mod, map or skin to the hub',
      onClick: () => startUpload(),
    }),
    button(uploadsOn ? 'Back to library' : 'Your uploads', {
      kind: 'ghost',
      icon: uploadsOn ? 'chevron-left' : 'package',
      onClick: () => {
        state.view = uploadsOn ? null : 'uploads';
        syncRoute();
      },
    }),
    button('Refresh', {
      kind: 'ghost',
      icon: 'refresh',
      title: 'Reload from the hub',
      onClick: () => {
        clearCache();
        lists = emptyLists();
        installed = null;
        void loadAll(true);
        render();
      },
    }),
  ]);
  if (uploadsOn) {
    paintInto(filtersHost, 'none', () => [h('div', { className: 'filter-spacer' }), actionsHost as HTMLElement]);
    return;
  }
  const info = GROUPS[state.kind];
  const view = currentView();
  paintInto(filtersHost, [state.kind, view, state.show, state.sort, shown].join('|'), () => [
    info.views.length > 1
      ? tabs(info.views.map((v) => ({ value: v, label: VIEW_LABEL[v] })), {
        value: view,
        onChange: (value) => {
          state.view = value as View;
          syncRoute();
        },
      })
      : h('span'),
    ...(info.kinds.length > 1
      ? [chips(SHOW_CHIPS, { value: state.show, onChange: (value) => { state.show = value as State['show']; syncRoute(); } })]
      : []),
    h('div', { className: 'filter-spacer' }),
    h('span', { className: 'filter-count', text: shown + (shown === 1 ? ' item' : ' items') }),
    selectControl(
      SORTS.map((sort) => ({ value: sort, label: SORT_LABEL[sort] })),
      { label: 'Sort', value: state.sort, onChange: (value) => { state.sort = value as Sort; syncRoute(); } }
    ),
    actionsHost as HTMLElement,
  ]);
  const sub = filtersHost?.firstElementChild;
  if (sub && sub.classList.contains('tabs')) sub.classList.add('tabs-sub');
}

function toggleQueued(item: Item): void {
  if (queueRunning) return;
  const key = itemKey(item);
  if (queue.has(key)) { queue.delete(key); queueState.delete(key); } else { queue.set(key, item); queueState.delete(key); }
  // Incremental: touch only this card and the queue bar, so no thumbnail is rebuilt or refetched.
  const cell = findCell(key);
  if (cell) { setCellSelected(cell, item.name, queue.has(key)); renderQueueBar(); } else render();
}

function findCell(key: string): HTMLElement | null {
  return listHost ? Array.from(listHost.querySelectorAll<HTMLElement>('.item-cell')).find((c) => c.dataset.key === key) || null : null;
}

function clearQueue(): void {
  if (queueRunning) return;
  const keys = Array.from(queue.keys());
  queue.clear();
  queueState.clear();
  for (const key of keys) {
    const cell = findCell(key);
    if (cell) setCellSelected(cell, cell.querySelector('.card-name')?.textContent || '', false);
  }
  renderQueueBar();
}

function renderQueueBar(): void {
  if (!queueBar) return;
  const items = Array.from(queue.values());
  queueBar.hidden = items.length === 0;
  if (items.length === 0) { queueBar.replaceChildren(); return; }
  const updates = items.filter((item) => item.status === 'update').length;
  const installs = items.length - updates;
  const parts = [installs > 0 ? 'Install ' + installs : '', updates > 0 ? 'Update ' + updates : ''].filter(Boolean).join(' · ');
  const done = items.filter((item) => ['installed', 'failed'].includes(queueState.get(itemKey(item))?.state || '')).length;
  queueBar.replaceChildren(
    h('span', { className: 'queue-count', text: queueRunning ? 'Working: ' + done + ' of ' + items.length : items.length + ' selected' }),
    h('div', { className: 'filter-spacer' }),
    button('Clear', { kind: 'ghost', disabled: queueRunning, onClick: clearQueue }),
    button(queueRunning ? 'Installing…' : parts, { kind: 'primary', icon: 'download', disabled: queueRunning, onClick: () => void runItems(Array.from(queue.values())) })
  );
}

/** Installs the given items (the queue, or one card's button) one item at a time, then reloads what is installed once. Failed items stay selected so they can be retried. */
async function runItems(items: Item[]): Promise<void> {
  if (queueRunning || items.length === 0) return;
  queueRunning = true;
  const token = generation;
  for (const item of items) queueState.set(itemKey(item), { state: 'queued' });
  render();
  let ok = 0;
  for (const item of items) {
    const key = itemKey(item);
    queueState.set(key, { state: 'installing' });
    render();
    try {
      await call(item.status === 'update' ? 'library.update' : 'library.install', { kind: item.kind, id: item.id, ...(item.kind === 'maps' ? { otherNames: (lists.maps || []).map((m) => m.name) } : {}) });
      queueState.set(key, { state: 'installed' });
      ok += 1;
    } catch (error) {
      queueState.set(key, { state: 'failed', message: describeError(error) });
    }
    if (token === generation) render();
  }
  queueRunning = false;
  clearCache();
  await fetchInstalled(true);
  for (const item of items) if (queueState.get(itemKey(item))?.state === 'installed') queue.delete(itemKey(item));
  for (const item of items) if (queueState.get(itemKey(item))?.state === 'installed' || !queue.has(itemKey(item))) queueState.delete(itemKey(item));
  const failed = items.length - ok;
  toast(failed ? ok + ' installed, ' + failed + ' failed' : (ok === 1 ? '1 item installed' : ok + ' items installed'), failed ? 'error' : 'success');
  if (token === generation) render(); else renderQueueBar();
}

function chooseKind(kind: Group): void {
  if (kind === state.kind && state.view !== 'uploads') return;
  state = { ...state, kind, view: GROUPS[kind].views.length === 1 ? GROUPS[kind].views[0] : null, show: 'all' };
  syncRoute();
}

function renderSummary(): void {
  if (!summary) return;
  summary.replaceChildren();
  if (state.sort === 'popular') summary.appendChild(h('span', { className: 'summary-hint', text: 'No popularity data yet, so Popular keeps the hub order.' }));
  if (state.q) summary.appendChild(h('span', { className: 'summary-search', text: 'Search: ' + state.q }));
}

/** Installed when this kind has anything installed, else Browse. Decided once the installed scan is in. */
function resolveView(): void {
  if (state.view || !installed) return;
  state.view = installedCount(state.kind) > 0 ? 'installed' : 'browse';
  lastList = { ...state };
  replace(baseRoute(state));
}

function render(): void {
  if (!page || !listHost) return;
  resolveView();
  const host = listHost;
  if (state.view === 'uploads') {
    // Your hub submissions, drawn by the account's own view.
    renderBar(0);
    summary?.replaceChildren();
    if (!uploads) uploads = uploadsView();
    if (uploads.element.parentNode !== host) host.replaceChildren(uploads.element);
    uploads.filter(state.q);
    return;
  }
  if (!state.view) {
    // Waiting for the installed scan to choose between Installed and Browse.
    renderBar(0);
    summary?.replaceChildren();
    host.replaceChildren(skeletonCards(8));
    return;
  }

  let items = modeItems().filter((item) => state.show === 'all' || item.kind === state.show);
  if (state.q) items = items.filter((item) => matchesQuery(item, state.q));
  items = sortItems(items, state.sort);
  renderBar(items.length);
  renderSummary();

  const loading = loadingNow();
  const nodes: Node[] = [];

  if (currentView() === 'browse') {
    for (const kind of groupKinds()) {
      const message = errors[kind];
      if (!message) continue;
      nodes.push(
        errorState(KIND_LABEL[kind] + 's could not be loaded (' + message + ').', () => {
          void fetchKind(kind, true).then(() => render());
          render();
        })
      );
    }
  } else if (installedError) {
    nodes.push(errorState('Your installed items could not be read (' + installedError + ').', () => void fetchInstalled(true)));
  }

  if (state.kind === 'skins' && state.view === 'installed' && !installedError) {
    // The skin picker: what you wear now, and every skin you have, one click to wear.
    if (!picker) picker = skinPicker();
    picker.update(items, loading);
    host.replaceChildren(...nodes, picker.element);
    return;
  }
  if (items.length > 0) {
    nodes.push(cardGrid(items, (item) => {
      const key = itemKey(item);
      if (!canQueue(item) && !queue.has(key)) return itemCard(item);
      return selectableCard(item, {
        key,
        selected: queue.has(key),
        canSelect: canQueue(item) && !queueRunning,
        state: queueState.get(key)?.state,
        message: queueState.get(key)?.message,
        onToggle: () => toggleQueued(item),
        onInstall: () => void runItems([item]),
        busy: queueRunning,
      });
    }, { minWidth: 220 }));
  } else if (loading) {
    nodes.push(skeletonCards(8));
  } else if (nodes.length === 0) {
    nodes.push(emptyForView());
  }
  host.replaceChildren(...nodes);
  renderQueueBar();
}

function emptyForView(): HTMLElement {
  if (state.q) {
    return emptyState('search', 'No matches', 'Nothing matches "' + state.q + '". Try fewer words.', {
      label: 'Clear search',
      kind: 'secondary',
      onClick: () => {
        state.q = '';
        setSearchText('');
        syncRoute();
      },
    });
  }
  if (state.view === 'updates') {
    return emptyState('check', "Everything's up to date", 'Nothing you have installed has a newer version on the hub.');
  }
  if (state.view === 'installed') {
    if (installed && !installed.game) {
      return emptyState('gamepad', 'IGTAP not found', 'Set the game location in Settings to see what is installed.', {
        label: 'Open settings',
        kind: 'secondary',
        onClick: () => go('#/settings'),
      });
    }
    return emptyState('download', 'Nothing installed here', GROUPS[state.kind].empty, {
      label: 'Browse ' + GROUPS[state.kind].label.toLowerCase(),
      kind: 'primary',
      onClick: () => {
        state.view = 'browse';
        syncRoute();
      },
    });
  }
  return emptyState('search', 'Nothing here yet', 'The hub has nothing of this kind right now.');
}

function lookup(kind: string, id: string): Item | null {
  const k = kind as Kind;
  const hubItem = (lists[k] || []).find((item) => item.id === id);
  if (hubItem) {
    const [annotated] = annotate([hubItem], installed, lists.maps || []);
    return annotated;
  }
  return installedItems(installed, lists).find((item) => item.kind === k && item.id === id) || null;
}

function detailOptions(): DetailOptions {
  return {
    gameFound: !installed || !!installed.game,
    otherNames: (lists.maps || []).map((item) => item.name),
    onChanged: (changed) => {
      // reload what is installed, then show the panel again with the new state
      clearCache();
      const token = generation;
      void Promise.all([fetchInstalled(true), fetchKind('mods', true), fetchKind('skins', true), fetchKind('maps', true), fetchKind(changed.kind, true)]).then(() => {
        if (token !== generation || !page) return;
        const fresh = lookup(changed.kind, changed.id);
        if (detail) detail.dispose();
        detail = fresh ? buildDetail(fresh, detailOptions()) : notFoundDetail(changed.kind, changed.id);
        page.setSidePanel(detail.element);
        render();
      });
    },
  };
}

async function showPanel(route: ParsedRoute, token: number): Promise<void> {
  if (!page) return;
  const kind = route.params.kind || '';
  const id = route.params.id || '';
  detail = loadingDetail();
  page.setSidePanel(detail.element);
  if (!(KINDS as string[]).includes(kind)) {
    detail = notFoundDetail(kind, id);
    page.setSidePanel(detail.element);
    return;
  }
  await Promise.all([fetchKind(kind as Kind, false), fetchInstalled(false), fetchKind('mods', false), fetchKind('skins', false), fetchKind('maps', false)]);
  if (token !== generation || !page) return;
  const item = lookup(kind, id);
  detail.dispose();
  detail = item ? buildDetail(item, detailOptions()) : notFoundDetail(kind, id);
  page.setSidePanel(detail.element);
}

let unsubscribe: (() => void) | null = null;

/** Esc empties the queue (unless a panel is open: Esc closes that first). */
function onQueueKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || queue.size === 0 || queueRunning || !page || page.classList.contains('has-panel')) return;
  if ((event.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
  clearQueue();
}

export const libraryPage: PageModule = {
  title: 'Library',

  async mount(el, route): Promise<void> {
    generation += 1;
    const token = generation;
    setItemBase('#/library');
    uploads = null;
    picker = null;
    painted.clear();
    state = readState(route, lastList);
    // #/library?view=uploads&upload=1 (or upload=<repo url>) opens the Upload form: used by tools/snap.sh to photograph it.
    if (route.query.upload && state.view === 'uploads') {
      const repo = route.query.upload === '1' ? undefined : route.query.upload;
      void sessionReady().then(() => startUpload({ repo }));
    }
    if (!route.isPanel) {
      lastList = { ...state };
      // Old content links (#/maps, #/create ...) open here; show the Library address.
      if (route.path !== '/library') replace(baseRoute(state));
    }
    lists = emptyLists();
    errors = {};
    pending = new Set();
    installed = null;
    installedError = '';
    for (const kind of KINDS) lists[kind] = peekKind(kind);
    installed = peekInstalled();
    detail = null;
    unsubscribe?.();
    unsubscribe = onHubChange((change) => {
      // a background refresh finished with different data: take it and redraw
      if (!page) return;
      if ('kind' in change) lists[change.kind] = peekKind(change.kind);
      else installed = peekInstalled();
      schedule();
    });

    const close = () => closePanel(baseRoute(state));
    kindHost = h('div', { className: 'kind-host' });
    filtersHost = h('div', { className: 'filter-line' });
    actionsHost = h('div', { className: 'bar-actions' });
    page = pageTemplate({
      title: 'Library',
      subtitle: route.isPanel ? 'Item details' : 'Your maps, mods, skins, games and backgrounds, and more from the hub.',
      onPanelClose: close,
      tabs: kindHost,
      filters: filtersHost,
    });
    summary = h('div', { className: 'library-summary' });
    listHost = h('div', { className: 'library-list' });
    page.content.appendChild(summary);
    queueBar = h('div', { className: 'queue-bar', attrs: { role: 'region', 'aria-label': 'Install queue' } });
    queueBar.hidden = true;
    page.content.appendChild(listHost);
    page.content.appendChild(queueBar);
    document.addEventListener('keydown', onQueueKey);
    el.appendChild(page);
    if (!route.isPanel) setSearchText(state.q);

    render();
    const load = loadAll(false);
    // An item panel counts as part of the page: it's ready once both the list and the panel have loaded.
    const panel = route.isPanel ? showPanel(route, token) : Promise.resolve();
    await Promise.race([Promise.all([load, panel]), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
    if (token !== generation) return;
    render();
    perfRouteData();
    await imagesSettled(el, 8000);
  },

  unmount(): void {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    window.clearTimeout(renderTimer);
    renderTimer = 0;
    if (detail) detail.dispose();
    detail = null;
    picker?.dispose();
    picker = null;
    uploads = null;
    setItemBase('#/library');
    painted.clear();
    document.removeEventListener('keydown', onQueueKey);
    queueBar = null;
    page = null;
    summary = null;
    listHost = null;
    filtersHost = null;
    kindHost = null;
    actionsHost = null;
  },

  saveState(): unknown {
    return { ...state };
  },

  restoreState(saved: unknown): void {
    if (!saved || typeof saved !== 'object' || !page) return;
    const value = saved as Partial<State>;
    state = {
      kind: typeof value.kind === 'string' && (GROUP_IDS as string[]).includes(value.kind) ? value.kind : state.kind,
      view: typeof value.view === 'string' ? value.view : state.view,
      show: typeof value.show === 'string' ? value.show : state.show,
      sort: typeof value.sort === 'string' ? (value.sort as Sort) : state.sort,
      q: typeof value.q === 'string' ? value.q : state.q,
    };
    lastList = { ...state };
    setSearchText(state.q);
    render();
  },

  filter(query: string): void {
    state.q = query;
    syncRoute();
  },
};

