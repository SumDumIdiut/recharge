import { MAP_CATALOG } from './catalog.js';

let currentSubtab = 'installed';
let searchTerm = '';
let installedCache = [];

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function matchesSearch(haystack) {
  if (!searchTerm) return true;
  return haystack.toLowerCase().includes(searchTerm.toLowerCase());
}

function renderInstalled() {
  const list = document.getElementById('maps-installed-view');
  const filtered = installedCache
    .filter((m) => !m.id.startsWith('_'))
    .filter((m) => matchesSearch(m.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    list.innerHTML = installedCache.length
      ? '<div class="empty-state">No maps match your search.</div>'
      : '<div class="empty-state">No maps installed yet. Browse the catalog to add one.</div>';
    return;
  }
  list.innerHTML = filtered
    .map(
      (m) => `
    <div class="browse-card">
      <div class="browse-card-top">
        <div>
          <div class="browse-card-name">${escapeHtml(m.name)}</div>
          <div class="browse-card-meta">${m.groupCount} course${m.groupCount === 1 ? '' : 's'}</div>
        </div>
      </div>
    </div>`
    )
    .join('');
}

function renderBrowse() {
  const list = document.getElementById('maps-browse-view');
  const filtered = MAP_CATALOG
    .filter((m) => matchesSearch(m.name + ' ' + (m.description || '') + ' ' + (m.author || '')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No maps published yet.</div>';
    return;
  }
  list.innerHTML = filtered
    .map(
      (entry) => `
    <div class="browse-card">
      <div class="browse-card-top">
        <div>
          <div class="browse-card-name">${escapeHtml(entry.name)}</div>
          <div class="browse-card-meta">${escapeHtml(entry.author || '')}</div>
        </div>
      </div>
      <div class="browse-card-desc">${escapeHtml(entry.description || '')}</div>
    </div>`
    )
    .join('');
}

function render() {
  // Same self-heal as mods/script.js: a hub-beam install re-fetches this
  // tab's view.html from scratch, resetting the subtab buttons' "active"
  // class to their hardcoded default - resync it against currentSubtab.
  document.querySelectorAll('#view-maps .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === currentSubtab));
  document.getElementById('maps-installed-view').style.display = currentSubtab === 'installed' ? '' : 'none';
  document.getElementById('maps-browse-view').style.display = currentSubtab === 'browse' ? '' : 'none';
  renderInstalled();
  renderBrowse();
}

window.__mapsSubtab = function (tab) {
  currentSubtab = tab;
  document.querySelectorAll('#view-maps .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === tab));
  render();
};

window.__mapsSearch = function (value) {
  searchTerm = value;
  render();
};

export async function init() {
  const { invoke } = window.__TAURI__.core;
  installedCache = await invoke('list_maps');
  render();
}
