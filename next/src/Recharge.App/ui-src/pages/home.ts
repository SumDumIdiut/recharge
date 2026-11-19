import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { call, describeError, type GameInfo } from '../bridge.js';
import { go } from '../navigation.js';
import { pageTemplate } from '../components/page.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { authorName, imagesSettled, itemMedia, KIND_ICON } from '../components/itemCard.js';
import { invalidateInstalled, loadInstalled, loadKind, onHubChange } from '../lib/hub.js';
import { safeHref } from '../community/format.js';
import { perfRouteData } from '../perf.js';
import {
  annotate, installedItems, isEmbeddedMod, itemRoute, KINDS, newestAcross, updatesOf,
  type Item, type Kind, type Lists,
} from '../lib/library.js';
import type { PageModule } from '../router.js';

let root: HTMLElement | null = null;

/** Flipped's Patreon (the one the current app's home page links). */
const PATREON_URL = 'https://www.patreon.com/c/FlippedRecharger';

/** The official Patreon mark: a circle and the bar, filled, in the button's colour. */
function patreonGlyph(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 569 546');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shapes: Array<[string, Record<string, string>]> = [
    ['circle', { cx: '362.59', cy: '204.59', r: '204.59' }],
    ['rect', { width: '100', height: '545.8' }],
  ];
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(ns, tag);
    for (const [attribute, value] of Object.entries(attrs)) node.setAttribute(attribute, value);
    node.setAttribute('fill', 'currentColor');
    svg.appendChild(node);
  }
  return svg;
}

/** Flipped's PayPal. */
const PAYPAL_URL = 'https://paypal.me/Flipped1Hz';

/** The PayPal mark, filled in the button's colour. */
function paypalGlyph(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.93 4.778-4.005 7.201-9.138 7.201h-2.19a.563.563 0 0 0-.556.479l-1.187 7.527h-.506l-.24 1.516a.56.56 0 0 0 .554.647h3.882c.46 0 .85-.334.922-.788.06-.26.76-4.852.816-5.09a.932.932 0 0 1 .923-.788h.58c3.76 0 6.705-1.528 7.565-5.946.36-1.847.174-3.388-.777-4.471z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

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

    // bottom-right of the main menu: one "Support Me!" pill with Patreon + PayPal, each opened through the bridge.
    const openVia = (url: string) => (event: MouseEvent): void => {
      const safe = safeHref(url);
      event.preventDefault();
      if (!safe) return;
      call('open.url', { url: safe }).catch((error: unknown) => toast(describeError(error), 'error'));
    };
    const support = h('div', { className: 'home-support' });
    support.appendChild(h('span', { className: 'home-support-label', text: 'Support Me!' }));
    const patreonBtn = h('a', { className: 'home-support-link home-support-patreon', attrs: { href: PATREON_URL, title: 'Support on Patreon' } });
    patreonBtn.appendChild(patreonGlyph());
    patreonBtn.addEventListener('click', openVia(PATREON_URL));
    const paypalBtn = h('a', { className: 'home-support-link home-support-paypal', attrs: { href: PAYPAL_URL, title: 'Support on PayPal' } });
    paypalBtn.appendChild(paypalGlyph());
    paypalBtn.addEventListener('click', openVia(PAYPAL_URL));
    support.appendChild(patreonBtn);
    support.appendChild(paypalBtn);
    page.content.appendChild(support);


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

/** Apply every pending update in place (no navigation), then repaint the home page. */
async function updateAll(btn: HTMLButtonElement, updates: Item[], mapNames: string[]): Promise<void> {
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.querySelector('span');
  if (label) label.textContent = 'Updating…';
  let ok = 0;
  const failed: string[] = [];
  for (const item of updates) {
    try {
      await call('library.update', { kind: item.kind, id: item.id, ...(item.kind === 'maps' ? { otherNames: mapNames } : {}) });
      ok++;
    } catch (error) {
      failed.push(item.name);
      console.error('update failed for ' + item.id + ': ' + describeError(error));
    }
  }
  invalidateInstalled();
  if (failed.length) toast('Updated ' + ok + ', could not update ' + failed.length + ' (' + failed.join(', ') + ')', 'error');
  else toast(ok === 1 ? 'Updated 1 item' : 'Updated ' + ok + ' items', 'success');
  void loadData(generation);
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
  const updates = updatesOf(mine);
  // Two rows of four normally; a single row when the updates card is taking the lead, so the home page stays compact.
  const fresh = newestAcross(annotated, updates.length > 0 ? 4 : 8);
  if (fresh.length > 0) {
    const tiles = h('div', { className: 'hub-tile-grid' });
    for (const item of fresh) tiles.appendChild(hubTile(item));
    fillCard(newHost, tiles);
  } else if (failed.length > 0) {
    fillCard(newHost, errorState('The hub could not be reached, so there is nothing new to show.', () => { void loadData(generation); }));
  } else {
    fillCard(newHost, emptyState('sparkles', 'Nothing yet', 'New items from the hub will show up here.'));
  }

  if (updates.length > 0) {
    const head = h('p', { className: 'updates-count' }, h('strong', { text: String(updates.length) }), updates.length === 1 ? ' update available' : ' updates available');
    // "Update all" applies every pending update in place — no menu change (the old "See all updates" always wrong-footed to Maps).
    const more = button('Update all', { kind: 'primary', icon: 'download' });
    more.classList.add('updates-all-btn');
    more.addEventListener('click', () => void updateAll(more, updates, (annotated.maps || []).map((m) => m.name)));
    // One row, all the way across the wide lead card: every update side by side, names cutting off instead of wrapping.
    const strip = h('div', { className: 'updates-strip' });
    for (const item of updates) strip.appendChild(miniRow(item, item.kind === 'maps' ? 'Revision ' + (item.installed?.revision ?? '?') + ' → ' + item.revision : (item.installed?.version || '?') + ' → ' + item.version));
    fillCard(updatesHost, head, strip, more);
    // With updates pending, they take over the lead: the updates card spans the top
    // (where What's new runs) and What's new drops into the narrower slot below.
    updatesHost.classList.add('home-card-wide');
    newHost?.classList.remove('home-card-wide');
    if (homeGrid && !updatesHost.isConnected) homeGrid.prepend(updatesHost);
  } else if (updatesHost && updatesHost.isConnected) {
    // nothing to update any more: What's new gets its lead back and the empty card leaves the grid
    updatesHost.classList.remove('home-card-wide');
    newHost?.classList.add('home-card-wide');
    updatesHost.remove();
  }
}
