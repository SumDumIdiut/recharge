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
      const action = e.tab
        ? `<button class="btn" onclick="navigate('${e.tab}')">View in ${escapeHtml(e.tag)}s</button>`
        : '';
      return `
      <div class="news-block">
        <div class="news-meta"><span class="tag tag-${e.kind}">${escapeHtml(e.tag)}</span>${escapeHtml(ago(e.when))}${by}</div>
        <div class="news-title">${escapeHtml(e.title)}</div>
        ${e.image ? `<img class="news-img" src="${escapeHtml(e.image)}" alt="" loading="lazy" onerror="this.remove()" />` : ''}
        ${e.body ? `<div class="news-body">${escapeHtml(e.body)}</div>` : ''}
        ${action ? `<div class="news-actions">${action}</div>` : ''}
      </div>`;
    })
    .join('');
}

let entries = [];

// Draws every block, then drops from the end until the panel stops overflowing.
export function layoutNews() {
  const el = document.getElementById('home-news');
  if (!el) return;
  render(entries);
  if (!el.clientHeight) return; // panel hidden right now - lay out again when it's shown
  let blocks = el.querySelectorAll('.news-block');
  for (let i = blocks.length; i > 1 && el.scrollHeight > el.clientHeight + 1; i--) {
    blocks[i - 1].remove();
  }
}

export async function initHomeNews() {
  entries = (await additions())
    .filter((e) => e.when)
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, MAX_ENTRIES);
  layoutNews();
  window.addEventListener('resize', layoutNews);
}
