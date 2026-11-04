import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { buildRoute, SCOPES, type PageModule, type ParsedRoute, type Query, type Scope } from '../router.js';
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
import { itemCard, imagesSettled } from '../components/itemCard.js';
import { toast } from '../components/toast.js';
import { uploadsView } from '../account/uploads.js';
import { skinPicker } from '../skins/picker.js';
import { buildDetail, loadingDetail, notFoundDetail, type Detail, type DetailOptions } from '../components/detail.js';
import { clearCache, loadInstalled, loadKind, peekInstalled, peekKind } from '../lib/hub.js';
import {
  annotate, countByKind, installedItems, KINDS, KIND_LABEL, isEmbeddedMod, matchesQuery, setItemBase, SORTS, sortItems, updatesOf,
  type InstalledData, type Item, type Kind, type Lists, type Mode, type Sort,
} from '../lib/library.js';

/** The Library's own tabs add Uploads; the content pages use Installed, Discover and Updates. */
type PageMode = Mode | 'uploads';
type State = { kind: Kind | 'all'; mode: PageMode; sort: Sort; q: string };

interface ScopeInfo { title: string; subtitle: string; kinds: Kind[]; modes: PageMode[]; more: string; empty: string }
const SCOPE_INFO: Record<Scope, ScopeInfo> = {
  maps: { title: 'Maps', subtitle: 'The maps you have, and more from the hub.', kinds: ['maps'], modes: ['installed', 'discover', 'updates'], more: 'Get maps', empty: 'Maps you install show up here.' },
  mods: { title: 'Mods', subtitle: 'Mods you have installed, and more from the hub.', kinds: ['mods'], modes: ['installed', 'discover', 'updates'], more: 'Get mods', empty: 'Mods you install show up here.' },
  skins: { title: 'Skins', subtitle: 'Pick what you wear in the game.', kinds: ['skins'], modes: ['installed', 'discover', 'updates'], more: 'Get skins', empty: 'Skins you install show up here.' },
  games: { title: 'Games', subtitle: 'Games made with and for IGTAP.', kinds: ['games'], modes: ['discover'], more: 'Browse', empty: '' },
  backgrounds: { title: 'Backgrounds', subtitle: 'Menu backgrounds and playlists.', kinds: ['backgrounds', 'playlists'], modes: ['installed', 'discover', 'updates'], more: 'Get backgrounds', empty: 'Backgrounds and playlists you install show up here.' },
};
const LIBRARY_MODES: PageMode[] = ['discover', 'updates', 'uploads'];

/** The content page shown, or null for the Library itself. */
let scope: Scope | null = null;
let uploads: { element: HTMLElement; ready: Promise<void>; filter(query: string): void } | null = null;
let picker: { element: HTMLElement; update(items: Item[], loading: boolean): void; dispose(): void } | null = null;

function scopeKinds(): Kind[] { return scope ? SCOPE_INFO[scope].kinds : KINDS; }
function pageModes(): PageMode[] { return scope ? SCOPE_INFO[scope].modes : LIBRARY_MODES; }
function pagePath(): string { return '/' + (scope ?? 'library'); }

const SORT_LABEL: Record<Sort, string> = {
  new: 'Newest',
  updated: 'Recently updated',
  name: 'Name A–Z',
  popular: 'Popular',
};

const KIND_CHIPS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'maps', label: 'Maps' },
  { value: 'mods', label: 'Mods' },
  { value: 'skins', label: 'Skins' },
  { value: 'backgrounds', label: 'Backgrounds' },
  { value: 'playlists', label: 'Playlists' },
  { value: 'games', label: 'Games' },
];

const DEFAULT_STATE: State = { kind: 'all', mode: 'discover', sort: 'new', q: '' };

function defaultState(): State { return { ...DEFAULT_STATE, mode: pageModes()[0] }; }

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

let filtersHost: HTMLElement | null = null;
let summary: HTMLElement | null = null;
let listHost: HTMLElement | null = null;
let detail: Detail | null = null;
let renderTimer = 0;

function emptyLists(): Lists {
  return { maps: null, mods: null, skins: null, backgrounds: null, playlists: null, games: null };
}

export function readState(route: ParsedRoute, fallback: State): State {
  const base = route.isPanel ? fallback : defaultState();
  const kind = route.query.kind || base.kind;
  const mode = route.query.mode || base.mode;
  const sort = route.query.sort || base.sort;
  return {
    kind: kind === 'all' || (scopeKinds() as string[]).includes(kind) ? (kind as State['kind']) : 'all',
    mode: (pageModes() as string[]).includes(mode) ? (mode as PageMode) : pageModes()[0],
    sort: (SORTS as string[]).includes(sort) ? (sort as Sort) : 'new',
    q: route.isPanel ? base.q : route.query.q || '',
  };
}

function queryFor(value: State): Query {
  const query: Query = { kind: value.kind, mode: value.mode, sort: value.sort };
  if (value.q) query.q = value.q;
  return query;
}

function baseRoute(value: State): string {
  return buildRoute(pagePath(), queryFor(value));
}

function selectedKinds(): Kind[] {
  return state.kind === 'all' ? scopeKinds() : [state.kind];
}

/** Items for the current mode, before search and sort. */
function modeItems(): Item[] {
  const withStatus: Lists = emptyLists();
  for (const kind of KINDS) withStatus[kind] = lists[kind] ? annotate(lists[kind] as Item[], installed) : null;
  const kinds = scopeKinds();
  if (state.mode === 'discover') {
    const out: Item[] = [];
    for (const kind of kinds) for (const item of withStatus[kind] || []) if (!isEmbeddedMod(item)) out.push(item);
    return out;
  }
  const mine = installedItems(installed, lists).filter((item) => kinds.includes(item.kind));
  return state.mode === 'updates' ? updatesOf(mine) : mine;
}

function loadingNow(): boolean {
  if (state.mode === 'discover') return selectedKinds().some((kind) => pending.has(kind));
  return pending.has('installed') || pending.has('mods') || pending.has('maps') || pending.has('skins') || pending.has('backgrounds') || pending.has('playlists');
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

function renderFilters(counts: Record<string, number>): void {
  if (!filtersHost) return;
  if (state.mode === 'uploads') { filtersHost.replaceChildren(); return; }
  const kinds = scopeKinds() as string[];
  const shown = KIND_CHIPS.filter((chip) => chip.value === 'all' || kinds.includes(chip.value));
  filtersHost.replaceChildren(
    shown.length > 2 ? chips(
      shown.map((chip) => ({ ...chip, count: counts[chip.value] })),
      {
        value: state.kind,
        onChange: (value) => {
          state.kind = value as State['kind'];
          syncRoute();
        },
      }
    ) : h('span'),
    h('div', { className: 'filter-spacer' }),
    selectControl(
      SORTS.map((sort) => ({ value: sort, label: SORT_LABEL[sort] })),
      {
        label: 'Sort',
        value: state.sort,
        onChange: (value) => {
          state.sort = value as Sort;
          syncRoute();
        },
      }
    )
  );
}

function renderSummary(shown: number): void {
  if (!summary) return;
  summary.replaceChildren();
  const part = (text: string, className = '') => summary?.appendChild(h('span', { className, text }));
  const sep = () => part('·', 'summary-sep');
  part(shown + (shown === 1 ? ' item' : ' items'), 'summary-strong');
  sep();
  if (!scope || scope === 'backgrounds') part(state.kind === 'all' ? (scope ? 'Backgrounds and playlists' : 'All kinds') : KIND_LABEL[state.kind] + 's');
  else part(SCOPE_INFO[scope].title);
  sep();
  part(modeLabel(state.mode));
  sep();
  part(SORT_LABEL[state.sort]);
  if (state.sort === 'popular') part('(no popularity data yet)', 'summary-hint');
  if (state.q) {
    sep();
    part('Search: ' + state.q, 'summary-search');
  }
}

function modeLabel(mode: PageMode): string {
  if (mode === 'discover' && scope) return SCOPE_INFO[scope].more;
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function render(): void {
  if (!page || !listHost) return;
  const host = listHost;
  if (state.mode === 'uploads') {
    // Your hub submissions (what used to be Create → Uploads), drawn by the account's own view.
    renderFilters({});
    summary?.replaceChildren();
    if (!uploads) uploads = uploadsView();
    if (uploads.element.parentNode !== host) host.replaceChildren(uploads.element);
    uploads.filter(state.q);
    return;
  }

  // Counts for the chips, for the current mode.
  const all = modeItems();
  const counts = countByKind(all) as unknown as Record<string, number>;
  renderFilters(counts);

  let items = all.filter((item) => state.kind === 'all' || item.kind === state.kind);
  if (state.q) items = items.filter((item) => matchesQuery(item, state.q));
  items = sortItems(items, state.sort);
  renderSummary(items.length);

  const loading = loadingNow();
  const nodes: Node[] = [];

  if (state.mode === 'discover') {
    for (const kind of selectedKinds()) {
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

  if (scope === 'skins' && state.mode === 'installed' && !installedError) {
    // The skin picker: what you wear now, and every skin you have, one click to wear.
    if (!picker) picker = skinPicker();
    picker.update(items, loading);
    host.replaceChildren(...nodes, picker.element);
    return;
  }
  if (items.length > 0) {
    nodes.push(cardGrid(items, (item) => itemCard(item), { minWidth: 220 }));
  } else if (loading) {
    nodes.push(skeletonCards(8));
  } else if (nodes.length === 0) {
    nodes.push(emptyForMode());
  }
  host.replaceChildren(...nodes);
}

function emptyForMode(): HTMLElement {
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
  if (state.mode === 'updates') {
    return emptyState('check', "Everything's up to date", 'Nothing you have installed has a newer version on the hub.');
  }
  if (state.mode === 'installed') {
    if (installed && !installed.game) {
      return emptyState('gamepad', 'IGTAP not found', 'Set the game location in Settings to see what is installed.', {
        label: 'Open settings',
        kind: 'secondary',
        onClick: () => go('#/settings'),
      });
    }
    const more = scope && pageModes().includes('discover') ? { label: SCOPE_INFO[scope].more, kind: 'primary' as const, onClick: () => go(buildRoute(pagePath(), queryFor({ ...state, mode: 'discover' }))) } : undefined;
    return emptyState('download', 'Nothing installed here', scope ? SCOPE_INFO[scope].empty : 'Items you install will show up in this list.', more);
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

export const libraryPage: PageModule = {
  title: 'Library',

  async mount(el, route): Promise<void> {
    generation += 1;
    const token = generation;
    const nextScope = (SCOPES as readonly string[]).includes(route.params.scope || '') ? (route.params.scope as Scope) : null;
    const changed = nextScope !== scope;
    scope = nextScope;
    if (changed) lastList = defaultState();
    setItemBase('#' + pagePath());
    uploads = null;
    picker = null;
    state = readState(route, lastList);
    if (!route.isPanel) lastList = { ...state };
    lists = emptyLists();
    errors = {};
    pending = new Set();
    installed = null;
    installedError = '';
    for (const kind of KINDS) lists[kind] = peekKind(kind);
    installed = peekInstalled();
    detail = null;

    const close = () => closePanel(baseRoute(state));
    const info = scope ? SCOPE_INFO[scope] : null;
    const tabLabels: Record<PageMode, { label: string; icon: string }> = {
      discover: { label: info ? info.more : 'Discover', icon: 'sparkles' },
      installed: { label: 'Installed', icon: 'download' },
      updates: { label: 'Updates', icon: 'refresh' },
      uploads: { label: 'Your uploads', icon: 'package' },
    };
    const extra: HTMLElement[] = [];
    if (scope === 'maps') {
      // Making and editing maps comes back with the Amplifier.
      extra.push(button('New map', { kind: 'primary', icon: 'plus', title: 'The Amplifier is coming soon', onClick: () => toast('Making maps in Recharge is coming soon.', 'info') }));
    }
    page = pageTemplate({
      title: info ? info.title : 'Library',
      subtitle: route.isPanel ? 'Item details' : info ? info.subtitle : 'Browse everything on the hub, and what you have uploaded.',
      onPanelClose: close,
      actions: [
        ...extra,
        button('Refresh', {
          kind: 'secondary',
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
      ],
      tabs: pageModes().length < 2 ? undefined : tabs(
        pageModes().map((mode) => ({ value: mode, ...tabLabels[mode] })),
        {
          value: state.mode,
          onChange: (value) => {
            state.mode = value as PageMode;
            syncRoute();
          },
        }
      ),
      filters: (filtersHost = h('div', { className: 'filter-line' })),
    });
    summary = h('div', { className: 'library-summary' });
    listHost = h('div', { className: 'library-list' });
    page.content.appendChild(summary);
    page.content.appendChild(listHost);
    el.appendChild(page);
    if (!route.isPanel) setSearchText(state.q);

    render();
    const load = loadAll(false);
    // An item panel counts as part of the page: it's ready once both the list and the panel have loaded.
    const panel = route.isPanel ? showPanel(route, token) : Promise.resolve();
    await Promise.race([Promise.all([load, panel]), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
    if (token !== generation) return;
    render();
    await imagesSettled(el, 8000);
  },

  unmount(): void {
    generation += 1;
    window.clearTimeout(renderTimer);
    renderTimer = 0;
    if (detail) detail.dispose();
    detail = null;
    picker?.dispose();
    picker = null;
    uploads = null;
    setItemBase('#/library');
    page = null;
    summary = null;
    listHost = null;
    filtersHost = null;
  },

  saveState(): unknown {
    return { ...state };
  },

  restoreState(saved: unknown): void {
    if (!saved || typeof saved !== 'object' || !page) return;
    const value = saved as Partial<State>;
    state = {
      kind: typeof value.kind === 'string' ? (value.kind as State['kind']) : state.kind,
      mode: typeof value.mode === 'string' && (pageModes() as string[]).includes(value.mode) ? (value.mode as PageMode) : state.mode,
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

