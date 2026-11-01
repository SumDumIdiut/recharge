import { h } from '../dom.js';
import { icon } from '../icons.js';
import type { PageModule } from '../router.js';
import { pageTemplate, type PageTemplateElement } from '../components/page.js';
import { chips } from '../components/chips.js';
import { button } from '../components/button.js';
import { skeletonCards } from '../components/skeleton.js';
import { cardGrid } from '../components/cardGrid.js';
import { emptyState } from '../components/emptyState.js';
import { loadInstalled, loadKind } from '../lib/hub.js';
import type { InstalledData, Item } from '../lib/library.js';
import { cardData, filterLobbies, sortLobbies, signature, ago, NO_FILTERS, type Lobby, type LobbyFilters, type LobbyReply } from '../lobbies/model.js';
import { LobbyPoller, joinLobby } from '../lobbies/service.js';
import { lobbyCard } from '../lobbies/card.js';
import { openHostDialog } from '../lobbies/host.js';

let filters: LobbyFilters = { ...NO_FILTERS };
let page: PageTemplateElement | null = null;
let poller: LobbyPoller | null = null;
let statusEl: HTMLElement | null = null;
let ageTimer = 0;
let searchBox: HTMLInputElement | null = null;

let lobbies: Lobby[] = [];
let lastSig = '';
let loaded = false;
let failure = '';
let lastOk = 0;
let hubMaps: Item[] | null = null;
let installed: InstalledData | null = null;
let paintedKey = '';

function ensureStyles(): Promise<void> {
  const href = 'lobbies/lobbies.css';
  if (document.querySelector('link[data-lobbies]')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.lobbies = '1';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

function paintStatus(): void {
  if (!statusEl) return;
  statusEl.replaceChildren();
  const dot = h('span', { className: 'live-dot' });
  let label: string;
  if (failure) { dot.classList.add('is-bad'); label = 'Not connected'; }
  else if (!loaded) { label = 'Connecting…'; }
  else { dot.classList.add('is-live'); label = 'Live · updated ' + ago(Date.now() - lastOk); }
  statusEl.appendChild(dot);
  statusEl.appendChild(h('span', { text: label }));
}

function listState(): 'loading' | 'error' | 'ready' {
  if (failure) return 'error';
  return loaded ? 'ready' : 'loading';
}

function render(force = false): void {
  if (!page) return;
  const state = listState();
  const shown = sortLobbies(filterLobbies(lobbies, filters));
  const key = state + '|' + failure + '|' + signature(shown) + '|' + (hubMaps ? hubMaps.length : -1) + '|' + (installed ? 'i' : '-') + '|' + lobbies.length;
  if (!force && key === paintedKey) { paintStatus(); return; }
  paintedKey = key;
  paintStatus();

  if (state === 'loading') { page.content.replaceChildren(skeletonCards(6)); return; }
  if (state === 'error') {
    const box = emptyState('alert', "Can't reach the lobby server", failure, {
      label: 'Try again',
      kind: 'secondary',
      onClick: () => { failure = ''; loaded = false; render(true); poller?.refresh(); },
    });
    box.classList.add('error-state');
    page.content.replaceChildren(box);
    return;
  }
  if (lobbies.length === 0) {
    page.content.replaceChildren(emptyState('users', "No one's playing right now", 'Lobbies show up here the moment someone hosts one.', {
      label: 'Host a lobby', kind: 'primary', onClick: () => openHostDialog(installed),
    }));
    return;
  }
  if (shown.length === 0) {
    page.content.replaceChildren(emptyState('search', 'No lobbies match', 'Try a different search, or clear the filters.', {
      label: 'Clear filters', kind: 'secondary', onClick: () => { filters = { ...NO_FILTERS }; if (searchBox) searchBox.value = ''; paintFilters(); render(true); },
    }));
    return;
  }
  const summary = h('p', { className: 'lobbies-note', text: shown.length === lobbies.length ? shown.length + (shown.length === 1 ? ' lobby' : ' lobbies') : shown.length + ' of ' + lobbies.length + ' lobbies' });
  const grid = cardGrid(shown, (lobby) => lobbyCard(cardData(lobby, hubMaps, installed), (data, done) => { void joinLobby(data.id).then(done); }), { minWidth: 300 });
  page.content.replaceChildren(summary, grid);
}

let filterHost: HTMLElement | null = null;

function paintFilters(): void {
  if (!filterHost) return;
  filterHost.replaceChildren();
  const search = h('input', {
    className: 'lobby-search',
    attrs: { type: 'search', placeholder: 'Search lobbies', 'aria-label': 'Search lobbies' },
  }) as HTMLInputElement;
  search.value = filters.q;
  search.addEventListener('input', () => { filters = { ...filters, q: search.value.trim() }; render(); });
  searchBox = search;
  filterHost.appendChild(search);
  const values = [filters.hasMap ? 'hasMap' : '', filters.notHard ? 'notHard' : ''].filter(Boolean);
  filterHost.appendChild(chips(
    [{ value: 'hasMap', label: 'Has map' }, { value: 'notHard', label: 'Not hard' }],
    { multi: true, values, onChange: (_v, all) => { filters = { ...filters, hasMap: all.includes('hasMap'), notHard: all.includes('notHard') }; render(); } },
  ));
}

function loadSupport(): Promise<unknown> {
  return Promise.all([
    loadKind('maps').then((items) => { hubMaps = items; render(); }, () => { /* cards still show the lobby's own map name */ }),
    loadInstalled().then((data) => { installed = data; render(); }, () => { /* unknown install state: the map shows as not installed */ }),
  ]);
}

const within = (ms: number, work: Promise<unknown>): Promise<unknown> =>
  Promise.race([work, new Promise((resolve) => window.setTimeout(resolve, ms))]);

/** Resolves when the cards' pictures have loaded (or failed), up to ms. */
function picturesSettled(root: HTMLElement, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const waiting = Array.from(root.querySelectorAll('.lobby-card img')).some(
        (image) => ((image.getAttribute('src') || (image as HTMLElement).dataset.src) && !(image as HTMLImageElement).complete && !image.classList.contains('is-broken')));
      if (!waiting || Date.now() - started > ms) resolve();
      else window.setTimeout(tick, 100);
    };
    window.setTimeout(tick, 150);
  });
}

export const lobbiesPage: PageModule = {
  title: 'Lobbies',
  async mount(el, route): Promise<void> {
    await ensureStyles();
    lobbies = []; lastSig = ''; loaded = false; failure = ''; lastOk = 0; paintedKey = '';
    statusEl = h('div', { className: 'lobbies-status', attrs: { role: 'status' } });
    filterHost = h('div', { className: 'filter-line' });
    const refresh = button('Refresh', { kind: 'ghost', icon: 'refresh', onClick: () => poller?.refresh() });
    const host = button('Host', { kind: 'primary', icon: 'plus', onClick: () => openHostDialog(installed) });
    page = pageTemplate({
      title: 'Lobbies',
      subtitle: 'Who is playing DOTnet right now.',
      actions: [statusEl, refresh, host],
      filters: filterHost,
    });
    paintFilters();
    el.appendChild(page);
    render(true);
    const support = loadSupport();
    let firstReply: () => void = () => {};
    const first = new Promise<void>((resolve) => { firstReply = resolve; });

    poller = new LobbyPoller({
      onReply(reply: LobbyReply) {
        if (reply.error) { failure = reply.error; render(); firstReply(); return; }
        failure = '';
        loaded = true;
        lastOk = Date.now();
        const sig = signature(reply.lobbies);
        lobbies = reply.lobbies;
        if (sig !== lastSig) { lastSig = sig; hubMapsRefreshIfNew(); }
        render();
        firstReply();
      },
      onFailure(message: string) { failure = message; render(); firstReply(); },
    });
    poller.start();
    ageTimer = window.setInterval(paintStatus, 1000);
    // Hold the page ready until the first answer, the hub maps and their pictures are in (each capped), so it opens complete.
    await within(4000, Promise.all([first, support]));
    await picturesSettled(el, 3000);
    // #/lobbies?host=1 opens the host dialog (links, snapshots); host=menu also opens its map list.
    const hostQuery = route.query.host;
    if (hostQuery) {
      openHostDialog(installed);
      if (hostQuery === 'menu') window.setTimeout(() => document.querySelector<HTMLElement>('.host-form .dd-trigger')?.click(), 50);
    }
  },
  unmount(): void {
    poller?.stop();
    poller = null;
    window.clearInterval(ageTimer);
    page = null; statusEl = null; filterHost = null; searchBox = null;
  },
  filter(query: string): void {
    filters = { ...filters, q: query };
    if (searchBox && searchBox.value !== query) searchBox.value = query;
    render();
  },
};

/** A new lobby may point at a map newer than the cached hub list. */
function hubMapsRefreshIfNew(): void {
  if (!hubMaps) return;
  const unknown = lobbies.some((l) => l.mapHubId && !hubMaps!.some((m) => m.id === l.mapHubId));
  if (unknown) loadKind('maps').then((items) => { hubMaps = items; render(); }, () => {});
}
