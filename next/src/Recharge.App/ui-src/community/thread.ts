/** One forum thread: the post, its replies, and everything you can do to your own. */
import { h } from '../dom.js';
import { go } from '../navigation.js';
import { button } from '../components/button.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { modal } from '../components/modal.js';
import { selectControl } from '../components/select.js';
import { toast } from '../components/toast.js';
import { describeError } from '../bridge.js';
import { relativeTime } from '../create/format.js';
import { currentUser } from '../account/session.js';
import { HubError, hubForm, hubImage, hubJson } from './api.js';
import { categoryBadge, needLogin, statusBadge, type View } from './forum.js';
import {
  CATEGORIES, LIM, STATUSES, normalizeThread, validateImages, validateReply, validateThread,
  type Post, type Reply, type Thread,
} from './format.js';
import { counter, field, formError, imagePicker, textArea, textInput } from './forms.js';
import { playerAvatar, nameLink } from './people.js';

function whenText(iso: string): { text: string; full: string } {
  const ms = Date.parse(iso);
  return { text: relativeTime(iso), full: Number.isFinite(ms) ? new Date(ms).toLocaleString() : '' };
}

function pictureStrip(paths: string[]): HTMLElement | null {
  if (paths.length === 0) return null;
  const strip = h('div', { className: 'pic-strip' });
  for (const path of paths) {
    const tile = h('button', { className: 'pic-tile', attrs: { type: 'button', 'aria-label': 'View picture' } });
    const image = h('img', { attrs: { alt: 'Attached picture', decoding: 'async' } });
    void hubImage(path).then((url) => { if (url) image.src = url; else tile.classList.add('is-broken'); });
    tile.appendChild(image);
    tile.addEventListener('click', () => {
      void hubImage(path).then((url) => {
        if (!url) return;
        const big = h('img', { className: 'pic-big', attrs: { src: url, alt: 'Attached picture' } });
        modal({ title: 'Picture', body: big });
      });
    });
    strip.appendChild(tile);
  }
  return strip;
}

function byline(post: { author: Post['author']; createdAt: string }, extra?: string): HTMLElement {
  const line = h('div', { className: 'byline' });
  line.appendChild(playerAvatar(post.author, 40));
  const text = h('div', { className: 'byline-text' });
  text.appendChild(nameLink(post.author, 'author byline-name'));
  const when = whenText(post.createdAt);
  text.appendChild(h('span', { className: 'dim', text: when.text + (extra ? ' · ' + extra : ''), title: when.full }));
  line.appendChild(text);
  return line;
}

function confirmDelete(what: string, run: () => Promise<void>): void {
  const error = formError();
  const body = h('div');
  body.appendChild(h('p', { text: 'Delete this ' + what + '? This cannot be undone.' }));
  body.appendChild(error.element);
  const overlay = modal({
    title: 'Delete ' + what,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Delete', kind: 'danger',
        onClick: () => {
          run().then(() => {
            (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
          }, (failure) => error.show(describeError(failure)));
          return false;
        },
      },
    ],
  });
}

export function threadView(id: number): View {
  const root = h('div', { className: 'thread' });
  let disposed = false;
  let data: Thread | null = null;

  async function load(): Promise<void> {
    try {
      const loaded = normalizeThread(await hubJson('GET', '/api/forum/' + id));
      if (disposed) return;
      if (!loaded) throw new Error('The hub sent something unexpected.');
      data = loaded;
      paint();
    } catch (error) {
      if (disposed) return;
      data = null;
      root.replaceChildren(backLink());
      if (error instanceof HubError && error.status === 404) {
        root.appendChild(emptyState('forum', 'Thread not found', 'It may have been deleted.', { label: 'Back to the forum', kind: 'secondary', onClick: () => go('#/community/forum') }));
      } else {
        root.appendChild(errorState('This thread could not be loaded (' + describeError(error) + ').', () => { void load(); }));
      }
    }
  }

  function backLink(): HTMLElement {
    return h('a', { className: 'back-link', attrs: { href: '#/community/forum' }, text: '< All threads' });
  }

  function paint(): void {
    if (!data) return;
    const { post, replies } = data;
    root.replaceChildren(backLink());

    const head = h('section', { className: 'panel post' });
    const badges = h('div', { className: 'thread-badges' });
    if (post.pinned) badges.appendChild(h('span', { className: 'badge badge-pinned', text: 'Pinned' }));
    badges.appendChild(categoryBadge(post.category));
    const status = statusBadge(post.status);
    if (status) badges.appendChild(status);
    head.appendChild(badges);
    head.appendChild(h('h2', { className: 'post-title', text: post.title }));
    const edited = post.updatedAt && post.updatedAt !== post.createdAt ? 'edited ' + relativeTime(post.updatedAt) : undefined;
    head.appendChild(byline(post, edited));
    head.appendChild(h('div', { className: 'post-body', text: post.body }));
    const pics = pictureStrip(post.images);
    if (pics) head.appendChild(pics);

    const tools = h('div', { className: 'post-tools' });
    if (post.can.edit) tools.appendChild(button('Edit', { kind: 'secondary', onClick: () => editPost(post) }));
    if (post.can.status) {
      const current = post.status;
      const select = selectControl(STATUSES, {
        value: current,
        onChange: (value) => {
          hubJson('POST', '/api/forum/' + post.id + '/status', { status: value }).then(() => { toast('Marked ' + value + '.', 'success'); void load(); }, (e) => { toast(describeError(e), 'error'); void load(); });
        },
      });
      select.title = 'Thread status';
      tools.appendChild(select);
    }
    if (post.can.pin) {
      tools.appendChild(button(post.pinned ? 'Unpin' : 'Pin', {
        kind: 'secondary',
        onClick: () => { hubJson('POST', '/api/forum/' + post.id + '/pin', { pinned: !post.pinned }).then(() => load(), (e) => toast(describeError(e), 'error')); },
      }));
    }
    if (post.can.remove) {
      tools.appendChild(button('Delete', {
        kind: 'danger',
        onClick: () => confirmDelete('thread', async () => { await hubJson('DELETE', '/api/forum/' + post.id); toast('Thread deleted.', 'success'); go('#/community/forum'); }),
      }));
    }
    if (tools.childNodes.length > 0) head.appendChild(tools);
    root.appendChild(head);

    root.appendChild(h('h3', { className: 'replies-title', text: replies.length === 1 ? '1 reply' : replies.length + ' replies' }));
    const list = h('div', { className: 'reply-list' });
    for (const reply of replies) list.appendChild(replyCard(reply));
    root.appendChild(list);
    root.appendChild(composer(post));
  }

  function replyCard(reply: Reply): HTMLElement {
    const card = h('article', { className: 'panel reply', attrs: { id: 'reply-' + reply.id } });
    card.appendChild(byline(reply, reply.editedAt ? 'edited ' + relativeTime(reply.editedAt) : undefined));
    card.appendChild(h('div', { className: 'post-body', text: reply.body }));
    const pics = pictureStrip(reply.images);
    if (pics) card.appendChild(pics);
    if (reply.can.edit || reply.can.remove) {
      const tools = h('div', { className: 'post-tools' });
      if (reply.can.edit) tools.appendChild(button('Edit', { kind: 'ghost', onClick: () => editReply(reply) }));
      if (reply.can.remove) {
        tools.appendChild(button('Delete', {
          kind: 'ghost',
          onClick: () => confirmDelete('reply', async () => { await hubJson('DELETE', '/api/forum/replies/' + reply.id); toast('Reply deleted.', 'success'); await load(); }),
        }));
      }
      card.appendChild(tools);
    }
    return card;
  }

  function composer(post: Post): HTMLElement {
    const box = h('section', { className: 'panel composer' });
    const me = currentUser();
    if (!me) {
      box.appendChild(h('p', { className: 'dim', text: 'Log in to join the conversation.' }));
      box.appendChild(button('Log in to reply', { kind: 'primary', onClick: () => { needLogin(() => { void load(); }); } }));
      return box;
    }
    if (post.status === 'closed' && !me.admin) {
      box.appendChild(h('p', { className: 'dim', text: 'This thread is closed, so it cannot be replied to.' }));
      return box;
    }
    const body = textArea('', 'Write a reply...', 4);
    const pictures = imagePicker(LIM.replyImages);
    const error = formError();
    const form = h('form', { className: 'compose', attrs: { novalidate: 'novalidate' } });
    const bodyField = field('Reply as ' + me.username, body);
    bodyField.appendChild(counter(body, LIM.reply));
    form.appendChild(bodyField);
    form.appendChild(pictures.element);
    form.appendChild(error.element);
    const send = button('Post reply', { kind: 'primary', type: 'submit' });
    form.appendChild(h('div', { className: 'compose-actions' }, send));
    let busy = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const problem = validateReply(body.value) || pictures.error();
      if (problem) { error.show(problem); return; }
      busy = true;
      send.disabled = true;
      hubForm('POST', '/api/forum/' + post.id + '/replies', { body: body.value }, pictures.files().map((file) => ({ field: 'images', file })))
        .then(() => { toast('Reply posted.', 'success'); return load(); }, (failure) => {
          busy = false;
          send.disabled = false;
          error.show(describeError(failure));
        });
    });
    box.appendChild(form);
    return box;
  }

  function editPost(post: Post): void {
    const category = selectControl(CATEGORIES, { value: post.category });
    const select = category.querySelector('select') as HTMLSelectElement;
    const title = textInput(post.title, '', LIM.title);
    const body = textArea(post.body, '', 8);
    const pictures = imagePicker(LIM.postImages, post.images.map((path) => ({ path, url: hubImage(path) })));
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
    const save = button('Save changes', { kind: 'primary', type: 'submit' });
    form.appendChild(h('div', { className: 'compose-actions' }, save));
    let busy = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const problem = validateThread({ title: title.value, body: body.value, category: select.value }) || pictures.error();
      if (problem) { error.show(problem); return; }
      busy = true;
      save.disabled = true;
      hubForm('PUT', '/api/forum/' + post.id, { title: title.value, body: body.value, category: select.value, remove_images: pictures.removed() },
        pictures.files().map((file) => ({ field: 'images', file })))
        .then(() => { close(); toast('Thread updated.', 'success'); return load(); }, (failure) => {
          busy = false;
          save.disabled = false;
          error.show(describeError(failure));
        });
    });
    const overlay = modal({ title: 'Edit thread', body: form, actions: [{ label: 'Cancel' }] });
    const close = () => (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
  }

  function editReply(reply: Reply): void {
    const body = textArea(reply.body, '', 6);
    const pictures = imagePicker(LIM.replyImages, reply.images.map((path) => ({ path, url: hubImage(path) })));
    const error = formError();
    const form = h('form', { className: 'compose', attrs: { novalidate: 'novalidate' } });
    const bodyField = field('Reply', body);
    bodyField.appendChild(counter(body, LIM.reply));
    form.appendChild(bodyField);
    form.appendChild(pictures.element);
    form.appendChild(error.element);
    const save = button('Save changes', { kind: 'primary', type: 'submit' });
    form.appendChild(h('div', { className: 'compose-actions' }, save));
    let busy = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const problem = validateReply(body.value) || validateImages(pictures.files(), LIM.replyImages);
      if (problem) { error.show(problem); return; }
      busy = true;
      save.disabled = true;
      hubForm('PUT', '/api/forum/replies/' + reply.id, { body: body.value, remove_images: pictures.removed() },
        pictures.files().map((file) => ({ field: 'images', file })))
        .then(() => { close(); toast('Reply updated.', 'success'); return load(); }, (failure) => {
          busy = false;
          save.disabled = false;
          error.show(describeError(failure));
        });
    });
    const overlay = modal({ title: 'Edit reply', body: form, actions: [{ label: 'Cancel' }] });
    const close = () => (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
  }

  return { element: root, ready: load(), dispose(): void { disposed = true; } };
}
