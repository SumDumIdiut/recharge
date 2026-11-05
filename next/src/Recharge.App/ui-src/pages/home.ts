import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { call, describeError, type GameInfo } from '../bridge.js';
import { go } from '../navigation.js';
import { pageTemplate } from '../components/page.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { authorName, imagesSettled, itemMedia, KIND_ICON } from '../components/itemCard.js';
import { loadInstalled, loadKind, onHubChange } from '../lib/hub.js';
import { perfRouteData } from '../perf.js';
import {
  annotate, installedItems, isEmbeddedMod, itemRoute, KINDS, newestAcross, updatesOf,
  type Item, type Kind, type Lists,
} from '../lib/library.js';
import type { PageModule } from '../router.js';

let root: HTMLElement | null = null;
let gameRow: HTMLElement | null = null;
let filterNote: HTMLElement | null = null;
let noMatches: HTMLElement | null = null;
let newHost: HTMLElement | null = null;
let updatesHost: HTMLElement | null = null;
/** The cards' grid: the updates card joins it only when there is an update to show. */
let homeGrid: HTMLElement | null = null;
let generation = 0;

function paintGame(info: GameInfo | null, error?: unknown): void {
  if (!gameRow) return;
  clear(gameRow);
  gameRow.classList.remove('is-ok', 'is-missing');
  gameRow.appendChild(icon('gamepad', 18));
  if (info && info.path) {
    gameRow.classList.add('is-ok');
    const text = h('span', { className: 'game-text', text: 'Installed at ' + info.path });
    text.title = info.path;
    gameRow.appendChild(text);
    return;
  }
  gameRow.classList.add('is-missing');
  gameRow.appendChild(h('span', { className: 'game-text', text: 'IGTAP not found · ' }));
  const setLocation = h('button', {
    className: 'link-btn',
    text: 'Set location',
    attrs: { type: 'button' },
  });
  setLocation.addEventListener('click', () => go('#/settings'));
  gameRow.appendChild(setLocation);
  if (error) gameRow.title = describeError(error);
}

let playButtons: HTMLButtonElement[] = [];
let moddedButton: HTMLButtonElement | null = null;
let closeButton: HTMLButtonElement | null = null;
let launching = false;
let runningTimer = 0;
const RUNNING_POLL_MS = 3000;

interface RunningState { running: boolean; modded: boolean | null }

/** While IGTAP runs, Play and Play modded give way to one button that closes it (saying which build is running). */
function paintRunning(state: RunningState): void {
  if (!closeButton) return;
  for (const b of playButtons) b.hidden = state.running;
  closeButton.hidden = !state.running;
  const label = closeButton.querySelector('span');
  if (label) label.textContent = state.modded === null ? 'Close IGTAP' : state.modded ? 'Close IGTAP (modded)' : 'Close IGTAP (vanilla)';
}

function pollRunning(): void {
  call<RunningState>('game.running', {}).then(paintRunning, () => { /* the game wasn't found: the status row says so */ });
}

function closeGame(): void {
  if (!closeButton) return;
  closeButton.disabled = true;
  call<{ closed?: number }>('game.close', {}).then((reply) => {
    toast(reply && reply.closed ? 'IGTAP closed.' : 'IGTAP had already closed.', 'success');
  }, (error) => {
    toast('Could not close the game: ' + describeError(error), 'error');
  }).finally(() => {
    window.setTimeout(() => { if (closeButton) closeButton.disabled = false; pollRunning(); }, 1500);
  });
}

interface LoaderMode { modded: boolean; loader: string; canModded: boolean; detail: string }

/** Starts IGTAP with the vanilla or the modded build (game.launch switches the game folder to it first). */
function launch(modded: boolean): void {
  if (launching) return;
  launching = true;
  for (const b of playButtons) b.disabled = true;
  call<{ launched?: boolean; build?: string }>('game.launch', { modded }).then((reply) => {
    toast(reply && reply.launched === false ? 'The game is already running.' : 'Starting IGTAP ' + (modded ? 'modded' : 'vanilla') + '…', 'success');
    window.setTimeout(pollRunning, 2500);
  }, (error) => {
    toast('Could not start the game: ' + describeError(error), 'error');
  }).finally(() => {
    window.setTimeout(() => { launching = false; for (const b of playButtons) b.disabled = false; paintMode(); }, 4000);
  });
}

/** Play modded is only offered when a loader can provide the modded build; the reason shows on hover otherwise. */
function paintMode(): void {
  const target = moddedButton;
  if (!target) return;
  call<LoaderMode>('loader.mode', {}).then((mode) => {
    if (target !== moddedButton || launching) return;
    target.disabled = !mode.canModded;
    target.title = mode.canModded ? (mode.loader === 'legacy' ? 'Uses the loader the current Recharge app installed' : 'Starts the game with mods') : mode.detail;
  }, () => { /* the game wasn't found: the status row already says so */ });
}

function card(title: string, search: string, ...children: Node[]): HTMLElement {
  const node = h('section', { className: 'home-card panel', dataset: { search } });
  node.appendChild(h('h2', { className: 'panel-title', text: title }));
  for (const child of children) node.appendChild(child);
  return node;
}

export const homePage: PageModule = {
  title: 'Home',

  async mount(el): Promise<void> {
    const page = pageTemplate({
      title: 'Home',
    });
    root = page;

    const hero = h('section', { className: 'home-hero panel' });
    hero.appendChild(
      h('img', {
        className: 'hero-logo',
        attrs: { src: 'assets/logo.png', alt: 'Recharge logo' },
      })
    );
    const copy = h('div', { className: 'hero-copy' });
    const actions = h('div', { className: 'hero-actions' });
    const vanilla = button('Play', { kind: 'primary', icon: 'play', title: 'Starts the game without mods', onClick: () => launch(false) });
    const modded = button('Play modded', { kind: 'secondary', icon: 'sparkles', title: 'Starts the game with mods', onClick: () => launch(true) });
    playButtons = [vanilla, modded];
    moddedButton = modded;
    const close = button('Close IGTAP', { kind: 'danger', icon: 'x', title: 'Closes the running game', onClick: closeGame });
    close.hidden = true;
    closeButton = close;
    actions.append(vanilla, modded, close);
    paintMode();
    pollRunning();
    window.clearInterval(runningTimer);
    runningTimer = window.setInterval(pollRunning, RUNNING_POLL_MS);
    copy.appendChild(actions);

    gameRow = h('div', { className: 'game-status', attrs: { role: 'status' } });
    gameRow.appendChild(icon('gamepad', 18));
    gameRow.appendChild(h('span', { className: 'game-text', text: 'Looking for IGTAP…' }));
    copy.appendChild(gameRow);
    hero.appendChild(copy);
    page.content.appendChild(hero);

    filterNote = h('p', { className: 'filter-note', hidden: true });
    page.content.appendChild(filterNote);
    noMatches = h('div', { className: 'no-matches', hidden: true });
    noMatches.appendChild(icon('search', 22));
    noMatches.appendChild(h('span', { text: 'Nothing on this page matches that search.' }));
    page.content.appendChild(noMatches);

    const grid = (homeGrid = h('div', { className: 'home-grid' }));
    newHost = card('New on the hub', 'new on the hub newest recent items');
    updatesHost = card('Updates available', 'updates available installed library refresh');
    newHost.classList.add('home-card-wide');
    newHost.appendChild(loadingRow());
    grid.appendChild(newHost);
    page.content.appendChild(grid);

    el.appendChild(page);
    const token = ++generation;
    unsubscribe?.();
    unsubscribe = onHubChange(() => { if (token === generation) void loadData(token); });
    await Promise.race([Promise.all([loadGame(), loadData(token)]), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
    if (token === generation) perfRouteData();
    if (token === generation) await imagesSettled(el, 8000);
  },

  unmount(): void {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    root = null;
    newHost = updatesHost = homeGrid = null;
    gameRow = null;
    playButtons = [];
    moddedButton = null;
    closeButton = null;
    window.clearInterval(runningTimer);
    runningTimer = 0;
    filterNote = null;
    noMatches = null;
  },

  filter(query: string): void {
    if (!root) return;
    const term = query.trim().toLowerCase();
    const cards = Array.from(root.querySelectorAll('.home-card')) as HTMLElement[];
    let shown = 0;
    for (const cardNode of cards) {
      const text = (cardNode.dataset.search || '') + ' ' + (cardNode.textContent || '');
      const visible = !term || text.toLowerCase().includes(term);
      cardNode.hidden = !visible;
      if (visible) shown += 1;
    }
    if (filterNote) {
      filterNote.hidden = !term;
      filterNote.textContent = term ? 'Filtering this page for “' + query + '”.' : '';
    }
    if (noMatches) noMatches.hidden = !term || shown > 0;
  },
};

let unsubscribe: (() => void) | null = null;

async function loadGame(): Promise<void> {
  try {
    const info = await call<GameInfo>('game.find');
    paintGame(info);
  } catch (error) {
    paintGame({ path: null }, error);
  }
}

function loadingRow(): HTMLElement {
  return h('p', { className: 'dim', text: 'Loading…' });
}

function miniRow(item: Item, sub: string): HTMLElement {
  const row = h('a', { className: 'mini-row', attrs: { href: itemRoute(item) } });
  const badge = h('span', { className: 'mini-icon kind-' + item.kind });
  badge.appendChild(icon(KIND_ICON[item.kind], 18));
  row.appendChild(badge);
  const text = h('span', { className: 'mini-text' });
  text.appendChild(h('span', { className: 'mini-name', text: item.name }));
  text.appendChild(h('span', { className: 'mini-sub', text: sub }));
  row.appendChild(text);
  return row;
}

function fillCard(host: HTMLElement | null, ...nodes: Node[]): void {
  if (!host) return;
  const title = host.querySelector('.panel-title');
  host.replaceChildren(...(title ? [title] : []), ...nodes);
}

/** A New-on-the-hub tile: the item's picture, then its name, creator and a two-line description. The card is full
 *  width and the tiles sit four per row, two rows of them (8), so the card stays compact. */
function hubTile(item: Item): HTMLElement {
  const tile = h('a', {
    className: 'hub-tile',
    attrs: { href: itemRoute(item), 'aria-label': item.name },
  });
  tile.appendChild(itemMedia(item));
  const body = h('div', { className: 'hub-tile-body' });
  body.appendChild(h('div', { className: 'hub-tile-name', text: item.name, title: item.name }));
  if (item.author) body.appendChild(authorName(item.author, item.color, 'hub-tile-author'));
  if (item.description) body.appendChild(h('p', { className: 'hub-tile-desc', text: item.description, title: item.description }));
  tile.appendChild(body);
  return tile;
}

async function loadData(token: number): Promise<void> {
  const lists = { maps: null, mods: null, skins: null, backgrounds: null, playlists: null, games: null } as Lists;
  const failed: Kind[] = [];
  let installed = null as Awaited<ReturnType<typeof loadInstalled>> | null;
  await Promise.all([
    loadInstalled(false).then((data) => { installed = data; }, (error) => console.error('installed scan failed: ' + describeError(error))),
    ...KINDS.map((kind) =>
      loadKind(kind, false).then(
        (items) => { lists[kind] = items; },
        (error) => { failed.push(kind); console.error('hub list ' + kind + ' failed: ' + describeError(error)); }
      )
    ),
  ]);
  if (token !== generation) return;

  const mine = installedItems(installed, lists);

  const annotated = {} as Lists;
  for (const kind of KINDS) annotated[kind] = lists[kind] ? annotate((lists[kind] as Item[]).filter((item) => !isEmbeddedMod(item)), installed) : null;
  // Two rows of the four-column grid, so the card stays compact.
  const fresh = newestAcross(annotated, 8);
  if (fresh.length > 0) {
    const tiles = h('div', { className: 'hub-tile-grid' });
    for (const item of fresh) tiles.appendChild(hubTile(item));
    fillCard(newHost, tiles);
  } else if (failed.length > 0) {
    fillCard(newHost, errorState('The hub could not be reached, so there is nothing new to show.', () => { void loadData(generation); }));
  } else {
    fillCard(newHost, emptyState('sparkles', 'Nothing yet', 'New items from the hub will show up here.'));
  }

  const updates = updatesOf(mine);
  if (updates.length > 0) {
    const head = h('p', { className: 'updates-count' }, h('strong', { text: String(updates.length) }), updates.length === 1 ? ' update available' : ' updates available');
    const more = h('a', { className: 'link-btn', attrs: { href: '#/library?mode=updates' }, text: 'See all updates' });
    fillCard(updatesHost, head, ...updates.slice(0, 3).map((item) => miniRow(item, item.kind === 'maps' ? 'Revision ' + (item.installed?.revision ?? '?') + ' → ' + item.revision : (item.installed?.version || '?') + ' → ' + item.version)), more);
    if (updatesHost && homeGrid && !updatesHost.isConnected) homeGrid.appendChild(updatesHost);
  }
}
