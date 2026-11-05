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
import { pendingReviewView } from './review.js';
import { githubRepoUrl } from '../lib/sourceUrl.js';
import { openAuthModal } from './index.js';
import { sourceBadge } from '../components/sourceLink.js';
import { switchControl } from '../settings/ui.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { autoUpdateLine, checkMessage, parseCheck } from '../lib/upload.js';

export interface Submission {
  id: string;
  kind: string;
  name: string;
  version: string;
  revision: number | null;
  status: string;
  createdAt: string;
  gallery: string[];
  sourceUrl: string | null;
  rejectionReason: string;
  autoUpdate: boolean;
  releaseTag: string;
  releaseCheckedAt: string;
  releaseError: string;
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
      sourceUrl: githubRepoUrl(r.sourceUrl),
      rejectionReason: str(r.rejectionReason),
      autoUpdate: r.autoUpdate !== false,
      releaseTag: str(r.releaseTag),
      releaseCheckedAt: str(r.releaseCheckedAt),
      releaseError: str(r.releaseError),
    });
  }
  return rows;
}

/** What an upload's owner reads: mods wait for an admin's go-ahead before anyone else sees them. */
export function statusLabel(status: string): string {
  return status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : status === 'pending' ? 'Waiting for review' : status || 'On the hub';
}

/** The GitHub auto-update line, "Check GitHub now" and the on/off switch of a mod that has a source repo. */
function githubControls(item: Submission, reload: () => void): HTMLElement {
  const box = h('div', { className: 'upload-github' });
  const line = autoUpdateLine(item, relativeTime);
  box.appendChild(h('div', { className: 'upload-gh-line' + (line.tone === 'ok' ? '' : ' is-' + line.tone), text: line.text, title: line.text }));
  const row = h('div', { className: 'upload-gh-actions' });
  const check = button('Check GitHub now', {
    kind: 'ghost', icon: 'refresh',
    onClick: () => {
      check.disabled = true;
      hubJson('POST', '/api/mods/' + encodeURIComponent(item.id) + '/check-release').then((json) => {
        const message = checkMessage(item.name, parseCheck(json));
        toast(message.text, message.kind);
        reload();
      }, (error) => {
        check.disabled = false;
        toast(describeError(error), 'error');
      });
    },
  });
  row.appendChild(check);
  const wrap = h('span', { className: 'mod-switch' });
  const label = h('span', { className: 'mod-switch-label', text: 'Auto-update' });
  const sw = switchControl('Auto-update ' + item.name + ' from GitHub', item.autoUpdate, (next) => {
    sw.disabled = true;
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    wrap.classList.toggle('is-on', next);
    hubJson('PATCH', '/api/submissions/' + encodeURIComponent(item.id), { autoUpdate: next }).then(() => {
      toast('Auto-update ' + (next ? 'on' : 'off') + ' for ' + item.name, 'success');
      reload();
    }, (error) => {
      sw.disabled = false;
      sw.setAttribute('aria-checked', next ? 'false' : 'true');
      wrap.classList.toggle('is-on', !next);
      toast(describeError(error), 'error');
    });
  });
  wrap.classList.toggle('is-on', item.autoUpdate);
  wrap.append(sw, label);
  row.appendChild(wrap);
  box.appendChild(row);
  return box;
}

function card(item: Submission, reload: () => void): HTMLElement {
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
  const mark = item.sourceUrl ? sourceBadge({ kind: 'mods', sourceUrl: item.sourceUrl }) : null;
  if (mark) badges.appendChild(mark);
  body.appendChild(badges);
  if (item.createdAt) body.appendChild(h('div', { className: 'create-meta dim' }, h('span', { text: 'Uploaded ' + relativeTime(item.createdAt) })));
  if (kind === 'mods' && item.sourceUrl) body.appendChild(githubControls(item, reload));
  const actions = h('div', { className: 'create-actions' });
  const route = libraryRoute(item.kind, item.id);
  const live = item.status === '' || item.status === 'approved';
  if (route && live) {
    actions.appendChild(h('a', { className: 'btn btn-primary', attrs: { href: route }, title: 'Open in the Library' }, h('span', { text: 'Open in Library' })));
  } else {
    actions.appendChild(h('span', { className: item.status === 'rejected' ? 'error' : 'dim', text: item.status === 'rejected'
      ? 'Not approved' + (item.rejectionReason ? ': ' + item.rejectionReason : '')
      : 'Shows in the Library once approved' }));
  }
  body.appendChild(actions);
  root.appendChild(body);
  return root;
}

export function uploadsView(): { element: HTMLElement; ready: Promise<void>; filter(query: string): void; reload(): void } {
  const root = h('div', { className: 'create-tab' });
  let grid: HTMLElement | null = null;
  let disposed = false;
  const review = pendingReviewView(() => { void load(); });
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
    // Admins see what is waiting for them first; the section stays hidden when nothing is.
    const reviewing = currentUser()?.admin === true;
    if (reviewing) void review.load();
    const lead: Node[] = reviewing ? [review.element] : [];
    try {
      const items = normalizeSubmissions(await hubJson('GET', '/api/me/submissions'));
      if (disposed) return;
      if (items.length === 0) {
        root.replaceChildren(...lead, emptyState('users', 'No uploads yet', 'Maps, skins and mods you publish to the hub will be listed here.'));
        return;
      }
      grid = h('div', { className: 'card-grid' });
      grid.style.setProperty('--card-min', '260px');
      for (const item of items) grid.appendChild(card(item, () => { void load(); }));
      root.replaceChildren(...lead, grid);
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
  return { element: root, ready, filter(text: string): void { query = text; applyFilter(); }, reload(): void { void load(); } };
}
