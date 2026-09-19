import { getToken, getUsername, isLoggedIn } from '../auth.js';

const HUB_BASE = 'https://codecade.co.za/recharge';

let currentSubtab = 'installed';
let searchTerm = '';
let installedCache = [];
let catalog = [];
let catalogError = false;
let chosenUploadPath = null;
let myUploadIds = new Set();

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function matchesSearch(haystack) {
  if (!searchTerm) return true;
  return haystack.toLowerCase().includes(searchTerm.toLowerCase());
}

function thumb(entry, badge) {
  const img = entry?.image
    ? `<img class="browse-card-thumb" src="${escapeHtml(entry.image)}" alt="" />`
    : `<div class="browse-card-thumb browse-card-thumb-empty"></div>`;
  return `<div class="browse-card-media">${img}${badge || ''}</div>`;
}

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h10l1-13"/></svg>';
const ICON_SPINNER = '<svg class="mod-spinner" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="42 14"/></svg>';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCatalog() {
  try {
    const res = await fetch(`${HUB_BASE}/api/maps`);
    const rows = await res.json();
    catalog = rows.map((row) => ({
      id: row.id,
      name: row.name,
      author: row.author,
      description: row.description,
      image: row.gallery?.length ? `${HUB_BASE}/api/maps/${row.id}/gallery/${encodeURIComponent(row.gallery[0])}` : null,
    }));
    catalogError = false;
  } catch (err) {
    catalog = [];
    catalogError = true;
  }
}

async function loadMyUploadIds() {
  if (!isLoggedIn()) {
    myUploadIds = new Set();
    return;
  }
  try {
    const res = await fetch(`${HUB_BASE}/api/me/submissions`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const rows = res.ok ? await res.json() : [];
    myUploadIds = new Set(rows.filter((r) => r.kind === 'map').map((r) => r.id));
  } catch {
    myUploadIds = new Set();
  }
}

function renderInstalled() {
  const list = document.getElementById('maps-installed-view');
  const filtered = installedCache
    .filter((m) => matchesSearch(m.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    list.innerHTML = installedCache.length
      ? '<div class="empty-state">No maps match your search.</div>'
      : '<div class="empty-state">No maps installed yet. Browse the catalog to add one.</div>';
    return;
  }
  list.innerHTML = filtered
    .map((m) => {
      const entry = catalog.find((c) => c.id === m.id);
      return `
    <div class="browse-card">
      ${thumb(entry)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(m.name)}</div>
        <div class="browse-card-meta">${m.groupCount} course${m.groupCount === 1 ? '' : 's'}</div>
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="browse-card-icon-btn" title="Uninstall" onclick="event.stopPropagation(); window.__mapConfirmUninstall('${escapeHtml(m.id)}', '${escapeHtml(m.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
    })
    .join('');
}

function renderBrowse() {
  const list = document.getElementById('maps-browse-view');
  if (catalogError) {
    list.innerHTML = '<div class="empty-state">Couldn\'t reach the Recharge Hub library. Check your connection and reopen this tab.</div>';
    return;
  }
  const filtered = catalog
    .filter((m) => matchesSearch(m.name + ' ' + (m.description || '') + ' ' + (m.author || '')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No maps published yet.</div>';
    return;
  }
  list.innerHTML = filtered
    .map((entry) => {
      const installed = installedCache.some((m) => m.id === entry.id);
      const badge = installed
        ? `<div class="browse-card-badge browse-card-badge-installed" title="Installed">${ICON_CHECK}</div>`
        : `<button class="browse-card-badge browse-card-badge-install" title="Install" onclick="event.stopPropagation(); window.__mapInstall('${escapeHtml(entry.id)}', this)">${ICON_DOWNLOAD}</button>`;
      const mine = myUploadIds.has(entry.id);
      return `
    <div class="browse-card">
      ${thumb(entry, badge)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(entry.name)}</div>
        <div class="browse-card-meta">${escapeHtml(entry.author || '')}</div>
      </div>
      <div class="browse-card-desc">${escapeHtml(entry.description || '')}</div>
      ${mine ? `<div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="browse-card-icon-btn" title="Remove from the Recharge Library" onclick="window.__mapConfirmDeleteFromHub('${escapeHtml(entry.id)}', '${escapeHtml(entry.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>` : ''}
    </div>`;
    })
    .join('');
}

function render() {
  document.querySelectorAll('#view-maps .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === currentSubtab));
  document.getElementById('maps-installed-view').style.display = currentSubtab === 'installed' ? '' : 'none';
  document.getElementById('maps-browse-view').style.display = currentSubtab === 'browse' ? '' : 'none';
  document.getElementById('maps-upload-btn').style.display = isLoggedIn() ? '' : 'none';
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

window.__mapInstall = async function (id, btn) {
  const { invoke } = window.__TAURI__.core;
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('browse-card-badge-install');
    btn.classList.add('is-installing');
    btn.innerHTML = ICON_SPINNER;
  }
  try {
    await invoke('install_from_hub_cmd', { kind: 'maps', id });
    if (btn) {
      btn.classList.remove('is-installing');
      btn.classList.add('is-done');
      btn.innerHTML = ICON_CHECK;
      await sleep(450);
    }
    await refresh();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-installing', 'is-done');
      btn.classList.add('browse-card-badge-install');
      btn.innerHTML = ICON_DOWNLOAD;
    }
    alert(String(err));
  }
};

window.__mapConfirmUninstall = function (id, name) {
  if (!confirm(`Remove "${name}"? This can't be undone from here - you'd need to reinstall it.`)) return;
  const { invoke } = window.__TAURI__.core;
  invoke('uninstall_map', { id })
    .then(refresh)
    .catch((err) => alert(String(err)));
};

window.__mapOpenUpload = function () {
  if (!isLoggedIn()) {
    alert('Log in first to upload a map.');
    window.navigate('account');
    return;
  }
  chosenUploadPath = null;
  document.getElementById('maps-upload-path').textContent = 'No file chosen';
  document.getElementById('maps-upload-name').value = '';
  document.getElementById('maps-upload-description').value = '';
  document.getElementById('maps-upload-overlay').hidden = false;
};

window.__mapConfirmDeleteFromHub = function (id, name) {
  if (!confirm(`Remove "${name}" from the Recharge Library? This can't be undone.`)) return;
  const { invoke } = window.__TAURI__.core;
  invoke('delete_hub_submission_cmd', { token: getToken(), id })
    .then(async () => {
      await loadCatalog();
      await loadMyUploadIds();
      render();
    })
    .catch((err) => alert(String(err)));
};

async function browseForMapFile() {
  const { open } = window.__TAURI__.dialog;
  const chosen = await open({ directory: false, multiple: false, title: 'Choose a map file' });
  if (!chosen) return;
  chosenUploadPath = chosen;
  document.getElementById('maps-upload-path').textContent = chosen.split(/[\\/]/).pop();
}

function closeUploadModal() {
  document.getElementById('maps-upload-overlay').hidden = true;
}

async function submitUpload() {
  const name = document.getElementById('maps-upload-name').value.trim();
  const description = document.getElementById('maps-upload-description').value.trim();
  if (!chosenUploadPath) {
    alert('Choose a map file first.');
    return;
  }
  if (!name) {
    alert('Name is required.');
    return;
  }

  const confirmBtn = document.getElementById('maps-upload-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Uploading…';
  const { invoke } = window.__TAURI__.core;
  try {
    await invoke('submit_map_cmd', {
      token: getToken(),
      filePath: chosenUploadPath,
      displayName: name,
      author: getUsername(),
      description,
    });
    closeUploadModal();
    await loadCatalog();
    await loadMyUploadIds();
    render();
  } catch (err) {
    alert(String(err));
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Upload';
  }
}

async function refresh() {
  const { invoke } = window.__TAURI__.core;
  installedCache = await invoke('list_maps');
  render();
}

export async function init() {
  document.getElementById('maps-upload-cancel').addEventListener('click', closeUploadModal);
  document.getElementById('maps-upload-confirm').addEventListener('click', submitUpload);
  document.getElementById('maps-upload-browse-btn').addEventListener('click', browseForMapFile);
  render();
  await Promise.all([loadCatalog(), loadMyUploadIds(), refresh()]);
  render();
}
