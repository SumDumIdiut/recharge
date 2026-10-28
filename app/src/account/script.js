import { getToken, getUsername, isAdmin, clearSession, isLoggedIn } from '../auth.js';
import { escapeHtml, galleryImages, thumb, openModal, closeModal, confirmDestructive, ICON_TRASH, ICON_EDIT } from '../ui.js';

import { HUB_BASE } from '../hub.js';
import { mountProfileEditor } from './deco.js';
import { profiles, submissions } from '../social/api.js';
import { uploaderHtml } from '../social/avatar.js';
import { isTestMap } from '../maps/test-map.js';
import { initEventsCard, renderEventsCard } from './events-card.js';
let editor = null;

let myUploads = [];
// Set when the list could not be loaded: an error is not an empty list, and the person has to be able to tell them apart.
let loadError = null;
// Admins can switch the list to every user's uploads (GET /api/admin/submissions); Edit and Delete work the same on both.
let uploadScope = 'mine';
let editingId = null;

// Errors are shown in the page, not in an alert: they belong next to what failed.
function showInlineError(id, err) {
  const box = document.getElementById(id);
  const msg = String(err?.message || err || 'Something went wrong.');
  if (box) {
    box.textContent = msg;
    box.hidden = false;
  } else {
    console.warn('[account]', msg);
  }
  return msg;
}

function galleryUrl(row) {
  const first = galleryImages(row.gallery)[0];
  if (!first) return null;
  const kindPath = { mod: 'mods', map: 'maps', skin: 'skins', playlist: 'playlists', background: 'backgrounds' }[row.kind] || 'skins';
  return `${HUB_BASE}/api/${kindPath}/${row.id}/gallery/${encodeURIComponent(first)}`;
}

function renderUploads() {
  const list = document.getElementById('account-uploads-list');
  if (loadError) {
    // A failed load is not an empty account: say what went wrong and offer to try again.
    list.innerHTML = `<div class="empty-state">Couldn't load your uploads: ${escapeHtml(loadError)}<br /><button class="btn" onclick="window.__acctRetryUploads()">Retry</button></div>`;
    return;
  }
  if (!myUploads.length) {
    list.innerHTML = `<div class="empty-state">${uploadScope === 'all' ? 'Nothing has been uploaded yet.' : 'You haven\'t uploaded anything yet.'}</div>`;
    return;
  }
  list.innerHTML = myUploads
    .map((row) => {
      const img = galleryUrl(row);
      return `
    <div class="browse-card">
      ${thumb(img)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(row.name)}</div>
        <div class="browse-card-meta">${escapeHtml(row.kind)} &middot; ${uploaderHtml(row)}</div>
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="icon-btn" title="Edit" onclick="window.__acctEdit('${escapeHtml(row.id)}')">${ICON_EDIT}</button>
          <button class="icon-btn" title="Delete" onclick="window.__acctDelete('${escapeHtml(row.id)}', '${escapeHtml(row.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
    })
    .join('');
}

window.__acctScope = function (scope) {
  uploadScope = scope === 'all' ? 'all' : 'mine';
  loadUploads();
};

// The Retry row in the list: the same load, once more.
window.__acctRetryUploads = function () {
  loadUploads();
};

async function loadUploads() {
  if (!isAdmin()) uploadScope = 'mine';
  const sw = document.getElementById('account-uploads-switch');
  sw.style.display = isAdmin() ? '' : 'none';
  sw.querySelectorAll('.subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.scope === uploadScope));
  document.getElementById('account-uploads-header').textContent = uploadScope === 'all' ? 'All Uploads' : 'My Uploads';
  const errBox = document.getElementById('account-uploads-error');
  if (errBox) errBox.hidden = true;
  try {
    const rows = isAdmin() && uploadScope === 'all' ? await submissions.admin() : await submissions.mine();
    myUploads = Array.isArray(rows) ? rows : [];
    loadError = null;
  } catch (err) {
    myUploads = [];
    loadError = String(err?.message || err);
  }
  renderUploads();
}

window.__acctEdit = async function (id) {
  const row = myUploads.find((r) => r.id === id);
  if (!row) return;
  editingId = id;
  document.getElementById('account-edit-name').value = row.name;
  document.getElementById('account-edit-author').value = row.author;
  document.getElementById('account-edit-description').value = row.description || '';
  await fillEditUploadChoice(row);
  openModal('account-edit-overlay');
};

// The "Upload a new version from" list: the maps installed here that can be uploaded as a new
// version of this entry. An upload is made from the map's folder on disk, so a map that isn't
// installed cannot be uploaded - which is why the list is of installed maps, not of uploads.
async function fillEditUploadChoice(row) {
  const wrap = document.getElementById('account-edit-upload-row');
  const select = document.getElementById('account-edit-upload');
  const hint = document.getElementById('account-edit-upload-hint');
  if (!wrap || !select) return;
  const isMap = row.kind === 'map';
  wrap.hidden = !isMap;
  hint.hidden = true;
  if (!isMap) {
    select.innerHTML = '';
    return;
  }
  const { invoke } = window.__TAURI__.core;
  const installed = await invoke('list_maps').catch(() => []);
  // The editor's test-launch slot is not a map you would publish.
  const usable = installed.filter((m) => !isTestMap(m));
  // Prefer the copy that came from this very upload, so Save usually needs no thought.
  const same = usable.find((m) => m.hub === row.id || m.id === row.id);
  const opts = usable.map((m) => `<option value="${escapeHtml(m.id)}"${m === same ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('');
  select.innerHTML = `<option value="">Just save the changes above</option>${opts}`;
  if (!usable.length) {
    hint.textContent = `No maps are installed here, so "${row.name}" can't be given a new version. Install it from Maps > Browse first.`;
    hint.hidden = false;
  } else if (!same) {
    hint.textContent = 'None of the installed maps came from this upload, so pick the one that is the new version.';
    hint.hidden = false;
  }
}

function closeEditModal() {
  closeModal('account-edit-overlay');
  editingId = null;
}

async function saveEdit() {
  if (!editingId) return;
  const name = document.getElementById('account-edit-name').value.trim();
  const author = document.getElementById('account-edit-author').value.trim();
  const description = document.getElementById('account-edit-description').value;
  const uploadFrom = document.getElementById('account-edit-upload')?.value || '';
  if (!name || !author) {
    alert('Name and author are required.');
    return;
  }
  const saveBtn = document.getElementById('account-edit-save');
  const wasLabel = saveBtn?.textContent;
  const errBox = document.getElementById('account-edit-error');
  if (errBox) errBox.hidden = true;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = uploadFrom ? 'Uploading…' : 'Saving…'; }
  try {
    // A new version replaces the entry's files and bumps its revision, keeping its comments.
    // It carries the text in the fields above, so one Save does both.
    if (uploadFrom) {
      const { invoke } = window.__TAURI__.core;
      // The picture goes up with the new files. The hub deliberately keeps a map's old
      // picture when an update arrives without one, so sending nothing would freeze the
      // thumbnail at the version before this edit - the opposite of what it should show.
      let gallery = [];
      try {
        const { mapViewFile } = await import('../maps/mapthumb.js');
        gallery = [await mapViewFile(uploadFrom)].filter(Boolean);
      } catch { /* no drawn view; the hub keeps the old picture rather than losing it */ }
      await invoke('submit_installed_map_cmd', {
        token: getToken(),
        id: uploadFrom,
        displayName: name,
        author,
        description,
        galleryPaths: gallery,
        updates: editingId,
      });
    } else {
      await submissions.patch(editingId, { name, author, description });
    }
    closeEditModal();
    await loadUploads();
  } catch (err) {
    showInlineError('account-edit-error', err);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = wasLabel; }
  }
}

window.__acctDelete = async function (id, name) {
  const ok = await confirmDestructive({
    title: 'Delete upload',
    body: `"${name}" will be removed from the Recharge Library. Installs already on disk stay, but this cannot be undone.`,
    confirmLabel: 'Delete',
    name,
  });
  if (!ok) return;
  try {
    await submissions.remove(id);
    await loadUploads();
  } catch (err) {
    showInlineError('account-uploads-error', err);
  }
};

async function refreshAll() {
  if (!isLoggedIn()) { window.goHome(); return; }
  renderEventsCard();
  editor?.destroy();
  editor = null;
  const host = document.getElementById('account-profile');
  host.innerHTML = '<div class="empty-state">Loading...</div>';
  profiles.me().then((me) => { editor = mountProfileEditor(host, me); })
    .catch((e) => { host.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`; });
  await loadUploads();
}

export async function init() {
  if (!isLoggedIn()) {
    window.goHome();
    return;
  }
  document.getElementById('account-edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('account-edit-save').addEventListener('click', saveEdit);
  initEventsCard();
  await refreshAll();
}

export async function onShow() { await refreshAll(); }
