/** The forum: thread list, new-thread dialog. The thread page is in thread.ts. */
import { h } from '../dom.js';
import { go } from '../navigation.js';
import { button } from '../components/button.js';
import { chips } from '../components/chips.js';
import { selectControl } from '../components/select.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { describeError } from '../bridge.js';
import { relativeTime } from '../create/format.js';
import { icon } from '../icons.js';
import { currentUser } from '../account/session.js';
import { openAuthModal } from '../account/index.js';
import { hubForm, hubImage, hubJson } from './api.js';
import { CATEGORIES, LIM, STATUSES, labelOf, normalizeThread, normalizeThreadPage, threadRoute, validateThread, type ThreadRow } from './format.js';
import { counter, field, formError, imagePicker, textArea, textInput } from './forms.js';
import { personChip } from './people.js';

export interface View {
  element: HTMLElement;
  /** Resolves when the first data is in. */
  ready: Promise<void>;
  filter?(query: string): void;
  dispose?(): void;
}

interface ListState { category: string; status: string; sort: string; q: string; page: number }
const state: ListState = { category: '', status: '', sort: 'active', q: '', page: 1 };

export function categoryBadge(category: string): HTMLElement {
  return h('span', { className: 'badge badge-cat cat-' + category, text: labelOf(CATEGORIES, category) });
}

export function statusBadge(status: string): HTMLElement | null {
  if (status === 'open') return null;
  return h('span', { className: 'badge badge-status status-' + status, text: labelOf(STATUSES, status) });
}

function threadRow(thread: ThreadRow): HTMLElement {
  const row = h('a', { className: 'thread-row' + (thread.pinned ? ' is-pinned' : ''), attrs: { href: threadRoute(thread.id) } });
  const main = h('div', { className: 'thread-main' });
  const badges = h('div', { className: 'thread-badges' });
  if (thread.pinned) badges.appendChild(h('span', { className: 'badge badge-pinned', text: 'Pinned' }));
  badges.appendChild(categoryBadge(thread.category));
  const status = statusBadge(thread.status);
  if (status) badges.appendChild(status);
  main.appendChild(badges);
  main.appendChild(h('div', { className: 'thread-title', text: thread.title, title: thread.title }));
  if (thread.excerpt) main.appendChild(h('div', { className: 'thread-excerpt dim', text: thread.excerpt.replace(/\s+/g, ' ') }));
  const meta = h('div', { className: 'thread-meta' });
  meta.appendChild(personChip(thread.author, 22));
  meta.appendChild(h('span', { className: 'dim', text: thread.lastActivity ? 'active ' + relativeTime(thread.lastActivity) : '' }));
  main.appendChild(meta);
  row.appendChild(main);
  if (thread.thumb) {
    const thumb = h('span', { className: 'thread-thumb' });
    const image = h('img', { attrs: { alt: '', decoding: 'async' } });
    void hubImage(thread.thumb).then((url) => { if (url) image.src = url; });
    thumb.appendChild(image);
    row.appendChild(thumb);
  }
  const replies = h('span', { className: 'thread-replies', title: thread.replyCount + (thread.replyCount === 1 ? ' reply' : ' replies') });
  replies.appendChild(icon('forum', 18));
  replies.appendChild(h('span', { text: String(thread.replyCount) }));
  row.appendChild(replies);
  return row;
}

/** Ask for an account first; true when someone is signed in already. */
export function needLogin(then?: () => void): boolean {
  if (currentUser()) return true;
  openAuthModal('login', then ? () => then() : undefined);
  return false;
}

export function forumList(): View {
  const root = h('div', { className: 'forum' });
  const toolbar = h('div', { className: 'forum-toolbar' });
  const list = h('div', { className: 'thread-list' });
  const pager = h('div', { className: 'pager' });
  let disposed = false;
  let sequence = 0;
  let searchTimer = 0;

  const categoryChips = chips(
    [{ value: '', label: 'All' }, ...CATEGORIES],
    { value: state.category, onChange: (value) => { state.category = value; state.page = 1; void load(); } }
  );
  const statusSelect = selectControl(
    [{ value: '', label: 'Any status' }, ...STATUSES],
    { value: state.status, onChange: (value) => { state.status = value; state.page = 1; void load(); } }
  );
  const sortSelect = selectControl(
    [{ value: 'active', label: 'Latest activity' }, { value: 'new', label: 'Newest first' }],
    { value: state.sort, onChange: (value) => { state.sort = value; state.page = 1; void load(); } }
  );
  const newThread = button('New thread', {
    kind: 'primary', icon: 'plus',
    onClick: () => { if (needLogin(openNewThread)) openNewThread(); },
  });
  if (!currentUser()) newThread.title = 'Log in to start a thread';

  toolbar.appendChild(categoryChips);
  const right = h('div', { className: 'forum-tools' });
  right.appendChild(statusSelect);
  right.appendChild(sortSelect);
  right.appendChild(newThread);
  toolbar.appendChild(right);
  root.appendChild(toolbar);
  root.appendChild(list);
  root.appendChild(pager);

  async function load(): Promise<void> {
    const mine = ++sequence;
    const query = new URLSearchParams();
    if (state.category) query.set('category', state.category);
    if (state.status) query.set('status', state.status);
    if (state.q) query.set('q', state.q);
    query.set('sort', state.sort);
    if (state.page > 1) query.set('page', String(state.page));
    try {
      const page = normalizeThreadPage(await hubJson('GET', '/api/forum?' + query.toString()));
      if (disposed || mine !== sequence) return;
      list.replaceChildren();
      pager.replaceChildren();
      if (page.threads.length === 0) {
        list.appendChild(state.q || state.category || state.status
          ? emptyState('forum', 'No threads match', 'Try a different search or clear the filters.', {
            label: 'Clear filters', kind: 'secondary',
            onClick: () => { state.q = state.category = state.status = ''; state.page = 1; go('#/community/forum'); void load(); },
          })
          : emptyState('forum', 'No threads yet', 'Be the first to start a conversation.', { label: 'New thread', onClick: () => { if (needLogin(openNewThread)) openNewThread(); } }));
        return;
      }
      for (const thread of page.threads) list.appendChild(threadRow(thread));
      if (page.pages > 1) {
        const prev = button('Previous', { kind: 'secondary', disabled: page.page <= 1, onClick: () => { state.page = page.page - 1; void load(); } });
        const next = button('Next', { kind: 'secondary', disabled: page.page >= page.pages, onClick: () => { state.page = page.page + 1; void load(); } });
        pager.append(prev, h('span', { className: 'dim', text: 'Page ' + page.page + ' of ' + page.pages + ' (' + page.total + ' threads)' }), next);
      }
    } catch (error) {
      if (disposed || mine !== sequence) return;
      list.replaceChildren(errorState('The forum could not be loaded (' + describeError(error) + ').', () => { void load(); }));
    }
  }

  return {
    element: root,
    ready: load(),
    filter(query: string): void {
      window.clearTimeout(searchTimer);
      const text = query.slice(0, LIM.q);
      if (text === state.q) return;
      searchTimer = window.setTimeout(() => { state.q = text; state.page = 1; void load(); }, 150);
    },
    dispose(): void { disposed = true; window.clearTimeout(searchTimer); },
  };
}

/** The new-thread dialog. */
export function openNewThread(): void {
  const category = selectControl(CATEGORIES, { label: undefined, value: CATEGORIES[0].value });
  const select = category.querySelector('select') as HTMLSelectElement;
  const title = textInput('', 'A short, clear title', LIM.title);
  const body = textArea('', 'What is on your mind? Describe it so others can help.', 8);
  const pictures = imagePicker(LIM.postImages);
  const error = formError();
  const form = h('form', { className: 'compose', attrs: { novalidate: 'novalidate' } });
  form.appendChild(field('Category', category));
  const titleField = field('Title', title);
  titleField.appendChild(counter(title, LIM.title));
  form.appendChild(titleField);
  const bodyField = field('Post', body);
  bodyField.appendChild(counter(body, LIM.post));
  form.appendChild(bodyField);
  form.appendChild(pictures.element);
  form.appendChild(error.element);

  let busy = false;
  const post = button('Post thread', { kind: 'primary', type: 'submit' });
  form.appendChild(h('div', { className: 'compose-actions' }, post));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const problem = validateThread({ title: title.value, body: body.value, category: select.value }) || pictures.error();
    if (problem) { error.show(problem); return; }
    busy = true;
    post.disabled = true;
    error.show(null);
    hubForm<{ post?: unknown }>('POST', '/api/forum', { title: title.value, body: body.value, category: select.value }, pictures.files().map((file) => ({ field: 'images', file })))
      .then((reply) => {
        const created = normalizeThread({ post: reply.post, replies: [] });
        (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
        toast('Thread posted.', 'success');
        go(created ? threadRoute(created.post.id) : '#/community/forum');
      }, (failure) => {
        busy = false;
        post.disabled = false;
        error.show(describeError(failure));
      });
  });

  const overlay = modal({ title: 'New thread', body: form, actions: [{ label: 'Cancel' }] });
  title.focus();
}
