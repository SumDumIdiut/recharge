import { h } from './dom.js';
import { icon } from './icons.js';
import { initAccountChip } from './account/index.js';
import { initUpdateBar } from './components/updateBar.js';
import { initBell } from './account/notifications.js';

export interface NavEntry {
  id: string;
  label: string;
  icon: string;
  hash: string;
}

const NAV: NavEntry[] = [
  { id: 'home', label: 'Home', icon: 'home', hash: '#/home' },
  { id: 'lobbies', label: 'Lobbies', icon: 'lobbies', hash: '#/lobbies' },
  { id: 'library', label: 'Library', icon: 'library', hash: '#/library' },
  { id: 'community', label: 'Community', icon: 'community', hash: '#/community' },
  { id: 'notebook', label: 'Notebook', icon: 'notebook', hash: '#/notebook' },
];

const SETTINGS: NavEntry = {
  id: 'settings',
  label: 'Settings',
  icon: 'settings',
  hash: '#/settings',
};

const STORAGE_KEY = 'recharge.sidebar.collapsed';
const AUTO_COLLAPSE_WIDTH = 1100;

let manual = false;
let listeners: Array<(collapsed: boolean) => void> = [];

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStored(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* Private-mode localStorage failures must not break the shell. */
  }
}

function effective(): boolean {
  return manual || window.innerWidth < AUTO_COLLAPSE_WIDTH;
}

function apply(): void {
  const collapsed = effective();
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = document.getElementById('sidebar-toggle');
  if (toggle) {
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    toggle.title = window.innerWidth < AUTO_COLLAPSE_WIDTH
      ? 'Sidebar collapses automatically in narrow windows'
      : label;
  }
  for (const listener of listeners) listener(collapsed);
}

export function isSidebarCollapsed(): boolean {
  return effective();
}

export function setSidebarCollapsed(value: boolean): void {
  manual = value;
  writeStored(value);
  apply();
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!manual);
}

export function onSidebarChange(listener: (collapsed: boolean) => void): () => void {
  listeners = listeners.concat(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

export function setActive(sidebar: string): void {
  for (const link of Array.from(document.querySelectorAll('.nav-item')) as HTMLElement[]) {
    const on = link.dataset.id === sidebar;
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function navLink(entry: NavEntry): HTMLElement {
  const link = h('a', {
    className: 'nav-item',
    title: entry.label,
    attrs: { href: entry.hash, 'aria-label': entry.label },
    dataset: { id: entry.id },
  });
  link.appendChild(icon(entry.icon, 20));
  link.appendChild(h('span', { className: 'nav-label', text: entry.label }));
  return link;
}

function searchShortcut(event: KeyboardEvent): void {
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (!input) return;
  if (event.defaultPrevented) return;
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const active = document.activeElement as HTMLElement | null;
    const tag = active ? active.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (active && active.isContentEditable)) return;
    event.preventDefault();
    input.focus();
    input.select();
  }
}

export interface ShellOptions {
  onSearch?: (query: string) => void;
}

/** Build the sidebar and topbar and restore the collapsed preference. */
export function initShell(options: ShellOptions = {}): void {
  manual = readStored();

  const nav = document.getElementById('sidebar-nav');
  if (nav) {
    for (const entry of NAV) nav.appendChild(navLink(entry));
  }
  const settingsNav = document.getElementById('sidebar-settings');
  if (settingsNav) settingsNav.appendChild(navLink(SETTINGS));

  const toggle = document.getElementById('sidebar-toggle') as HTMLButtonElement | null;
  if (toggle) {
    toggle.appendChild(icon('chevron-left', 18));
    toggle.classList.add('collapse-icon');
    toggle.addEventListener('click', toggleSidebar);
  }

  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (input) {
    let timer = 0;
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      const value = input.value;
      timer = window.setTimeout(() => options.onSearch?.(value.trim()), 90);
    });
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        input.value = '';
        options.onSearch?.('');
        input.blur();
      }
    });
  }

  const bell = document.getElementById('topbar-bell');
  if (bell) {
    bell.appendChild(icon('bell', 20));
    initBell(bell);
  }

  const account = document.getElementById('topbar-account');
  if (account) initAccountChip(account);

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      const field = document.getElementById('search-input') as HTMLInputElement | null;
      if (field) {
        field.focus();
        field.select();
      }
      return;
    }
    searchShortcut(event);
  });
  window.addEventListener('resize', apply);

  const mainCol = document.getElementById('main-col');
  if (mainCol) initUpdateBar(mainCol);

  apply();
}

/** Put text in the topbar search box without firing the search callback. */
export function setSearchText(value: string): void {
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (input && input.value !== value) input.value = value;
}
