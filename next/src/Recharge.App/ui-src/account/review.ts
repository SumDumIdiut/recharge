/** Library > Your uploads, for admins: the submissions waiting for review, with Approve / Reject. */
import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { call } from '../bridge.js';
import { relativeTime } from '../create/format.js';
import { HubError, hubJson } from '../community/api.js';
import { githubRepoUrl, repoLabel } from '../lib/sourceUrl.js';
import { KIND_LABEL, type Kind } from '../lib/library.js';
import { libraryKind } from '../community/format.js';

export interface PendingSubmission {
  id: string;
  kind: string;
  name: string;
  version: string;
  uploader: string;
  description: string;
  sourceUrl: string | null;
  /** The published entry this is a new version of, or null for a new upload. */
  updateOf: string | null;
  files: string[];
  fileSize: number | null;
  createdAt: string;
}

export const REASON_MAX = 500;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Shapes /api/admin/submissions/pending. Rows without an id are dropped; the repository must be a github.com address to count. */
export function normalizePending(json: unknown): PendingSubmission[] {
  if (!Array.isArray(json)) return [];
  const rows: PendingSubmission[] = [];
  for (const raw of json) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!str(r.id)) continue;
    rows.push({
      id: str(r.id),
      kind: str(r.kind),
      name: str(r.name) || 'Untitled',
      version: str(r.version),
      uploader: str(r.uploader) || str(r.author),
      description: str(r.description),
      sourceUrl: githubRepoUrl(r.sourceUrl),
      updateOf: str(r.updateOf) || null,
      files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : [],
      fileSize: typeof r.fileSize === 'number' && Number.isFinite(r.fileSize) ? r.fileSize : null,
      createdAt: str(r.createdAt),
    });
  }
  return rows;
}

/** "New mod" or "Update" for the heading of a pending row. */
export function pendingTitle(item: Pick<PendingSubmission, 'kind' | 'updateOf'>): string {
  const label = (libraryKind(item.kind) && KIND_LABEL[libraryKind(item.kind) as Kind]) || item.kind || 'upload';
  return item.updateOf ? 'Update of a published ' + label.toLowerCase() : 'New ' + label.toLowerCase();
}

export function formatSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/** Why a rejection reason can't be sent, or null when it is fine. */
export function reasonProblem(reason: string): string | null {
  const text = reason.trim();
  if (!text) return 'Write a reason, the uploader will see it.';
  if (text.length > REASON_MAX) return 'The reason is too long (' + REASON_MAX + ' characters at most).';
  return null;
}

function openRepo(url: string): void {
  call('open.url', { url }).catch((error) => toast(describeError(error), 'error'));
}

function askReason(name: string, onSend: (reason: string) => Promise<void>): void {
  const box = h('textarea', { className: 'review-reason', attrs: { rows: '4', maxlength: String(REASON_MAX), placeholder: 'Why is it not approved?' } }) as HTMLTextAreaElement;
  const error = h('p', { className: 'detail-status error', attrs: { role: 'alert' } });
  const body = h('div', {}, h('p', { className: 'dim', text: 'The uploader sees this reason next to "' + name + '".' }), box, error);
  let busy = false;
  modal({
    title: 'Reject ' + name,
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Reject', kind: 'danger',
        onClick: () => {
          if (busy) return false;
          const problem = reasonProblem(box.value);
          if (problem) { error.textContent = problem; return false; }
          busy = true;
          onSend(box.value.trim()).then(() => { busy = false; }, (e) => { busy = false; toast(describeError(e), 'error'); });
          return undefined;
        },
      },
    ],
  });
  box.focus();
}

function row(item: PendingSubmission, refresh: () => void): HTMLElement {
  const root = h('article', { className: 'review-row' });
  const head = h('div', { className: 'review-head' });
  head.appendChild(h('strong', { className: 'review-name', text: item.name }));
  if (item.version) head.appendChild(h('span', { className: 'badge', text: 'v' + item.version }));
  head.appendChild(h('span', { className: 'badge badge-sub', text: pendingTitle(item) }));
  root.appendChild(head);
  const meta = h('div', { className: 'create-meta dim' });
  meta.appendChild(h('span', { text: 'by ' + (item.uploader || 'unknown') + (item.createdAt ? ', ' + relativeTime(item.createdAt) : '') }));
  root.appendChild(meta);
  if (item.description) root.appendChild(h('p', { className: 'review-desc', text: item.description }));

  const details = h('div', { className: 'review-details' });
  if (item.sourceUrl) {
    const url = item.sourceUrl;
    const link = h('button', { className: 'link-btn', text: repoLabel(url), title: url, attrs: { type: 'button' } });
    link.addEventListener('click', () => openRepo(url));
    details.appendChild(h('div', {}, h('span', { className: 'dim', text: 'Source code: ' }), link));
  } else {
    details.appendChild(h('div', { className: 'error', text: 'No valid GitHub repository was given.' }));
  }
  if (item.files.length) {
    details.appendChild(h('div', {}, h('span', { className: 'dim', text: 'Files: ' }), item.files.join(', ') + (item.fileSize !== null ? ' (' + formatSize(item.fileSize) + ')' : '')));
  }
  root.appendChild(details);

  const status = h('p', { className: 'detail-status dim', attrs: { role: 'status' } });
  const approve = button('Approve', { kind: 'primary', icon: 'check' });
  const reject = button('Reject', { kind: 'danger' });
  const setBusy = (busy: boolean): void => { approve.disabled = busy; reject.disabled = busy; };
  approve.addEventListener('click', () => {
    setBusy(true);
    status.className = 'detail-status dim';
    status.textContent = 'Approving…';
    hubJson('POST', '/api/admin/submissions/' + encodeURIComponent(item.id) + '/approve').then(() => {
      toast(item.name + ' is now public', 'success');
      refresh();
    }, (e) => { setBusy(false); status.className = 'detail-status error'; status.textContent = describeError(e); });
  });
  reject.addEventListener('click', () => {
    askReason(item.name, async (reason) => {
      setBusy(true);
      try {
        await hubJson('POST', '/api/admin/submissions/' + encodeURIComponent(item.id) + '/reject', { reason });
        toast(item.name + ' was rejected', 'info');
        refresh();
      } catch (e) {
        setBusy(false);
        throw e;
      }
    });
  });
  root.appendChild(h('div', { className: 'create-actions' }, approve, reject));
  root.appendChild(status);
  return root;
}

/** The "Pending review" section; empty (and hidden) when there is nothing waiting or the account is not an admin. */
export function pendingReviewView(onChange: () => void = () => undefined): { element: HTMLElement; load(): Promise<void> } {
  const root = h('section', { className: 'review-section', hidden: true });
  async function load(): Promise<void> {
    try {
      const items = normalizePending(await hubJson('GET', '/api/admin/submissions/pending'));
      root.replaceChildren();
      root.hidden = items.length === 0;
      if (items.length === 0) return;
      root.appendChild(h('h3', { className: 'detail-h', text: 'Pending review (' + items.length + ')' }));
      const list = h('div', { className: 'review-list' });
      const refresh = (): void => { void load(); onChange(); };
      for (const item of items) list.appendChild(row(item, refresh));
      root.appendChild(list);
    } catch (error) {
      root.replaceChildren();
      root.hidden = !(error instanceof HubError && error.status !== 403 && error.status !== 401);
      if (!root.hidden) root.appendChild(h('p', { className: 'error', text: 'The review list could not be loaded (' + describeError(error) + ').' }));
    }
  }
  return { element: root, load };
}
