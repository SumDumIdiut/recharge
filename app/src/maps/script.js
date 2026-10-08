import { getToken, getUsername, isLoggedIn } from '../auth.js';
import { requireLogin } from '../login-prompt.js';
import { escapeHtml, sleep, thumb, openModal, closeModal, setBadgeState, confirmDestructive, ICON_CHECK, ICON_DOWNLOAD, ICON_TRASH } from '../ui.js';

const HUB_BASE = 'https://codecade.co.za/recharge';

let currentSubtab = 'installed';
let searchTerm = '';
let installedCache = [];
// Installed maps' pictures (the whole map, zoomed out): id -> data URL.
const thumbs = new Map();
let drawing = null;
let catalog = [];
let catalogError = false;
let myUploadIds = new Set();
let chosenGalleryPaths = [];
const MAX_GALLERY_IMAGES = 8;

function matchesSearch(haystack) {
  if (!searchTerm) return true;
  return haystack.toLowerCase().includes(searchTerm.toLowerCase());
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

// A map from the Hub goes by its Hub name (two uploads of one map can share the name in their files).
const shownName = (m) => catalog.find((c) => c.id === m.id || c.id === m.hub)?.name || m.name;

function renderInstalled() {
  const list = document.getElementById('maps-installed-view');
  const filtered = installedCache
    .filter((m) => matchesSearch(shownName(m)))
    .sort((a, b) => shownName(a).localeCompare(shownName(b), undefined, { sensitivity: 'base' }));
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
      ${thumb(thumbs.get(m.id) || entry?.image)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(shownName(m))}</div>
        <div class="browse-card-meta">${m.groupCount} course${m.groupCount === 1 ? '' : 's'}</div>
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="icon-btn" title="Uninstall" onclick="event.stopPropagation(); window.__mapConfirmUninstall('${escapeHtml(m.id)}', '${escapeHtml(shownName(m)).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
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
      const installed = installedCache.some((m) => m.id === entry.id || m.hub === entry.id);
      const badge = installed
        ? `<div class="badge badge-installed" title="Installed">${ICON_CHECK}</div>`
        : `<button class="badge badge-install" title="Install" onclick="event.stopPropagation(); window.__mapInstall('${escapeHtml(entry.id)}', this)">${ICON_DOWNLOAD}</button>`;
      const mine = myUploadIds.has(entry.id);
      return `
    <div class="browse-card">
      ${thumb(thumbs.get(entry.id) || entry.image, badge)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(entry.name)}</div>
        <div class="browse-card-meta">${escapeHtml(entry.author || '')}</div>
      </div>
      <div class="browse-card-desc">${escapeHtml(entry.description || '')}</div>
      ${mine ? `<div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="icon-btn" title="Remove from the Recharge Library" onclick="window.__mapConfirmDeleteFromHub('${escapeHtml(entry.id)}', '${escapeHtml(entry.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
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
  document.getElementById('maps-upload-btn').style.display = ''; // always shown: logged-out clicks explain how to log in
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
    setBadgeState(btn, 'installing');
  }
  try {
    await invoke('install_from_hub_cmd', { kind: 'maps', id });
    if (btn) {
      setBadgeState(btn, 'done');
      await sleep(450);
    }
    await refresh();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      setBadgeState(btn, 'failed');
    }
    alert(String(err));
  }
};

window.__mapConfirmUninstall = async function (id, name) {
  const ok = await confirmDestructive({
    title: 'Delete map',
    body: `"${name}" will be deleted from your installed maps. This can't be undone from here - you'd need to reinstall it.`,
    confirmLabel: 'Delete',
    name,
  });
  if (!ok) return;
  const { invoke } = window.__TAURI__.core;
  invoke('uninstall_map', { id })
    .then(refresh)
    .catch((err) => alert(String(err)));
};

window.__mapOpenUpload = function () {
  if (!requireLogin('a map')) return;
  // Your installed maps that aren't on the Hub yet.
  const pick = document.getElementById('maps-upload-map'), maps = uploadable();
  pick.innerHTML = maps.length
    ? maps.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('')
    : '<option value="">Every installed map is on the Hub already</option>';
  pick.disabled = !maps.length;
  fillUploadFields();
  chosenGalleryPaths = [];
  renderGalleryChoice();
  openModal('maps-upload-overlay');
};

function renderGalleryChoice() {
  const el = document.getElementById('maps-upload-gallery-path');
  if (!chosenGalleryPaths.length) {
    el.textContent = `None chosen (optional, up to ${MAX_GALLERY_IMAGES})`;
    return;
  }
  const first = chosenGalleryPaths[0].split(/[\\/]/).pop();
  el.textContent = chosenGalleryPaths.length === 1 ? first : `${chosenGalleryPaths.length} images (${first}, …)`;
}

async function browseForScreenshots() {
  const { open } = window.__TAURI__.dialog;
  const chosen = await open({
    multiple: true,
    directory: false,
    title: `Choose up to ${MAX_GALLERY_IMAGES} screenshots`,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (!chosen) return;
  const paths = Array.isArray(chosen) ? chosen : [chosen];
  if (paths.length > MAX_GALLERY_IMAGES) {
    alert(`Only the first ${MAX_GALLERY_IMAGES} images will be used.`);
  }
  chosenGalleryPaths = paths.slice(0, MAX_GALLERY_IMAGES);
  renderGalleryChoice();
}

window.__mapConfirmDeleteFromHub = async function (id, name) {
  const ok = await confirmDestructive({
    title: 'Delete upload',
    body: `"${name}" will be removed from the Recharge Library. Installs already on disk stay, but this cannot be undone.`,
    confirmLabel: 'Delete',
    name,
  });
  if (!ok) return;
  const { invoke } = window.__TAURI__.core;
  invoke('delete_hub_submission_cmd', { token: getToken(), id })
    .then(async () => {
      await loadCatalog();
      await loadMyUploadIds();
      render();
    })
    .catch((err) => alert(String(err)));
};

const onHub = (m) => catalog.some((c) => c.id === m.id || c.id === m.hub);
const uploadable = () => installedCache.filter((m) => !onHub(m)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
// The picked map's own name and description, to start from.
function fillUploadFields() {
  const m = installedCache.find((x) => x.id === document.getElementById('maps-upload-map').value);
  document.getElementById('maps-upload-name').value = m?.name || '';
  document.getElementById('maps-upload-description').value = m?.description || '';
}

function closeUploadModal() {
  closeModal('maps-upload-overlay');
}

async function submitUpload() {
  const name = document.getElementById('maps-upload-name').value.trim();
  const description = document.getElementById('maps-upload-description').value.trim();
  const id = document.getElementById('maps-upload-map').value;
  if (!id) {
    alert('Pick a map first.');
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
    await invoke('submit_installed_map_cmd', {
      token: getToken(),
      id,
      displayName: name,
      author: getUsername(),
      description,
      galleryPaths: chosenGalleryPaths,
    });
    closeUploadModal();
    await loadCatalog();
    await loadMyUploadIds();
    await refresh();
  } catch (err) {
    alert(String(err));
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Upload';
  }
}

async function refresh() {
  const { invoke } = window.__TAURI__.core;
  // The editor's "Test in game" slot isn't a map of its own.
  installedCache = (await invoke('list_maps')).filter((m) => m.id !== 'map-maker-test');
  render();
  syncHubNames();
  loadThumbs();
}

// Each map's picture: the saved one while it's newer than the map, else one drawn here (one map
// at a time, in the background) and kept beside the map.
async function loadThumbs() {
  const { invoke } = window.__TAURI__.core, missing = [];
  for (const m of installedCache) {
    const b64 = await invoke('read_map_thumb', { id: m.id }).catch(() => null);
    if (b64) thumbs.set(m.id, 'data:image/png;base64,' + b64); else missing.push(m.id);
  }
  render();
  if (!missing.length || drawing) return;
  drawing = (async () => {
    const { mapThumbFor } = await import('./mapthumb.js');
    for (const id of missing) {
      try {
        const img = await mapThumbFor(id);
        if (!img) continue;
        thumbs.set(id, img);
        render();
        await invoke('write_map_thumb', { id, data: img });
      } catch (e) { console.warn('map picture', id, e); }
      await sleep(50);
    }
  })().finally(() => { drawing = null; });
}

// Browse cards get the same extracted fullmap picture as installed maps when we can make one.
async function loadBrowseThumbs() {
  const { mapThumbFor } = await import('./mapthumb.js');
  for (const entry of catalog) {
    if (thumbs.has(entry.id)) continue;
    const img = await mapThumbFor(entry.id).catch(() => null);
    if (img) { thumbs.set(entry.id, img); render(); }
  }
}

// Each installed Hub map's Hub name beside it, for the game's map list to show.
function syncHubNames() {
  const { invoke } = window.__TAURI__.core;
  for (const m of installedCache) {
    const entry = catalog.find((c) => c.id === m.id);
    if (entry?.name) invoke('set_map_hub_name', { id: m.id, name: entry.name }).catch(() => {});
  }
}

export async function init() {
  document.getElementById('maps-upload-cancel').addEventListener('click', closeUploadModal);
  document.getElementById('maps-upload-confirm').addEventListener('click', submitUpload);
  document.getElementById('maps-upload-map').addEventListener('change', fillUploadFields);
  document.getElementById('maps-upload-gallery-btn').addEventListener('click', browseForScreenshots);
  render();
  await onShow();
}

export async function onShow() {
  await Promise.all([loadCatalog(), loadMyUploadIds(), refresh()]);
  render();
  syncHubNames();
  loadBrowseThumbs();
}
