import { getToken, getUsername, isLoggedIn } from '../auth.js';

const HUB_BASE = 'https://codecade.co.za/recharge';

let currentSubtab = 'installed';
let searchTerm = '';
let installedCache = [];
let thumbCache = new Map(); // fileName -> data URL
let catalog = [];
let catalogError = false;
let chosenUploadPath = null;
let myUploadIds = new Set();
let detailImages = [];
let detailImageIndex = 0;
let openDetail = null; // { hubId } or { folderName }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function matchesSearch(haystack) {
  if (!searchTerm) return true;
  return haystack.toLowerCase().includes(searchTerm.toLowerCase());
}

// A hub-installed skin's folder is named after a slug of its real name, not
// the name itself (see HUB_META_FILE on the Rust side), so prefer the real
// name it recorded there; only prettify the raw folder name as a fallback
// for locally-added skins that never went through the hub.
function displayName(s) {
  if (typeof s === 'object' && s.displayName) return s.displayName;
  const folderName = typeof s === 'object' ? s.folderName : s;
  return folderName
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function suggestUploadName(folderName) {
  return displayName(folderName).replace(/\s+Skin\d*$/i, '');
}

function thumb(src, badge) {
  const img = src
    ? `<img class="browse-card-thumb" src="${escapeHtml(src)}" alt="" />`
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
    const res = await fetch(`${HUB_BASE}/api/skins`);
    const rows = await res.json();
    catalog = rows.map((row) => ({
      id: row.id,
      name: row.name,
      author: row.author,
      description: row.description || '',
      images: (row.gallery || []).map((f) => `${HUB_BASE}/api/skins/${row.id}/gallery/${encodeURIComponent(f)}`),
      image: row.gallery?.length ? `${HUB_BASE}/api/skins/${row.id}/gallery/${encodeURIComponent(row.gallery[0])}` : null,
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
    myUploadIds = new Set(rows.filter((r) => r.kind === 'skin').map((r) => r.id));
  } catch {
    myUploadIds = new Set();
  }
}

async function loadThumbnails() {
  const { invoke } = window.__TAURI__.core;
  await Promise.all(
    installedCache.map(async (s) => {
      if (thumbCache.has(s.folderName)) return;
      try {
        thumbCache.set(s.folderName, await invoke('read_skin_thumbnail', { folderName: s.folderName }));
      } catch {
        thumbCache.set(s.folderName, null);
      }
    })
  );
}

function renderInstalled() {
  const list = document.getElementById('skins-installed-view');
  const filtered = installedCache
    .filter((s) => matchesSearch(displayName(s)))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    list.innerHTML = installedCache.length
      ? '<div class="empty-state">No skins match your search.</div>'
      : '<div class="empty-state">No skins installed. Browse the library to add one.</div>';
    return;
  }
  list.innerHTML = filtered
    .map(
      (s) => `
    <div class="browse-card" onclick="window.__skinOpenDetail('${escapeHtml(s.hubId ? 'hub:' + s.hubId : 'local:' + s.folderName)}')">
      ${thumb(thumbCache.get(s.folderName))}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(displayName(s))}</div>
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="browse-card-icon-btn" title="Delete" onclick="event.stopPropagation(); window.__skinConfirmDelete('${escapeHtml(s.folderName)}')">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`
    )
    .join('');
}

function renderBrowse() {
  const list = document.getElementById('skins-browse-view');
  if (catalogError) {
    list.innerHTML = '<div class="empty-state">Couldn\'t reach the Recharge Hub library. Check your connection and reopen this tab.</div>';
    return;
  }
  const filtered = catalog
    .filter((s) => matchesSearch(s.name + ' ' + (s.author || '') + ' ' + (s.description || '')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No skins published yet.</div>';
    return;
  }
  list.innerHTML = filtered
    .map((entry) => {
      const installed = installedCache.some((s) => s.hubId === entry.id);
      const badge = installed
        ? `<div class="browse-card-badge browse-card-badge-installed" title="Installed">${ICON_CHECK}</div>`
        : `<button class="browse-card-badge browse-card-badge-install" title="Install" onclick="event.stopPropagation(); window.__skinInstall('${escapeHtml(entry.id)}', this)">${ICON_DOWNLOAD}</button>`;
      const mine = myUploadIds.has(entry.id);
      return `
    <div class="browse-card" onclick="window.__skinOpenDetail('hub:${escapeHtml(entry.id)}')">
      ${thumb(entry.image, badge)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(entry.name)}</div>
        <div class="browse-card-meta">${escapeHtml(entry.author || '')}</div>
        ${entry.description ? `<div class="browse-card-desc" style="padding:0;">${escapeHtml(entry.description)}</div>` : ''}
      </div>
      ${mine ? `<div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="browse-card-icon-btn" title="Remove from the Recharge Library" onclick="event.stopPropagation(); window.__skinConfirmDeleteFromHub('${escapeHtml(entry.id)}', '${escapeHtml(entry.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>` : ''}
    </div>`;
    })
    .join('');
}

function render() {
  document.querySelectorAll('#view-skins .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === currentSubtab));
  document.getElementById('skins-installed-view').style.display = currentSubtab === 'installed' ? '' : 'none';
  document.getElementById('skins-browse-view').style.display = currentSubtab === 'browse' ? '' : 'none';
  document.getElementById('skins-upload-btn').style.display = isLoggedIn() ? '' : 'none';
  renderInstalled();
  renderBrowse();
  // Keep an open detail page in step with installs/deletes, or leave it if its skin is gone.
  if (openDetail && !window.__skinOpenDetail(openDetail)) window.__skinCloseDetail();
}

window.__skinGalleryStep = function (delta) {
  if (detailImages.length < 2) return;
  detailImageIndex = (detailImageIndex + delta + detailImages.length) % detailImages.length;
  document.getElementById('skins-gallery-img').src = detailImages[detailImageIndex];
  document.getElementById('skins-gallery-count').textContent = `${detailImageIndex + 1} / ${detailImages.length}`;
};

// key is "hub:<hub id>" for a library skin (installed or not) or
// "local:<folder>" for one that never went through the hub.
window.__skinOpenDetail = function (key) {
  const [kind, ...rest] = key.split(':');
  const ref = rest.join(':');
  const entry = kind === 'hub' ? catalog.find((c) => c.id === ref) : null;
  const installedSkin = kind === 'hub' ? installedCache.find((s) => s.hubId === ref) : installedCache.find((s) => s.folderName === ref);
  if (!entry && !installedSkin) return false;
  openDetail = key;

  const name = entry ? entry.name : displayName(installedSkin);
  const author = entry?.author || '';
  const description = entry?.description || '';
  const localThumb = installedSkin ? thumbCache.get(installedSkin.folderName) : null;
  detailImages = entry?.images?.length ? entry.images : entry?.image ? [entry.image] : localThumb ? [localThumb] : [];
  detailImageIndex = 0;
  const mine = entry && myUploadIds.has(entry.id);

  document.getElementById('skins-detail').innerHTML = `
    <button class="crumb-back" onclick="window.__skinCloseDetail()" style="margin-bottom:20px;">&lt; Skins</button>
    ${detailImages.length ? `<div class="mod-gallery">
      <img class="mod-detail-image" id="skins-gallery-img" src="${escapeHtml(detailImages[0])}" alt=""${detailImages.length > 1 ? ' onclick="window.__skinGalleryStep(1)" style="cursor:pointer;"' : ''} />
      ${detailImages.length > 1 ? `<button class="mod-gallery-nav mod-gallery-prev" title="Previous image" onclick="window.__skinGalleryStep(-1)">&lsaquo;</button>
      <button class="mod-gallery-nav mod-gallery-next" title="Next image" onclick="window.__skinGalleryStep(1)">&rsaquo;</button>
      <div class="mod-gallery-count" id="skins-gallery-count">1 / ${detailImages.length}</div>` : ''}
    </div>` : ''}
    <div class="mod-detail-header">
      <div class="mod-detail-name">${escapeHtml(name)}</div>
      ${author ? `<div class="mod-detail-meta">${escapeHtml(author)}</div>` : ''}
    </div>
    ${description ? `<div class="mod-detail-desc">${escapeHtml(description)}</div>` : ''}
    <div class="mod-detail-actions">
      ${installedSkin
        ? `<span class="browse-card-meta">Installed</span>
           <button class="btn mod-detail-uninstall" onclick="window.__skinConfirmDelete('${escapeHtml(installedSkin.folderName)}')">Delete</button>`
        : entry ? `<button class="btn btn-primary" onclick="window.__skinInstall('${escapeHtml(entry.id)}', this)">Install</button>` : ''}
      ${mine ? `<button class="btn mod-detail-uninstall" onclick="window.__skinConfirmDeleteFromHub('${escapeHtml(entry.id)}', '${escapeHtml(entry.name).replace(/'/g, "\\'")}')">Remove from Library</button>` : ''}
    </div>
  `;
  document.getElementById('skins-list').style.display = 'none';
  document.getElementById('skins-detail').style.display = 'block';
  return true;
};

window.__skinCloseDetail = function () {
  document.getElementById('skins-detail').style.display = 'none';
  document.getElementById('skins-list').style.display = 'block';
  openDetail = null;
};

window.__skinsSubtab = function (tab) {
  currentSubtab = tab;
  render();
};

window.__skinsSearch = function (value) {
  searchTerm = value;
  render();
};

window.__skinConfirmDelete = function (folderName) {
  const entry = installedCache.find((s) => s.folderName === folderName);
  if (!confirm(`Delete "${displayName(entry || folderName)}"? This can't be undone.`)) return;
  const { invoke } = window.__TAURI__.core;
  invoke('delete_skin', { folderName })
    .then(refresh)
    .catch((err) => alert(String(err)));
};

window.__skinInstall = async function (id, btn) {
  const { invoke } = window.__TAURI__.core;
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('browse-card-badge-install');
    btn.classList.add('is-installing');
    btn.innerHTML = ICON_SPINNER;
  }
  try {
    await invoke('install_from_hub_cmd', { kind: 'skins', id });
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

window.__skinExportTemplate = async function () {
  const { open } = window.__TAURI__.dialog;
  const { invoke } = window.__TAURI__.core;
  const dir = await open({ directory: true, multiple: false, title: 'Export Skin Template to…' });
  if (!dir) return;
  try {
    await invoke('download_skin_template_cmd', { destDir: dir });
    alert('Exported to ' + dir + '/SkinTemplate');
  } catch (err) {
    alert(String(err));
  }
};

window.__skinOpenUpload = function () {
  if (!isLoggedIn()) {
    alert('Log in first to upload a skin.');
    window.navigate('account');
    return;
  }
  chosenUploadPath = null;
  document.getElementById('skins-upload-path').textContent = 'No folder chosen';
  document.getElementById('skins-upload-name').value = '';
  document.getElementById('skins-upload-description').value = '';
  document.getElementById('skins-upload-overlay').hidden = false;
};

window.__skinConfirmDeleteFromHub = function (id, name) {
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

async function browseForSkinFolder() {
  const { open } = window.__TAURI__.dialog;
  const chosen = await open({ directory: true, multiple: false, title: 'Choose a skin folder' });
  if (!chosen) return;
  chosenUploadPath = chosen;
  const folderName = chosen.split(/[\\/]/).pop();
  document.getElementById('skins-upload-path').textContent = folderName;
  if (!document.getElementById('skins-upload-name').value) {
    document.getElementById('skins-upload-name').value = suggestUploadName(folderName);
  }
}

function closeUploadModal() {
  document.getElementById('skins-upload-overlay').hidden = true;
}

async function submitUpload() {
  const name = document.getElementById('skins-upload-name').value.trim();
  if (!chosenUploadPath) {
    alert('Choose a skin folder first.');
    return;
  }
  if (!name) {
    alert('Name is required.');
    return;
  }

  const confirmBtn = document.getElementById('skins-upload-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Uploading…';
  const { invoke } = window.__TAURI__.core;
  try {
    await invoke('submit_skin_cmd', { token: getToken(), folderPath: chosenUploadPath, displayName: name, author: getUsername(), description: document.getElementById('skins-upload-description').value.trim() });
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
  installedCache = await invoke('list_installed_skins');
  await loadThumbnails();
  render();
}

export async function init() {
  document.getElementById('skins-upload-cancel').addEventListener('click', closeUploadModal);
  document.getElementById('skins-upload-confirm').addEventListener('click', submitUpload);
  document.getElementById('skins-upload-browse-btn').addEventListener('click', browseForSkinFolder);
  render();
  await onShow();
}

export async function onShow() {
  await Promise.all([loadCatalog(), loadMyUploadIds(), refresh()]);
  render();
}
