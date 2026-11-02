import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { call, describeError, type GameInfo } from '../bridge.js';
import { go } from '../navigation.js';
import { pageTemplate } from '../components/page.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { itemCard, imagesSettled, KIND_ICON } from '../components/itemCard.js';
import { cardGrid } from '../components/cardGrid.js';
import { loadInstalled, loadKind } from '../lib/hub.js';
import {
  annotate, installedItems, isEmbeddedMod, itemRoute, KINDS, newestAcross, updatesOf,
  type Item, type Kind, type Lists,
} from '../lib/library.js';
import type { PageModule } from '../router.js';

let root: HTMLElement | null = null;
let gameRow: HTMLElement | null = null;
let filterNote: HTMLElement | null = null;
let noMatches: HTMLElement | null = null;
let continueHost: HTMLElement | null = null;
let updatesHost: HTMLElement | null = null;
let newHost: HTMLElement | null = null;
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
let launching = false;

interface LoaderMode { modded: boolean; loader: string; canModded: boolean; detail: string }

/** Starts IGTAP with the vanilla or the modded build (game.launch switches the game folder to it first). */
function launch(modded: boolean): void {
  if (launching) return;
  launching = true;
  for (const b of playButtons) b.disabled = true;
  call<{ launched?: boolean; build?: string }>('game.launch', { modded }).then((reply) => {
    toast(reply && reply.launched === false ? 'The game is already running.' : 'Starting IGTAP ' + (modded ? 'modded' : 'vanilla') + '…', 'success');
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
    actions.appendChild(vanilla);
    actions.appendChild(modded);
    paintMode();
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

    const grid = h('div', { className: 'home-grid' });
    continueHost = card('Your maps', 'your installed maps');
    updatesHost = card('Updates available', 'updates available installed library refresh');
    newHost = card('New on the hub', 'new on the hub newest recent items');
    newHost.classList.add('home-card-wide');
    for (const host of [continueHost, newHost]) host.appendChild(loadingRow());
    grid.appendChild(continueHost);
    grid.appendChild(newHost);
    page.content.appendChild(grid);

    el.appendChild(page);
    const token = ++generation;
    await Promise.race([Promise.all([loadGame(), loadData(token)]), new Promise((resolve) => window.setTimeout(resolve, 15000))]);
    if (token === generation) await imagesSettled(el, 8000);
  },

  unmount(): void {
    generation += 1;
    root = null;
    continueHost = updatesHost = newHost = null;
    gameRow = null;
    playButtons = [];
    moddedButton = null;
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
  const myMaps = mine.filter((item) => item.kind === 'maps');
  if (myMaps.length > 0) {
    fillCard(continueHost, ...myMaps.map((item) => miniRow(item, item.local ? 'Local map' : 'Map · rev ' + (item.installed?.revision ?? '?'))));
  } else {
    fillCard(continueHost, emptyState('clock', 'No maps yet', 'Install maps from the Library to play them here.', {
      label: 'Browse library', kind: 'secondary', onClick: () => go('#/library'),
    }));
  }

  const updates = updatesOf(mine);
  if (updates.length > 0) {
    const head = h('p', { className: 'updates-count' }, h('strong', { text: String(updates.length) }), updates.length === 1 ? ' update available' : ' updates available');
    const more = h('a', { className: 'link-btn', attrs: { href: '#/library?mode=updates' }, text: 'See all updates' });
    fillCard(updatesHost, head, ...updates.slice(0, 3).map((item) => miniRow(item, item.kind === 'maps' ? 'Revision ' + (item.installed?.revision ?? '?') + ' → ' + item.revision : (item.installed?.version || '?') + ' → ' + item.version)), more);
    grid.appendChild(updatesHost);
  }

  const annotated = {} as Lists;
  for (const kind of KINDS) annotated[kind] = lists[kind] ? annotate((lists[kind] as Item[]).filter((item) => !isEmbeddedMod(item)), installed) : null;
  const fresh = newestAcross(annotated, 6);
  if (fresh.length > 0) {
    fillCard(newHost, cardGrid(fresh, (item) => itemCard(item), { minWidth: 180 }));
  } else if (failed.length > 0) {
    fillCard(newHost, errorState("The hub couldn't be reached.", () => { void loadData(token); }));
  } else {
    fillCard(newHost, emptyState('sparkles', 'Nothing yet', 'New items from the hub will show up here.'));
  }
}
