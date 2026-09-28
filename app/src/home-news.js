// "What's new": the newest mods, maps and skins added to the Recharge Library.
import { escapeHtml } from './ui.js';

const HUB = 'https://codecade.co.za/recharge';
const MAX_ENTRIES = 8;

function ago(iso) {
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
];

async function additions() {
  const lists = await Promise.all(
    LIBRARY.map(async (kind) => {
      try {
        return (await json(`${HUB}/api/${kind.path}`)).map((row) => ({
          kind: 'library',
          tag: kind.tag,
          tab: kind.tab,
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

// A skin's own image is the Unity animator sheet, not a curated thumbnail:
// always 6 rows in this fixed order (Idle, run, Fall, Jump, wallPose, Dash -
// see TemplateGrid.cs in recharge-skins), so row 0 is always Idle regardless
// of column count. Crops to that row's first (leftmost) frame, assuming
// roughly square cells like the rest of the skin pipeline does.
function applySkinThumb(el, src) {
  const probe = new Image();
  probe.onload = () => {
    const cellH = probe.naturalHeight / 6;
    const boxH = el.clientHeight;
    const boxW = el.clientWidth;
    const scale = boxH / cellH;
    el.style.backgroundImage = `url("${src}")`;
    el.style.backgroundSize = `${probe.naturalWidth * scale}px ${probe.naturalHeight * scale}px`;
    el.style.backgroundPosition = `${Math.max(0, (boxW - boxH) / 2)}px 0px`;
  };
  probe.onerror = () => el.remove();
  probe.src = src;
}

function render(entries) {
  const el = document.getElementById('home-news');
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = '<div class="home-install-sub">Nothing new in the library yet, or you are offline.</div>';
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const by = e.by ? ` \u00b7 ${escapeHtml(e.by)}` : '';
      const isSkin = e.tag === 'Skin';
      const img = !e.image
        ? ''
        : isSkin
          ? `<div class="news-img news-img-crop" data-skin-src="${escapeHtml(e.image)}"></div>`
          : `<img class="news-img" src="${escapeHtml(e.image)}" alt="" loading="lazy" onerror="this.remove()" />`;
      return `
      <div class="news-block" ${e.tab ? `onclick="navigate('${e.tab}')"` : ''}>
        <div class="news-meta"><span class="tag tag-${e.kind}">${escapeHtml(e.tag)}</span>${escapeHtml(ago(e.when))}${by}</div>
        <div class="news-title">${escapeHtml(e.title)}</div>
        ${img}
        ${e.body ? `<div class="news-body">${escapeHtml(e.body)}</div>` : ''}
      </div>`;
    })
    .join('');
  el.querySelectorAll('.news-img-crop').forEach((node) => applySkinThumb(node, node.dataset.skinSrc));
}

let entries = [];

export function layoutNews() {
  render(entries);
}

export async function initHomeNews() {
  entries = (await additions())
    .filter((e) => e.when)
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, MAX_ENTRIES);
  layoutNews();
}
