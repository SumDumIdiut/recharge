import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import { button } from './button.js';
import { toast } from './toast.js';
import { authorName, kindPlaceholder, statusBadge } from './itemCard.js';
import { skinCanvas } from '../lib/skinThumb.js';
import { skinApplyButton } from '../lib/skinApply.js';
import { backgroundApplyButton } from '../backgrounds/applyButton.js';
import { imageBlobUrl } from '../lib/hub.js';
import { actionsOf, itemWebUrl, KIND_LABEL, type Item } from '../lib/library.js';
import { loadComments, type Comment } from '../lib/hub.js';

function date(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '';
}

export interface Detail {
  element: HTMLElement;
  dispose(): void;
}

function gallery(item: Item, dispose: Array<() => void>): HTMLElement {
  const root = h('div', { className: 'detail-gallery' });
  const stage = h('div', { className: 'detail-stage' });
  root.appendChild(stage);
  if (item.gallery.length === 0 || item.local) {
    stage.appendChild(kindPlaceholder(item.kind));
    return root;
  }
  let index = 0;
  const skins = item.kind === 'skins';
  const main = h('img', { attrs: { alt: item.name, decoding: 'async' } });
  main.addEventListener('error', () => main.classList.add('is-broken'));
  // Skins: the sheet (player.png) is shown as its character frame on a canvas over the image; the small indicator
  // pictures (dash, double jump) are shown whole. Pixel art is never smoothed.
  const frame = h('div', { className: 'stage-frame', hidden: true });
  if (skins) {
    main.classList.add('pixel');
    main.addEventListener('load', () => {
      const canvas = /player|sheet|template/i.test(item.gallery[index]) || index === 0
        ? skinCanvas(main, stage.clientWidth || 360, stage.clientHeight || 220) : null;
      frame.replaceChildren(...(canvas ? [canvas] : []));
      frame.hidden = !canvas;
      main.classList.toggle('is-covered', !!canvas);
    });
  }
  stage.appendChild(kindPlaceholder(item.kind));
  stage.appendChild(main);
  stage.appendChild(frame);
  const thumbs = h('div', { className: 'detail-thumbs' });
  const buttons: HTMLElement[] = [];
  const show = (next: number) => {
    index = (next + item.gallery.length) % item.gallery.length;
    main.classList.remove('is-broken');
    if (skins) {
      // same-origin bytes, so the sheet's pixels can be read for the character frame
      const want = index;
      imageBlobUrl(item.kind, item.id, item.gallery[index]).then(
        (url) => { if (want === index) main.src = url; },
        () => main.classList.add('is-broken'));
    } else {
      // Gallery images come through the bridge (blob URL): a direct https:// URL from imageUrl() fails
      // under the recharge:// URI scheme.
      const want = index;
      imageBlobUrl(item.kind, item.id, item.gallery[index]).then(
        (url) => { if (want === index) main.src = url; },
        () => main.classList.add('is-broken'));
    }
    buttons.forEach((node, i) => node.classList.toggle('is-on', i === index));
  };
  item.gallery.forEach((file, i) => {
    const thumb = h('button', { className: 'detail-thumb', attrs: { type: 'button', 'aria-label': 'Image ' + (i + 1) } });
    const image = h('img', { attrs: { alt: '', decoding: 'async', loading: 'lazy' } });
    if (skins) {
      // the sheet's thumbnail is its character frame too; the indicator pictures are shown whole
      image.classList.add('pixel');
      imageBlobUrl(item.kind, item.id, file).then((url) => {
        image.onload = () => {
          const canvas = i === 0 || /player|sheet|template/i.test(file) ? skinCanvas(image, 72, 40) : null;
          if (canvas) thumb.replaceChildren(canvas);
        };
        image.src = url;
      }, () => image.classList.add('is-broken'));
    } else {
      // Gallery images come through the bridge (blob URL): a direct https:// URL from imageUrl() fails
      // under the recharge:// URI scheme.
      imageBlobUrl(item.kind, item.id, file).then((url) => {
        image.onload = () => { /* shown once loaded */ };
        image.src = url;
      }, () => image.classList.add('is-broken'));
    }
    thumb.appendChild(image);
    thumb.addEventListener('click', () => show(i));
    buttons.push(thumb);
    thumbs.appendChild(thumb);
  });
  if (item.gallery.length > 1) {
    root.appendChild(thumbs);
    const onKey = (event: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (event.key === 'ArrowLeft' && !event.altKey) { event.preventDefault(); show(index - 1); }
      else if (event.key === 'ArrowRight' && !event.altKey) { event.preventDefault(); show(index + 1); }
    };
    document.addEventListener('keydown', onKey);
    dispose.push(() => document.removeEventListener('keydown', onKey));
  }
  show(0);
  return root;
}

function commentsSection(item: Item): HTMLElement {
  const section = h('section', { className: 'detail-comments' });
  section.appendChild(h('h3', { className: 'detail-h', text: 'Comments' }));
  const body = h('div', { className: 'comment-list' });
  body.appendChild(h('p', { className: 'dim', text: 'Loading comments…' }));
  section.appendChild(body);
  loadComments(item.kind, item.id).then(
    (comments: Comment[]) => {
      body.replaceChildren();
      if (comments.length === 0) {
        body.appendChild(h('p', { className: 'dim', text: 'No comments yet.' }));
        return;
      }
      for (const comment of comments) {
        const row = h('div', { className: 'comment' });
        const head = h('div', { className: 'comment-head' }, h('strong', {}, authorName(comment.author, comment.authorColor)));
        const when = date(comment.time);
        if (when) head.appendChild(h('span', { className: 'dim', text: when }));
        row.appendChild(head);
        row.appendChild(h('div', { className: 'comment-text', text: comment.text }));
        body.appendChild(row);
      }
    },
    (error) => {
      console.error('comments failed for ' + item.kind + '/' + item.id + ': ' + describeError(error));
      body.replaceChildren(h('p', { className: 'dim', text: "Comments couldn't be loaded" }));
    }
  );
  return section;
}

export function notFoundDetail(kind: string, id: string): Detail {
  const element = h('div', { className: 'detail-panel' });
  element.appendChild(h('p', { className: 'detail-kind', text: kind }));
  element.appendChild(h('h2', { className: 'detail-title', text: 'Item not found' }));
  element.appendChild(h('p', { className: 'detail-text', text: 'Nothing with the id "' + id + '" was found on the hub or in your install.' }));
  return { element, dispose: () => undefined };
}

export function loadingDetail(): Detail {
  const element = h('div', { className: 'detail-panel' });
  element.appendChild(h('p', { className: 'dim', text: 'Loading…' }));
  return { element, dispose: () => undefined };
}

export interface DetailOptions {
  /** Whether IGTAP was found (mods, maps and skins need it). */
  gameFound?: boolean;
  /** Names of the other hub maps, so a legacy-collided map folder is never reused. */
  otherNames?: string[];
  /** Called after an install, update or remove succeeded, so the page can reload what is installed. */
  onChanged?: (item: Item) => void;
}

const PAST: Record<string, string> = { install: 'Installed', update: 'Updated', remove: 'Removed' };

/** An installed map opens in the Amplifier once it is back in Recharge Next; until then the button says so. */
function amplifierButton(): HTMLButtonElement {
  const amp = button('Amplifier: coming soon', { kind: 'secondary', icon: 'amplifier', title: 'Editing maps in Recharge is coming soon' });
  amp.addEventListener('click', () => toast('The Amplifier is coming soon.', 'info'));
  return amp;
}

/** A local item (not on the hub): Remove by its folder (backed up like any remove), and the map's Amplifier button. */
function localActions(item: Item, folder: string, options: DetailOptions): HTMLElement {
  const box = h('div', {});
  const actions = h('div', { className: 'detail-actions' });
  const status = h('p', { className: 'detail-status dim', attrs: { role: 'status' } });
  if (item.kind === 'maps') actions.appendChild(amplifierButton());
  const remove = button('Remove', { kind: 'danger', title: 'Remove this folder (a backup is kept)' });
  let confirming = false;
  remove.addEventListener('click', () => {
    if (!confirming) {
      confirming = true;
      remove.querySelector('span')!.textContent = 'Click again to remove';
      window.setTimeout(() => { confirming = false; const label = remove.querySelector('span'); if (label) label.textContent = 'Remove'; }, 4000);
      return;
    }
    remove.disabled = true;
    status.className = 'detail-status dim';
    status.textContent = 'Removing…';
    call('library.removeFolder', { kind: item.kind, folder }).then(() => {
      toast('Removed ' + item.name + ' (a backup is kept)', 'success');
      status.textContent = '';
      options.onChanged?.(item);
    }, (error) => {
      remove.disabled = false;
      status.className = 'detail-status error';
      status.textContent = describeError(error);
    });
  });
  actions.appendChild(remove);
  box.append(actions, status);
  return box;
}

/** The Install / Update / Remove buttons with their busy state and error line. */
function actionButtons(item: Item, options: DetailOptions): HTMLElement {
  const actions = h('div', { className: 'detail-actions' });
  const status = h('p', { className: 'detail-status dim', attrs: { role: 'status' } });
  const plan = actionsOf(item, options.gameFound !== false);
  let busy = false;
  let confirming = false;
  const main = button(plan.main, {
    kind: 'primary',
    title: plan.reason || (plan.main === 'Update' ? 'Install the newer version over this one (the old one is backed up)' : 'Install'),
    disabled: !plan.canInstall,
    icon: plan.main === 'Installed' ? 'check' : 'download',
  });
  const remove = button('Remove', { kind: 'danger', title: 'Remove it (a backup is kept)' });
  remove.hidden = !plan.canRemove;

  const run = async (command: string, verb: 'install' | 'update' | 'remove', label: string) => {
    if (busy) return;
    busy = true;
    main.disabled = true;
    remove.disabled = true;
    status.className = 'detail-status dim';
    status.textContent = label;
    try {
      await call(command, { kind: item.kind, id: item.id, ...(item.kind === 'maps' ? { otherNames: options.otherNames || [] } : {}) });
      toast(PAST[verb] + ' ' + item.name, 'success');
      status.textContent = '';
      options.onChanged?.(item);
    } catch (error) {
      busy = false;
      main.disabled = !plan.canInstall;
      remove.disabled = false;
      status.className = 'detail-status error';
      status.textContent = describeError(error);
    }
  };

  main.addEventListener('click', () => {
    if (plan.canInstall) void run(plan.main === 'Update' ? 'library.update' : 'library.install', plan.main === 'Update' ? 'update' : 'install', plan.main === 'Update' ? 'Updating…' : 'Installing…');
  });
  remove.addEventListener('click', () => {
    if (!confirming) {
      confirming = true;
      remove.querySelector('span')!.textContent = 'Click again to remove';
      window.setTimeout(() => { confirming = false; const label = remove.querySelector('span'); if (label) label.textContent = 'Remove'; }, 4000);
      return;
    }
    void run('library.remove', 'remove', 'Removing…');
  });

  actions.appendChild(main);
  actions.appendChild(remove);
  // an installed skin can be worn straight from its page
  if (item.kind === 'skins' && item.installed && item.installed.folder) {
    actions.appendChild(skinApplyButton(item.installed.folder, item.name));
  }
  if (item.kind === 'maps' && item.installed && item.installed.folder) actions.appendChild(amplifierButton());
  // an installed background or playlist can be shown behind the app straight from its page
  if ((item.kind === 'backgrounds' || item.kind === 'playlists') && item.installed && item.installed.folder) {
    actions.appendChild(backgroundApplyButton(item.kind, item.installed.folder, item.name));
  }
  actions.appendChild(
    button('Open in browser', {
      kind: 'secondary',
      icon: 'chevron-right',
      onClick: () => {
        call('open.url', { url: itemWebUrl(item.kind, item.id) }).catch((error) => toast(describeError(error), 'error'));
      },
    })
  );
  const box = h('div', { className: 'detail-action-box' });
  box.appendChild(actions);
  box.appendChild(status);
  return box;
}

/** The side-panel body for one item. */
export function buildDetail(item: Item, options: DetailOptions = {}): Detail {
  const dispose: Array<() => void> = [];
  const root = h('div', { className: 'detail-panel' });
  root.appendChild(gallery(item, dispose));

  const head = h('div', { className: 'detail-head' });
  head.appendChild(h('p', { className: 'detail-kind', text: KIND_LABEL[item.kind] }));
  head.appendChild(h('h2', { className: 'detail-title', text: item.name }));
  if (item.author) {
    head.appendChild(h('p', { className: 'detail-by' }, 'by ', authorName(item.author, item.color)));
  }
  const badge = statusBadge(item);
  if (badge) head.appendChild(badge);
  root.appendChild(head);

  const meta = h('dl', { className: 'detail-meta' });
  const add = (label: string, value: string) => {
    if (!value) return;
    meta.appendChild(h('dt', { text: label }));
    meta.appendChild(h('dd', { text: value }));
  };
  add('Version', item.version);
  add('Revision', item.revision === null ? '' : String(item.revision));
  add('Type', item.type);
  add('Size', item.size === null ? '' : (item.size / 1048576).toFixed(1) + ' MB');
  add('Created', date(item.createdAt));
  add('Updated', date(item.updatedAt));
  if (item.installed) {
    add('Installed folder', item.installed.folder || '');
    add('Installed version', item.installed.version || '');
    add('Installed revision', item.installed.revision === null ? '' : String(item.installed.revision));
  }
  if (item.local) add('Source', 'Local only, not on the hub');
  root.appendChild(meta);

  if (item.description) root.appendChild(h('p', { className: 'detail-desc', text: item.description }));

  if (item.local && item.installed && item.installed.folder) root.appendChild(localActions(item, item.installed.folder, options));
  if (!item.local) {
    root.appendChild(actionButtons(item, options));
    if (item.kind !== 'games') root.appendChild(commentsSection(item));
  }
  return { element: root, dispose: () => dispose.forEach((fn) => fn()) };
}
