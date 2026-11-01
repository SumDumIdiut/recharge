/** Draws a whole profile (banner, header, ordered sections) from the hub data plus the extended look. Used by the player page and the editor preview. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { imageBlobUrl } from '../lib/hub.js';
import { KIND_LABEL, type Kind } from '../lib/library.js';
import { kindPlaceholder, showSkinFrame } from '../components/itemCard.js';
import { loadKind } from '../lib/hub.js';
import { libraryKind, libraryRoute, monthYear, type Profile, type Upload } from '../community/format.js';
import { hubImage } from '../community/api.js';
import { personChip, playerAvatar } from '../community/people.js';
import {
  applyDesc, bannerNode, bioNodes, linkChip, paintAvatar, paintBanner, styleName, themeDesc,
  type AvatarOptions,
} from './render.js';
import { isExpired, type Ext, type ShowcaseItem } from './schema.js';
import { EXCLUSIVE_THEMES, ownsStyle } from './exclusive.js';
import { nameStyle } from '../lib/library.js';

export interface ProfileData {
  hub: Profile;
  ext: Ext;
  /** The visitor may only see the name and picture style. */
  restricted?: boolean;
  friendCount?: number | null;
  friends?: string[];
  /** The extended profile is a draft (the editor preview). */
  preview?: boolean;
}

export interface PageOptions {
  open: (href: string) => void;
  /** Action buttons for the header (Edit profile, Add friend). */
  actions?: HTMLElement | null;
  /** A picture to use instead of the hub's (the editor, before upload). */
  avatarSrc?: string | null;
  bannerSrc?: string | null;
  presence?: string | null;
  now?: number;
}

function kindOf(kind: string): Kind | null {
  const k = libraryKind(kind);
  return k ? (k as Kind) : null;
}


/**
 * The item's picture in `media` (a .card-media / art box): its gallery's first image, looked up in the hub's cached lists when
 * only the id is known, with skins drawn as their character. The kind's cover stays underneath until (or unless) it loads.
 */
export function fillItemArt(media: HTMLElement, kind: Kind, id: string, gallery?: string[]): void {
  media.classList.add('kind-' + kind);
  media.appendChild(kindPlaceholder(kind, ''));
  const known = gallery && gallery.length ? Promise.resolve(gallery[0]) :
    loadKind(kind).then((items) => items.find((i) => i.id === id)?.gallery[0] || null, () => null);
  void known.then((file) => {
    if (!file) return;
    return imageBlobUrl(kind, id, file).then((url) => {
      const box = h('div', { className: 'media-box card-img' });
      const image = h('img', { attrs: { alt: '', decoding: 'async' } });
      if (kind === 'skins') image.classList.add('pixel');
      image.onload = () => { if (kind !== 'skins' || showSkinFrame(box, image)) media.classList.add('has-img'); };
      box.appendChild(image);
      media.appendChild(box);
      image.src = url;
    });
  }).catch(() => undefined);
}

export function uploadCard(upload: Upload, interactive = true): HTMLElement {
  const href = interactive ? libraryRoute(upload.kind, upload.id) : null;
  const card = h(href ? 'a' : 'div', { className: 'item-card profile-upload', attrs: href ? { href } : {} });
  const media = h('div', { className: 'card-media' });
  const kind = kindOf(upload.kind);
  if (kind) fillItemArt(media, kind, upload.id, upload.gallery);
  card.appendChild(media);
  const body = h('div', { className: 'card-body' });
  body.appendChild(h('div', { className: 'card-name', text: upload.name, title: upload.name }));
  const badges = h('div', { className: 'card-badges' });
  if (kind) badges.appendChild(h('span', { className: 'badge badge-kind kind-' + kind, text: KIND_LABEL[kind] || kind }));
  if (upload.version) badges.appendChild(h('span', { className: 'badge', text: 'v' + upload.version }));
  body.appendChild(badges);
  card.appendChild(body);
  return card;
}

function showcaseCard(item: ShowcaseItem, uploads: Upload[], interactive: boolean): HTMLElement {
  const upload = uploads.find((u) => u.id === item.id && u.kind === item.kind);
  if (upload) return uploadCard({ ...upload, name: item.name || upload.name }, interactive);
  const kind = kindOf(item.kind);
  const href = interactive ? libraryRoute(item.kind, item.id) : null;
  const card = h(href ? 'a' : 'div', { className: 'item-card profile-upload', attrs: href ? { href } : {} });
  const media = h('div', { className: 'card-media' });
  if (kind) fillItemArt(media, kind, item.id);
  card.appendChild(media);
  const body = h('div', { className: 'card-body' });
  body.appendChild(h('div', { className: 'card-name', text: item.name || item.id, title: item.name || item.id }));
  if (kind) body.appendChild(h('div', { className: 'card-badges' }, h('span', { className: 'badge badge-kind kind-' + kind, text: KIND_LABEL[kind] || kind })));
  card.appendChild(body);
  return card;
}

function section(id: string, title: string, ...children: Array<Node | null>): HTMLElement {
  // No visible heading, to keep profiles compact: the title stays as the section's accessible name.
  const node = h('section', { className: 'psec psec-' + id, attrs: title ? { 'aria-label': title } : {} });
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

function statValue(id: string, d: ProfileData): { n: number; label: string } | null {
  const p = d.hub;
  switch (id) {
    case 'uploads': return { n: p.uploads.length, label: p.uploads.length === 1 ? 'upload' : 'uploads' };
    case 'threads': return { n: p.posts, label: p.posts === 1 ? 'thread' : 'threads' };
    case 'replies': return { n: p.replies, label: p.replies === 1 ? 'reply' : 'replies' };
    case 'comments': return { n: p.comments, label: p.comments === 1 ? 'comment' : 'comments' };
    case 'friends': return d.friendCount === null || d.friendCount === undefined ? null : { n: d.friendCount, label: d.friendCount === 1 ? 'friend' : 'friends' };
    default: return null;   // "maps played" has no source yet: it appears when the data does
  }
}

function dateOf(iso: string): string {
  return monthYear(iso) || '';
}

function sectionBody(id: string, d: ProfileData, o: PageOptions): HTMLElement | null {
  const ext = d.ext;
  const interactive = !d.preview;
  const hub = d.hub;
  switch (id) {
    case 'about': {
      const bio = ext.content.bio;
      if (!bio) return d.preview ? section('about', 'About', h('p', { className: 'dim', text: 'Your bio shows here.' })) : null;
      return section('about', 'About', h('p', { className: 'profile-bio' }, ...bioNodes(bio, o.open)));
    }
    case 'showcase': {
      const f = ext.content.featured;
      const items = ext.content.showcase;
      if (!f && items.length === 0) return d.preview ? section('showcase', 'Showcase', h('p', { className: 'dim', text: 'Pick favourites to show off.' })) : null;
      const parts: Array<Node | null> = [];
      if (f) {
        const k = kindOf(f.kind);
        const href = interactive ? libraryRoute(f.kind, f.id) : null;
        const box = h(href ? 'a' : 'div', { className: 'pfeatured', attrs: href ? { href } : {} });
        const art = h('div', { className: 'pfeatured-art card-media' });
        if (k) fillItemArt(art, k, f.id, hub.uploads.find((u) => u.id === f.id && kindOf(u.kind) === k)?.gallery);
        const copy = h('div', { className: 'pfeatured-copy' },
          h('span', { className: 'pfeatured-tag', text: 'Featured ' + (k ? (KIND_LABEL[k] || k).toLowerCase() : 'item') }),
          h('div', { className: 'pfeatured-name', text: f.name || f.id }),
          f.note ? h('p', { className: 'pfeatured-note', text: f.note }) : null);
        box.append(art, copy);
        parts.push(box);
      }
      if (items.length) {
        const grid = h('div', { className: 'card-grid pshowcase' });
        grid.style.setProperty('--card-min', '200px');
        for (const item of items) grid.appendChild(showcaseCard(item, hub.uploads, interactive));
        parts.push(grid);
      }
      return section('showcase', 'Showcase', ...parts);
    }
    case 'uploads': {
      if (hub.uploads.length === 0) return section('uploads', 'Published', h('p', { className: 'dim', text: hub.author.username + ' has not published anything yet.' }));
      const grid = h('div', { className: 'card-grid' });
      grid.style.setProperty('--card-min', '220px');
      for (const upload of hub.uploads) grid.appendChild(uploadCard(upload, interactive));
      return section('uploads', 'Published', grid);
    }
    case 'stats': {
      const shown = ext.stats.show.map((s) => ({ id: s, v: statValue(s, d) })).filter((x) => x.v);
      if (shown.length === 0) return null;
      const row = h('div', { className: 'pstats pstats-' + ext.stats.style });
      for (const { v } of shown) {
        if (!v) continue;
        row.appendChild(h('div', { className: 'pstat' }, h('span', { className: 'pstat-n', text: String(v.n) }), h('span', { className: 'pstat-l', text: v.label })));
      }
      return section('stats', '', row);
    }
    case 'links': {
      const links = ext.content.links;
      if (links.length === 0) return d.preview ? section('links', 'Links', h('p', { className: 'dim', text: 'Your links show here.' })) : null;
      const row = h('div', { className: 'profile-links' });
      for (const l of links) row.appendChild(linkChip(l, o.open));
      return section('links', 'Links', row);
    }
    case 'friends': {
      if (d.friendCount === null || d.friendCount === undefined) return d.preview ? section('friends', 'Friends', h('p', { className: 'dim', text: 'Your friends count shows here.' })) : null;
      const row = h('div', { className: 'pfriends' });
      for (const name of d.friends ?? []) {
        row.appendChild(personChip({ username: name, avatar_url: null, frame: 'none', frame_colors: [], name_color: null }, 28));
      }
      return section('friends', d.friendCount + (d.friendCount === 1 ? ' friend' : ' friends'), row.childElementCount ? row : null);
    }
    case 'activity': {
      const rows = hub.uploads.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 5);
      const list = h('ul', { className: 'pactivity' });
      for (const u of rows) {
        const k = kindOf(u.kind);
        list.appendChild(h('li', {}, h('span', { className: 'pactivity-dot' }), h('span', { text: 'Published ' }),
          interactive && libraryRoute(u.kind, u.id) ? h('a', { attrs: { href: libraryRoute(u.kind, u.id)! }, text: u.name }) : h('strong', { text: u.name }),
          h('span', { className: 'dim', text: (k ? ' · ' + (KIND_LABEL[k] || k).toLowerCase() : '') + (dateOf(u.createdAt) ? ' · ' + dateOf(u.createdAt) : '') })));
      }
      const joined = monthYear(hub.createdAt);
      if (joined) list.appendChild(h('li', {}, h('span', { className: 'pactivity-dot' }), h('span', { text: 'Joined Recharge' }), h('span', { className: 'dim', text: ' · ' + joined })));
      return section('activity', 'Activity', list.childElementCount ? list : h('p', { className: 'dim', text: 'Nothing yet.' }));
    }
    default:
      return null;
  }
}

/** The full profile. Sections follow the owner's order and visibility; a restricted view shows only the header. */
export function renderProfile(d: ProfileData, o: PageOptions): HTMLElement {
  const ext = d.ext;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const page = h('div', { className: 'profile profile-page' });
  applyDesc(page, themeDesc(ext.theme, { fallbackAccent: d.hub.accentColor }));
  const sig = ext.theme.preset ? EXCLUSIVE_THEMES[ext.theme.preset] : undefined;
  if (sig && ownsStyle(sig.owner, d.hub.author.username)) page.classList.add('pt-sig', 'pt-sig-' + ext.theme.preset);
  page.appendChild(h('div', { className: 'pt-bgl', attrs: { 'aria-hidden': 'true' } }));

  const card = h('section', { className: 'panel profile-card' });
  const banner = bannerNode(ext.banner, o.bannerSrc ?? null);
  if (ext.banner.mode === 'image' && !o.bannerSrc && d.hub.bannerUrl) {
    void hubImage(d.hub.bannerUrl).then((url) => { if (url) paintBanner(banner, ext.banner, url); });
  }
  card.appendChild(banner);

  const head = h('div', { className: 'profile-head' });
  const author = d.hub.author;
  const avatarOptions: AvatarOptions = {
    username: author.username, frame: author.frame, frameColors: author.frame_colors, nameColor: author.name_color,
    avatarPath: author.avatar_url, size: 104, style: ext.avatar, presence: o.presence ?? null, load: hubImage, src: o.avatarSrc ?? null,
  };
  const avatar = playerAvatar(author, 104, { style: ext.avatar, presence: o.presence ?? null });
  if (o.avatarSrc) paintAvatar(avatar, avatarOptions);
  head.appendChild(avatar);
  const who = h('div', { className: 'profile-who' });
  const nameRow = h('div', { className: 'profile-name-row' });
  const name = h('span', { className: 'profile-name', text: author.username });
  const legacy = nameStyle(author.name_color);
  styleName(name, ext.name, { compact: false, legacy: { color: legacy.color, background: legacy.background } });
  nameRow.appendChild(name);
  if (d.hub.admin) nameRow.appendChild(h('span', { className: 'badge badge-installed', text: 'Admin' }));
  who.appendChild(nameRow);
  const sub: string[] = [];
  if (ext.content.pronouns) sub.push(ext.content.pronouns);
  const joined = monthYear(d.hub.createdAt);
  if (joined) sub.push('Joined ' + joined);
  if (sub.length) who.appendChild(h('div', { className: 'dim', text: sub.join(' · ') }));
  const status = ext.content.status;
  if (!d.restricted && (status.text || status.emoji) && !isExpired(status, now)) {
    who.appendChild(h('div', { className: 'pstatus' }, status.emoji ? h('span', { className: 'pstatus-emoji', text: status.emoji }) : null, status.text ? h('span', { text: status.text }) : null));
  }
  head.appendChild(who);
  if (o.actions) head.appendChild(o.actions);
  card.appendChild(head);

  if (d.restricted) {
    card.appendChild(h('p', { className: 'profile-bio dim', text: author.username + ' only shows the rest of their profile to friends.' }));
    page.appendChild(card);
    return page;
  }


  page.appendChild(card);
  for (const s of ext.sections) {
    if (!s.on) continue;
    const body = sectionBody(s.id, d, o);
    if (body) page.appendChild(body);
  }
  return page;
}
