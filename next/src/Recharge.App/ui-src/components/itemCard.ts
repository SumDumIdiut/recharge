import { h } from '../dom.js';
import { icon } from '../icons.js';
import { skinCanvas } from '../lib/skinThumb.js';
import { imageBlobUrl } from '../lib/hub.js';
import { loadInstalled } from '../lib/hub.js';
import { modSwitch } from './modSwitch.js';
import { sourceBadge } from './sourceLink.js';
import { styleName } from '../profile/render.js';
import { watchStyle } from '../profile/store.js';
import { itemRoute, KIND_LABEL, nameStyle, type Item, type Kind } from '../lib/library.js';

export const KIND_ICON: Record<Kind, string> = {
  maps: 'maps',
  mods: 'mods',
  skins: 'skins',
  backgrounds: 'backgrounds',
  playlists: 'play',
  games: 'gamepad',
};

/**
 * An author name drawn in its (validated) colour or gradient. When the author has an extended profile (looked up in one cached
 * batch with every other name on the page) its name style is applied in a compact form; until then, or without one, the hub's
 * colour is used as before.
 */
export function authorName(author: string, color: string | null, className = 'author', compact = true): HTMLElement {
  const node = h('span', { className, text: author });
  const style = nameStyle(color);
  if (style.color) node.style.color = style.color;
  if (style.background) {
    node.style.background = style.background;
    node.style.setProperty('-webkit-background-clip', 'text');
    node.style.backgroundClip = 'text';
    node.style.color = 'transparent';
  }
  if (author && author !== '[deleted]') {
    watchStyle(author, (look) => {
      if (look) styleName(node, look.name, { compact, legacy: { color: style.color, background: style.background } });
    });
  }
  return node;
}

/** A cover for items without a picture: the kind's colour on a faint grid, its icon in a ring, and a caption. */
export function kindPlaceholder(kind: Kind, caption: string = KIND_LABEL[kind]): HTMLElement {
  const box = h('div', { className: 'card-ph kind-' + kind });
  const ring = h('div', { className: 'ph-ring' });
  ring.appendChild(icon(KIND_ICON[kind], 30));
  box.appendChild(ring);
  if (caption) box.appendChild(h('div', { className: 'ph-caption', text: caption }));
  return box;
}

/** What the cover says for an item with no picture. */
function coverCaption(item: Item): string {
  if (item.kind === 'mods' && item.modId) return item.modId;
  if (item.kind === 'games' && item.version) return 'Build ' + item.version;
  if (item.local) return 'Local ' + KIND_LABEL[item.kind].toLowerCase();
  return KIND_LABEL[item.kind];
}

/**
 * Makes a skin sheet show as its character: once the image loads, the first real frame is cut out and drawn large and sharp.
 * A sheet with no character frame keeps the cover.
 */
export function showSkinFrame(box: HTMLElement, image: HTMLImageElement): boolean {
  const canvas = skinCanvas(image, box.clientWidth || 320, box.clientHeight || 180);
  if (canvas) box.replaceChildren(canvas);
  // No character frame (e.g. a sound-only skin): keep the original image as the fallback.
  return !!canvas;
}

export function statusBadge(item: Item): HTMLElement | null {
  if (item.local) return h('span', { className: 'badge badge-local', text: 'Local' });
  if (item.status === 'update') return h('span', { className: 'badge badge-update', text: 'Update' });
  if (item.status === 'installed') return h('span', { className: 'badge badge-installed', text: 'Installed' });
  return null;
}

/**
 * A skin card's picture: the first character frame of its sheet, loaded (through the bridge) once the card scrolls near the view.
 * A sheet with no character (an empty template) tries the next gallery picture; when none has one, the card keeps its
 * placeholder. The raw sheet is never shown.
 */
function skinMedia(item: Item, media: HTMLElement): HTMLElement {
  const box = h('div', { className: 'media-box card-img' });
  const tryFile = (index: number) => {
    if (index >= Math.min(item.gallery.length, 3)) return;
    imageBlobUrl(item.kind, item.id, item.gallery[index]).then((url) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => { if (showSkinFrame(box, image)) media.classList.add('has-img'); else tryFile(index + 1); };
      image.onerror = () => tryFile(index + 1);
      image.src = url;
    }, () => { /* the placeholder stays */ });
  };
  const start = () => tryFile(0);
  if (typeof IntersectionObserver === 'undefined') { start(); return box; }
  const seen = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { seen.disconnect(); start(); }
  }, { rootMargin: '240px 0px' });
  seen.observe(box);
  return box;
}

/** A map/mod/background card's picture: loaded through the bridge (blob URL) once the card scrolls near the view.
 *  A direct https:// URL from imageUrl() fails under the recharge:// URI scheme, so gallery images always come via the bridge. */
function hubMedia(item: Item, media: HTMLElement): HTMLElement {
  const box = h('div', { className: 'media-box card-img' });
  const start = () => {
    imageBlobUrl(item.kind, item.id, item.gallery[0]).then((url) => {
      const image = new Image();
      image.decoding = 'async';
      image.className = 'pixel';
      image.onload = () => { box.appendChild(image); media.classList.add('has-img'); fitImage(image, box); };
      image.onerror = () => { /* the cover stays */ };
      image.src = url;
    }, () => { /* the cover stays */ });
  };
  if (typeof IntersectionObserver === 'undefined') { start(); return box; }
  const seen = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { seen.disconnect(); start(); }
  }, { rootMargin: '240px 0px' });
  seen.observe(box);
  return box;
}

/** Just an item's picture (placeholder or gallery image) — no name, author or badges. Used by image-only tiles like home's "New on the hub". */
export function itemMedia(item: Item): HTMLElement {
  const media = h('div', { className: 'card-media kind-' + item.kind });
  media.appendChild(kindPlaceholder(item.kind, ''));
  if (item.gallery.length > 0 && !item.local) {
    if (item.kind === 'skins') media.appendChild(skinMedia(item, media));
    else media.appendChild(hubMedia(item, media));
  }
  return media;
}

/**
 * Picks how a loaded picture sits in its box. Pictures that fit are shown 1:1 and never blown up; very wide or tall ones are shown
 * whole on the dark box instead of cropped; others fill the box. Pixel art that is scaled up stays sharp (pixelated), scaled down it is smooth.
 */
export function fitImage(image: HTMLImageElement, box: HTMLElement, mode: 'cover' | 'contain' = 'cover', forcePixel = false): void {
  const nw = image.naturalWidth, nh = image.naturalHeight;
  const bw = box.clientWidth, bh = box.clientHeight;
  if (!nw || !nh || !bw || !bh) return;
  const ratio = nw / nh;
  let fit: string = mode;
  if (mode === 'cover' && (ratio > 2.4 || ratio < 1.2)) fit = 'contain';
  const scale = fit === 'cover' ? Math.max(bw / nw, bh / nh) : Math.min(bw / nw, bh / nh);
  if (mode === 'cover' && scale > 1) fit = 'none'; // a small source is not zoomed past 1:1
  image.style.objectFit = fit;
  const shown = fit === 'none' ? 1 : scale;
  image.classList.toggle('pixel', forcePixel || shown * (window.devicePixelRatio || 1) > 1);
}

/** Queueing for install: shown as a corner check on a card, with a progress line once the queue runs. */
export interface CardSelect {
  selected: boolean;
  /** Where this card is in a running queue. */
  state?: 'queued' | 'installing' | 'installed' | 'failed';
  /** Why it failed. */
  message?: string;
  /** Whether it can be queued (already-installed items cannot). */
  canSelect: boolean;
  onToggle: () => void;
  /** Installs (or updates) this card straight away. */
  onInstall?: () => void;
  busy?: boolean;
}

const QUEUE_TEXT = { queued: 'Queued', installing: 'Installing…', installed: 'Installed', failed: 'Failed' };

/**
 * A library card that can also be queued: the body still opens the details; the corner check toggles the queue
 * (a real button, so Tab and Space work). The card sits in a cell so the button is not nested inside the link.
 */
export function selectableCard(item: Item, select: CardSelect): HTMLElement {
  const cell = h('div', { className: 'item-cell' + (select.selected ? ' is-selected' : '') + (select.state ? ' is-' + select.state : '') });
  cell.appendChild(itemCard(item));
  if (select.canSelect || select.selected) {
    const check = h('button', {
      className: 'card-select',
      title: select.selected ? 'Remove from the install queue' : 'Add to the install queue',
      attrs: { type: 'button', role: 'checkbox', 'aria-checked': select.selected ? 'true' : 'false', 'aria-label': 'Queue ' + item.name + ' to install' },
    });
    if (select.selected) check.appendChild(icon('check', 18));
    check.addEventListener('click', select.onToggle);
    cell.appendChild(check);
  }
  if (select.onInstall && select.canSelect && !select.busy) {
    const update = item.status === 'update';
    const go = h('button', {
      className: 'card-install',
      title: (update ? 'Update ' : 'Install ') + item.name,
      attrs: { type: 'button', 'aria-label': (update ? 'Update ' : 'Install ') + item.name },
    });
    go.appendChild(icon(update ? 'refresh' : 'download', 18));
    go.addEventListener('click', select.onInstall);
    cell.appendChild(go);
  }
  if (select.state) {
    const line = h('div', { className: 'card-queue', text: QUEUE_TEXT[select.state] + (select.state === 'failed' && select.message ? ': ' + select.message : ''), attrs: { role: 'status' } });
    if (select.state === 'failed') line.title = select.message || '';
    cell.appendChild(line);
  }
  return cell;
}

/** A library card: image (or placeholder), name, author, kind and status badges. */
export function itemCard(item: Item): HTMLElement {
  const card = h('a', {
    className: 'item-card',
    attrs: { href: itemRoute(item), 'aria-label': item.name },
  });
  const media = h('div', { className: 'card-media kind-' + item.kind });
  media.appendChild(kindPlaceholder(item.kind, coverCaption(item)));
  if (item.gallery.length > 0 && !item.local && item.kind === 'skins') {
    media.appendChild(skinMedia(item, media));
  } else if (item.gallery.length > 0 && !item.local) {
    media.appendChild(hubMedia(item, media));
  }
  card.appendChild(media);

  const body = h('div', { className: 'card-body' });
  body.appendChild(h('div', { className: 'card-name', text: item.name, title: item.name }));
  const meta = h('div', { className: 'card-meta' });
  if (item.author) meta.appendChild(authorName(item.author, item.color));
  else if (item.local) meta.appendChild(h('span', { className: 'author dim', text: 'Installed locally' }));
  body.appendChild(meta);
  const badges = h('div', { className: 'card-badges' });
  badges.appendChild(h('span', { className: 'badge badge-kind kind-' + item.kind, text: KIND_LABEL[item.kind] }));
  const status = statusBadge(item);
  if (status) badges.appendChild(status);
  body.appendChild(badges);
  const source = sourceBadge(item);
  if (source) badges.appendChild(source);
  const toggle = modSwitch(item, () => { void loadInstalled(true); });
  if (toggle) badges.appendChild(toggle);
  card.appendChild(body);
  return card;
}

/** Wait (up to ms) for images that already have a src to finish; resolves early when settled. */
export function imagesSettled(root: HTMLElement, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    let quiet = 0;
    const tick = () => {
      const pending = Array.from(root.querySelectorAll('img')).filter(
        (image) => (image.getAttribute('src') || image.dataset.src) && !image.complete && !image.classList.contains('is-broken')
      );
      quiet = pending.length === 0 && root.querySelector('.item-card, .mini-row, .hub-tile') ? quiet + 1 : 0;
      if (quiet >= 3 || Date.now() - started > ms) {
        resolve();
        return;
      }
      window.setTimeout(tick, 120);
    };
    window.setTimeout(tick, 120);
  });
}
