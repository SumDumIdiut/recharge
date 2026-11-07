/** Hash routing, route state, and page mounting. The pure helpers are DOM-free. */
import { perfRouteContent, perfRouteSettled, perfRouteStart } from './perf.js';

export type Query = Record<string, string>;

/** Sidebar pages that show one kind of installed content. */
/** Old top-level content links (the sidebar used to list these) and the Library kind each one now opens. */
const LEGACY_KIND: Record<string, string> = { maps: 'maps', mods: 'mods', skins: 'skins', games: 'games', backgrounds: 'backgrounds', create: 'maps', amplifier: 'maps' };

export interface ParsedRoute {
  /** Canonical hash, including the query string. */
  hash: string;
  /** Decoded path, e.g. /library/item/maps/demo. */
  path: string;
  /** Decoded path segments. */
  segments: string[];
  query: Query;
  /** Route name, e.g. library-item. */
  name: string;
  /** Page module key, e.g. library. */
  page: string;
  /** Path parameters, e.g. { kind, id } or { section }. */
  params: Record<string, string>;
  /** Which sidebar entry is active, or an empty string. */
  sidebar: string;
  /** True when the route shows a side panel. */
  isPanel: boolean;
}

export interface PageModule {
  title: string;
  mount(el: HTMLElement, params: ParsedRoute): void | Promise<void>;
  unmount?(): void;
  saveState?(): unknown;
  restoreState?(state: unknown): void;
  filter?(query: string): void;
}

export type PageRegistry = Record<string, PageModule>;

export interface RouteStateEntry {
  state: unknown;
  scroll: number;
}

export interface RouteStateStore {
  save(key: string, state: unknown, scroll: number): void;
  get(key: string): RouteStateEntry | null;
  setScroll(key: string, scroll: number): void;
  clear(): void;
  size(): number;
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Parse a query string (with or without a leading ? or #path? prefix). */
export function parseQuery(value: string): Query {
  const result: Query = {};
  let text = value || '';
  const question = text.indexOf('?');
  if (question >= 0) text = text.slice(question + 1);
  if (text.startsWith('#')) text = text.slice(1);
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const rawKey = equals < 0 ? pair : pair.slice(0, equals);
    const rawValue = equals < 0 ? '' : pair.slice(equals + 1);
    const key = decodePart(rawKey);
    if (!key) continue;
    result[key] = decodePart(rawValue);
  }
  return result;
}

/** Build a stable query string with sorted keys (no leading ?). */
export function buildQuery(query: Query | null | undefined): string {
  if (!query) return '';
  return Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== null)
    .sort()
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key])))
    .join('&');
}

/** Build a hash route from a path and optional query object. */
export function buildRoute(path: string, query?: Query | null): string {
  let clean = String(path || '').trim();
  let extraQuery: Query | null = query || null;
  const question = clean.indexOf('?');
  if (question >= 0) {
    if (!extraQuery) extraQuery = parseQuery(clean.slice(question + 1));
    clean = clean.slice(0, question);
  }
  if (clean.startsWith('#')) clean = clean.slice(1);
  if (!clean.startsWith('/')) clean = '/' + clean;
  if (!clean || clean === '/') clean = '/home';
  const qs = buildQuery(extraQuery);
  return '#' + clean + (qs ? '?' + qs : '');
}

/** Parse a hash route (a leading # is optional). */
export function parseRoute(hash: string): ParsedRoute {
  let raw = typeof hash === 'string' ? hash : '';
  if (raw.startsWith('#')) raw = raw.slice(1);
  let query: Query = {};
  const question = raw.indexOf('?');
  if (question >= 0) {
    query = parseQuery(raw.slice(question + 1));
    raw = raw.slice(0, question);
  }
  if (!raw || raw === '/') raw = '/home';

  const pieces = raw.split('/').filter((piece) => piece.length > 0);
  const segments = pieces.map(decodePart);
  const encodedPath = '/' + pieces.join('/');
  const path = '/' + segments.join('/');
  const canonical = buildRoute(encodedPath, query);

  const base: ParsedRoute = {
    hash: canonical,
    path,
    segments,
    query,
    name: 'not-found',
    page: 'not-found',
    params: {},
    sidebar: '',
    isPanel: false,
  };

  if (segments.length === 0) {
    return { ...base, name: 'home', page: 'home', sidebar: 'home' };
  }

  const first = segments[0];
  const second = segments[1] || '';
  const third = segments[2] || '';
  const fourth = segments[3] || '';

  if (first === 'home' && segments.length === 1) {
    return { ...base, name: 'home', page: 'home', sidebar: 'home' };
  }
  if (first === 'library') {
    if (segments.length === 1) {
      return { ...base, name: 'library', page: 'library', sidebar: 'library' };
    }
    if (segments.length === 4 && second === 'item') {
      return {
        ...base,
        name: 'library-item',
        page: 'library',
        sidebar: 'library',
        params: { kind: third, id: fourth },
        isPanel: true,
      };
    }
    return base;
  }
  // Old content links (#/maps, #/skins, #/create, #/amplifier ...) land on the Library with that kind chosen; the page rewrites the hash.
  if (Object.prototype.hasOwnProperty.call(LEGACY_KIND, first)) {
    const kind = LEGACY_KIND[first];
    if (segments.length === 4 && second === 'item') {
      return { ...base, name: 'library-item', page: 'library', sidebar: 'library', params: { kind: third, id: fourth }, isPanel: true, query: { kind, ...query } };
    }
    if (segments.length === 1 || first === 'create' || first === 'amplifier') {
      return { ...base, name: 'library', page: 'library', sidebar: 'library', query: { kind, ...query } };
    }
    return base;
  }
  // The Amplifier editor: #/amp/<folder> edits an installed map, #/amp/new starts a fresh one.
  if (first === 'amp' && segments.length === 2) {
    return { ...base, name: 'amp', page: 'amp', sidebar: 'library', params: { id: second } };
  }
  if (first === 'community') {
    if (segments.length === 1) {
      return {
        ...base,
        name: 'community',
        page: 'community',
        sidebar: 'community',
        params: { tab: 'forum' },
      };
    }
    if (segments.length === 2 && (second === 'forum' || second === 'players' || second === 'friends' || second === 'messages')) {
      return {
        ...base,
        name: 'community-' + second,
        page: 'community',
        sidebar: 'community',
        params: { tab: second },
      };
    }
    if (segments.length === 3 && second === 'forum' && /^\d{1,12}$/.test(third)) {
      return { ...base, name: 'community-thread', page: 'community', sidebar: 'community', params: { tab: 'forum', id: third } };
    }
    if (segments.length === 3 && second === 'messages' && third) {
      return { ...base, name: 'community-messages', page: 'community', sidebar: 'community', params: { tab: 'messages', user: third } };
    }
    if (segments.length === 3 && second === 'players' && third) {
      return { ...base, name: 'community-profile', page: 'community', sidebar: 'community', params: { tab: 'players', username: third } };
    }
    return base;
  }
  if (first === 'lobbies' && segments.length === 1) {
    return { ...base, name: 'lobbies', page: 'lobbies', sidebar: 'lobbies' };
  }
  if (first === 'notebook' && segments.length === 1) {
    return { ...base, name: 'notebook', page: 'notebook', sidebar: 'notebook' };
  }
  if (first === 'settings') {
    if (segments.length === 1) {
      return {
        ...base,
        name: 'settings',
        page: 'settings',
        sidebar: 'settings',
        params: { section: query.section === 'appearance' ? 'appearance' : 'game' },
      };
    }
    if (segments.length === 2 && second === 'about') {
      return {
        ...base,
        name: 'settings-about',
        page: 'settings',
        sidebar: 'settings',
        params: { section: 'about' },
      };
    }
    if (segments.length === 2 && second === 'profile') {
      return {
        ...base,
        name: 'settings-profile',
        page: 'settings',
        sidebar: 'settings',
        params: { section: 'profile' },
      };
    }
    return base;
  }

  return base;
}

/** An in-memory map of route key -> page state and scroll position. */
export function createStateStore(): RouteStateStore {
  const states = new Map<string, RouteStateEntry>();
  return {
    save(key: string, state: unknown, scroll: number): void {
      const previous = states.get(key);
      states.set(key, {
        state: state === undefined && previous ? previous.state : state,
        scroll: Number.isFinite(scroll) ? scroll : 0,
      });
    },
    get(key: string): RouteStateEntry | null {
      return states.get(key) || null;
    },
    setScroll(key: string, scroll: number): void {
      const entry = states.get(key);
      if (entry) entry.scroll = scroll;
      else states.set(key, { state: undefined, scroll });
    },
    clear(): void {
      states.clear();
    },
    size(): number {
      return states.size;
    },
  };
}

export interface RouterOptions {
  outlet: HTMLElement;
  routes: PageRegistry;
  notFound: PageModule;
  onRoute?: (route: ParsedRoute) => void;
}

export class Router {
  private outlet: HTMLElement;
  private routes: PageRegistry;
  private notFoundPage: PageModule;
  private onRoute?: (route: ParsedRoute) => void;
  private store: RouteStateStore;
  private current: { key: string; route: ParsedRoute; page: PageModule } | null = null;
  private previousHash = '';
  private token = 0;
  private started = false;
  private readySent = false;

  constructor(options: RouterOptions) {
    this.outlet = options.outlet;
    this.routes = options.routes;
    this.notFoundPage = options.notFound;
    this.onRoute = options.onRoute;
    this.store = createStateStore();

    this.onHashChange = this.onHashChange.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/home');
    }
    await this.show(parseRoute(window.location.hash || '#/home'));
  }

  navigate(hash: string): void {
    const target = buildRoute(hash);
    if (window.location.hash === target) return;
    window.location.hash = target;
  }

  /**
   * Replace the current hash without remounting the page. Used when a page
   * keeps its filters in the query string.
   */
  replace(hash: string): void {
    const target = buildRoute(hash);
    if (window.location.hash === target) return;
    window.history.replaceState(null, '', target);
    if (this.current) this.current.key = target;
  }

  /** Close a side-panel route by going back, or to a fallback route. */
  closePanel(fallback = '/library'): void {
    if (this.previousHash && this.previousHash !== this.current?.key) {
      window.history.back();
      return;
    }
    this.navigate(fallback);
  }

  filter(query: string): void {
    try {
      this.current?.page.filter?.(query);
    } catch (error) {
      console.error('filter failed', error);
    }
  }

  currentRoute(): ParsedRoute | null {
    return this.current?.route || null;
  }

  private ready(): void {
    if (this.readySent) return;
    this.readySent = true;
    try {
      const bridge = (window as unknown as { recharge?: { ready?: () => void } }).recharge;
      if (bridge && typeof bridge.ready === 'function') bridge.ready();
    } catch {
      /* The bridge is absent when the page is opened outside the app. */
    }
  }

  private saveCurrent(): void {
    if (!this.current) return;
    let state: unknown;
    try {
      state = this.current.page.saveState?.();
    } catch (error) {
      console.error('saveState failed', error);
    }
    this.store.save(this.current.key, state, this.outlet.scrollTop);
  }

  private async show(route: ParsedRoute): Promise<void> {
    if (this.current && this.current.key === route.hash) return;
    const token = ++this.token;
    perfRouteStart(route.hash);

    this.saveCurrent();
    if (this.current) {
      try {
        this.current.page.unmount?.();
      } catch (error) {
        console.error('unmount failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    this.previousHash = this.current ? this.current.key : '';
    this.current = null;

    const page = this.routes[route.page] || this.notFoundPage;
    const element = document.createElement('section');
    element.className = 'page-view';
    this.outlet.replaceChildren(element);

    try {
      const mounted = page.mount(element, route);
      perfRouteContent(route.hash);
      // The page's own content is in place: it counts as the current route (sidebar, title, unmount on leaving) while its
      // data is still loading, instead of after the slowest request.
      if (token === this.token) {
        this.current = { key: route.hash, route, page };
        document.title = page.title + ' · Recharge';
        if (this.onRoute) this.onRoute(route);
      }
      if (mounted && typeof (mounted as Promise<void>).then === 'function') {
        await mounted;
      }
    } catch (error) {
      // The bridge's console relay turns objects into {}, so log the message and stack as text.
      console.error('mount failed for ' + route.hash + ': ' + (error instanceof Error ? error.message + '\n' + (error.stack || '') : String(error)));
      element.replaceChildren();
      const problem = document.createElement('div');
      problem.className = 'mount-error';
      problem.textContent = 'This page could not be opened.';
      element.appendChild(problem);
    }

    if (token !== this.token) return;

    const saved = this.store.get(route.hash);
    if (saved && saved.state !== undefined && page.restoreState) {
      try {
        page.restoreState(saved.state);
      } catch (error) {
        console.error('restoreState failed', error);
      }
    }

    document.title = page.title + ' · Recharge';
    this.outlet.scrollTop = saved ? saved.scroll : 0;
    this.current = { key: route.hash, route, page };
    perfRouteSettled(route.hash);
    this.ready();
  }

  private onHashChange(): void {
    void this.show(parseRoute(window.location.hash || '#/home'));
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.button === 3) {
      event.preventDefault();
      window.history.back();
    } else if (event.button === 4) {
      event.preventDefault();
      window.history.forward();
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      window.history.back();
      return;
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      window.history.forward();
      return;
    }
    if (event.key === 'Escape') {
      if (document.querySelector('.modal-overlay')) return;
      const route = this.current?.route;
      if (route && route.isPanel) {
        event.preventDefault();
        this.closePanel(route.params.kind ? '/library?kind=' + route.params.kind : '/library');
      }
    }
  }
}
