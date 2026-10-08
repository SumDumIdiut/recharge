// "What's new": the newest Library additions plus Recharge releases.
import { escapeHtml } from './ui.js';
import { mapThumbFor } from './maps/mapthumb.js';

const HUB = 'https://codecade.co.za/recharge';
const MAX_ENTRIES = 10;

export function ago(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(secs >= 0)) return '';
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 86400 * 30) return `${Math.round(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

async function json(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const LIBRARY = [
  { path: 'mods', tag: 'Mod', tab: 'mods' },
  { path: 'maps', tag: 'Map', tab: 'maps' },
  { path: 'skins', tag: 'Skin', tab: 'skins' },
  { path: 'backgrounds', tag: 'Background', tab: 'backgrounds' },
  { path: 'playlists', tag: 'Playlist', tab: 'backgrounds' },
];

async function additions() {
  const lists = await Promise.all(
    LIBRARY.map(async (kind) => {
      try {
        return (await json(`${HUB}/api/${kind.path}`)).map((row) => ({
          kind: 'library',
          tag: kind.tag,
          tab: kind.tab,
          id: row.id,
          when: row.createdAt,
          title: row.name,
          by: row.author,
          body: row.description || '',
          image: row.gallery?.length ? `${HUB}/api/${kind.path}/${row.id}/gallery/${encodeURIComponent(row.gallery[0])}` : null,
        }));
      } catch {
        return [];
      }
    })
  );
  return lists.flat();
}

// The user's release channel: the launcher's when managed, else the live-code one.
async function userChannel() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return 'stable';
  const info = await invoke('launcher_info').catch(() => null);
  if (info?.managed && info.channel) return info.channel;
  return invoke('live_get_channel').then((c) => c.channel).catch(() => 'stable');
}

// changelog.json -> feed entries ("Recharge 4.0.0" with its change list).
export function releaseEntries(data) {
  const list = Array.isArray(data?.entries) ? data.entries : [];
  return list.map((e) => ({
    kind: 'release',
    tag: 'Recharge',
    tab: null,
    when: e.date,
    title: `Recharge ${e.version ?? '?'}`,
    changes: Array.isArray(e.changes) ? e.changes.map(String) : [],
  }));
}

async function releases() {
  try {
    return releaseEntries(await json(`${HUB}/update/${await userChannel()}/changelog.json`));
  } catch {
    return [];
  }
}

export function mergeEntries(lists, max = MAX_ENTRIES) {
  return lists.flat()
    .filter((e) => e.when && !isNaN(new Date(e.when)))
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, max);
}

// A skin's own image is the Unity animator sheet, not a curated thumbnail:
// always 6 rows in this fixed order (Idle, run, Fall, Jump, wallPose, Dash -
// see TemplateGrid.cs in recharge-skins), so row 0 is always Idle regardless
// of column count. Crops to that row's first (leftmost) frame, assuming
// roughly square cells like the rest of the skin pipeline does.
function applySkinThumb(el, src) {
  const probe = new Image();
  probe.onload = () => {
    const cellH = probe.naturalHeight / 6;
    const scale = el.clientHeight / cellH;
    el.style.backgroundImage = `url("${src}")`;
    el.style.backgroundSize = `${probe.naturalWidth * scale}px ${probe.naturalHeight * scale}px`;
    el.style.backgroundPosition = '0 0';
  };
  probe.onerror = () => el.remove();
  probe.src = src;
}

export function renderNews(entries) {
  const el = document.getElementById('home-news');
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = '<div class="home-install-sub">Nothing new yet, or you are offline.</div>';
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const by = e.by ? ` \u00b7 ${escapeHtml(e.by)}` : '';
      const isSkin = e.tag === 'Skin';
      const img = !e.image
        ? ''
        : isSkin
          ? `<div class="news-img-crop" data-skin-src="${escapeHtml(e.image)}"></div>`
          : `<img class="news-img" src="${escapeHtml(e.image)}" alt="" loading="lazy" onerror="this.remove()" />`;
      return `
      <div class="news-block" ${e.tab ? `onclick="navigate('${e.tab}')"` : ''}>
        <div class="news-meta"><span class="tag tag-${e.kind}">${escapeHtml(e.tag)}</span>${escapeHtml(ago(e.when))}${by}</div>
        <div class="news-title">${escapeHtml(e.title)}</div>
        ${img}
        ${e.changes?.length ? `<ul class="news-changes">${e.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
        ${e.body ? `<div class="news-body">${escapeHtml(e.body)}</div>` : ''}
      </div>`;
    })
    .join('');
  el.querySelectorAll('.news-img-crop').forEach((node) => applySkinThumb(node, node.dataset.skinSrc));
}

let entries = [];

export function layoutNews() {
  renderNews(entries);
}

export async function initHomeNews() {
  entries = mergeEntries(await Promise.all([additions(), releases()]));
  layoutNews();
  // Maps get the same extracted fullmap picture as the Maps tab instead (a
  // Hub gallery image, when there is one, stays the fallback until it arrives).
  for (const e of entries) {
    if (e.tag !== 'Map' || !e.id) continue;
    const img = await mapThumbFor(e.id).catch(() => null);
    if (img) { e.image = img; layoutNews(); }
  }
}
