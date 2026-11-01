/** Create > Uploads: what the signed-in account has published to the hub. */
import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { relativeTime } from '../create/format.js';
import { imageBlobUrl } from '../lib/hub.js';
import { kindPlaceholder, showSkinFrame } from '../components/itemCard.js';
import { KIND_LABEL, type Kind } from '../lib/library.js';
import { HubError, hubJson } from '../community/api.js';
import { libraryKind, libraryRoute } from '../community/format.js';
import { currentUser, onSession, sessionReady } from './session.js';
import { openAuthModal } from './index.js';

export interface Submission {
  id: string;
  kind: string;
  name: string;
  version: string;
  revision: number | null;
  status: string;
  createdAt: string;
  gallery: string[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Shapes /api/me/submissions; rows without an id are dropped. */
export function normalizeSubmissions(json: unknown): Submission[] {
  if (!Array.isArray(json)) return [];
  const rows: Submission[] = [];
  for (const raw of json) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!str(r.id)) continue;
    const revision = typeof r.revision === 'number' ? r.revision : typeof r.version === 'number' ? r.version : null;
    rows.push({
      id: str(r.id),
      kind: str(r.kind),
      name: str(r.name) || 'Untitled',
      version: str(r.version),
      revision,
      status: str(r.status),
      createdAt: str(r.createdAt) || str(r.created_at),
      gallery: Array.isArray(r.gallery) ? r.gallery.filter((g): g is string => typeof g === 'string') : [],
    });
  }
  return rows;
}

/** The hub's /api/me/submissions rows carry no status today; when one does, it is shown, otherwise the upload is simply on the hub. */
export function statusLabel(status: string): string {
  return status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : status === 'pending' ? 'Pending review' : status || 'On the hub';
}

function card(item: Submission): HTMLElement {
  const root = h('article', { className: 'item-card create-card', dataset: { name: item.name.toLowerCase() } });
  const kind = libraryKind(item.kind);
  // The same pictures as the Library: the kind's cover under (or instead of) the image, and skins drawn as their character.
  const media = h('div', { className: 'card-media' + (kind ? ' kind-' + kind : '') });
  if (kind) media.appendChild(kindPlaceholder(kind as Kind));
  if (kind && item.gallery.length > 0) {
    const box = h('div', { className: 'media-box card-img' });
    const image = h('img', { attrs: { alt: '', decoding: 'async' } });
    if (kind === 'skins') image.classList.add('pixel');
    box.appendChild(image);
    media.appendChild(box);
    void imageBlobUrl(kind as Kind, item.id, item.gallery[0]).then((url) => {
      image.onload = () => {
        if (kind !== 'skins' || showSkinFrame(box, image)) media.classList.add('has-img');
      };
      image.src = url;
    }, () => undefined);
  }
  root.appendChild(media);
  const body = h('div', { className: 'card-body' });
  body.appendChild(h('div', { className: 'card-name', text: item.name, title: item.name }));
  const badges = h('div', { className: 'card-badges' });
  if (kind) badges.appendChild(h('span', { className: 'badge badge-kind kind-' + kind, text: KIND_LABEL[kind as Kind] || kind }));
  badges.appendChild(h('span', { className: 'badge', text: 'Revision ' + (item.revision ?? 1) }));
  badges.appendChild(h('span', { className: 'badge status-' + item.status + ' badge-sub', text: statusLabel(item.status) }));
  body.appendChild(badges);
  if (item.createdAt) body.appendChild(h('div', { className: 'create-meta dim' }, h('span', { text: 'Uploaded ' + relativeTime(item.createdAt) })));
  const actions = h('div', { className: 'create-actions' });
  const route = libraryRoute(item.kind, item.id);
  const live = item.status === '' || item.status === 'approved';
  if (route && live) {
    actions.appendChild(h('a', { className: 'btn btn-primary', attrs: { href: route }, title: 'Open in the Library' }, h('span', { text: 'Open in Library' })));
  } else {
    actions.appendChild(h('span', { className: 'dim', text: 'Shows in the Library once approved' }));
  }
  body.appendChild(actions);
  root.appendChild(body);
  return root;
}

export function uploadsView(): { element: HTMLElement; ready: Promise<void>; filter(query: string): void } {
  const root = h('div', { className: 'create-tab' });
  let grid: HTMLElement | null = null;
  let disposed = false;
  let query = '';

  function signInPrompt(): HTMLElement {
    return emptyState('users', "Sign in to see and update what you've published", 'Your uploads to the hub will be listed here once you are signed in.', {
      label: 'Sign in', kind: 'primary', onClick: () => openAuthModal('login'),
    });
  }

  async function load(): Promise<void> {
    grid = null;
    if (!currentUser()) { root.replaceChildren(signInPrompt()); return; }
    root.replaceChildren(h('p', { className: 'dim', text: 'Loading your uploads...' }));
    try {
      const items = normalizeSubmissions(await hubJson('GET', '/api/me/submissions'));
      if (disposed) return;
      if (items.length === 0) {
        root.replaceChildren(emptyState('users', 'No uploads yet', 'Maps, skins and mods you publish to the hub will be listed here.'));
        return;
      }
      grid = h('div', { className: 'card-grid' });
      grid.style.setProperty('--card-min', '260px');
      for (const item of items) grid.appendChild(card(item));
      root.replaceChildren(grid);
      applyFilter();
    } catch (error) {
      if (disposed) return;
      if (error instanceof HubError && error.status === 401) { root.replaceChildren(signInPrompt()); return; }
      root.replaceChildren(errorState('Your uploads could not be loaded (' + describeError(error) + ').', () => { void load(); }));
    }
  }

  function applyFilter(): void {
    if (!grid) return;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const node of Array.from(grid.children) as HTMLElement[]) {
      node.hidden = !words.every((word) => (node.dataset.name || '').includes(word));
    }
  }

  // Keep the tab right if someone signs in or out while it is open.
  const stop = onSession(() => { if (root.isConnected && !disposed) void load(); else if (!root.isConnected) stop(); });
  const ready = sessionReady().then(() => load());
  return { element: root, ready, filter(text: string): void { query = text; applyFilter(); } };
}
