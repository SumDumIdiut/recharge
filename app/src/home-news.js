// "What's new": one feed mixing changes to Recharge itself (the commits on the
// channel you follow) with things recently added to the Recharge Library.
const REPO = 'SumDumIdiut/recharge';
const HUB = 'https://codecade.co.za/recharge';
const PER_SOURCE = 4; // so a burst of commits can't crowd out new library items, or the reverse
const MAX_ENTRIES = 8;
const NOISE = /^(Merge |Revert |Reapply |Release v|Version bump|Bring dev up to date|Promote dev)/i;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

async function channelBranch() {
  try {
    const info = await window.__TAURI__.core.invoke('live_get_channel');
    return info.channel === 'beta' ? 'dev' : 'master';
  } catch {
    return 'master';
  }
}

async function changes() {
  const branch = await channelBranch();
  const commits = await json(`https://api.github.com/repos/${REPO}/commits?sha=${branch}&per_page=40`);
  return commits
    .map((c) => {
      const [title, ...rest] = c.commit.message.split('\n');
      return { when: c.commit.author.date, title, body: rest.join(' ').replace(/\s+/g, ' ').trim(), url: c.html_url };
    })
    .filter((c) => !NOISE.test(c.title))
    .slice(0, PER_SOURCE)
    .map((c) => ({ kind: 'change', tag: 'Update', ...c }));
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
  return lists.flat().sort((a, b) => new Date(b.when) - new Date(a.when)).slice(0, PER_SOURCE);
}

function render(entries) {
  const el = document.getElementById('home-news');
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = '<div class="home-install-sub">Nothing to show yet - check your connection.</div>';
    return;
  }
  el.innerHTML = entries
    .map((e) => {
      const by = e.by ? ` \u00b7 ${escapeHtml(e.by)}` : '';
      const action = e.tab
        ? `<button class="btn" onclick="navigate('${e.tab}')">View in ${escapeHtml(e.tag)}s</button>`
        : e.url
          ? `<button class="btn" onclick="window.__newsOpen('${escapeHtml(e.url)}')">Open in browser</button>`
          : '';
      return `
      <div class="news-block">
        <div class="news-meta"><span class="news-tag news-tag-${e.kind}">${escapeHtml(e.tag)}</span>${escapeHtml(ago(e.when))}${by}</div>
        <div class="news-title">${escapeHtml(e.title)}</div>
        ${e.image ? `<img class="news-img" src="${escapeHtml(e.image)}" alt="" loading="lazy" onerror="this.remove()" />` : ''}
        ${e.body ? `<div class="news-body">${escapeHtml(e.body)}</div>` : ''}
        ${action ? `<div class="news-actions">${action}</div>` : ''}
      </div>`;
    })
    .join('');
}

window.__newsOpen = (url) => {
  const opener = window.__TAURI__?.opener;
  if (opener?.openUrl) opener.openUrl(url).catch(() => window.open(url, '_blank'));
  else window.open(url, '_blank');
};

export async function initHomeNews() {
  const results = await Promise.allSettled([changes(), additions()]);
  const entries = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((e) => e.when)
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, MAX_ENTRIES);
  render(entries);
}
