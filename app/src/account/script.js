import { getToken, getUsername, isAdmin, clearSession, isLoggedIn } from '../auth.js';
import { escapeHtml, galleryImages, thumb, openModal, closeModal, confirmDestructive, ICON_TRASH, ICON_EDIT } from '../ui.js';

import { HUB_BASE } from '../hub.js';
import { mountProfileEditor } from './deco.js';
import { profiles } from '../social/api.js';
import { uploaderHtml } from '../social/avatar.js';
let editor = null;

let myUploads = [];
// Admins can switch the list to every user's uploads (GET /api/admin/submissions); Edit and Delete work the same on both.
let uploadScope = 'mine';
let editingId = null;

function galleryUrl(row) {
  const first = galleryImages(row.gallery)[0];
  if (!first) return null;
  const kindPath = { mod: 'mods', map: 'maps', skin: 'skins', playlist: 'playlists', background: 'backgrounds' }[row.kind] || 'skins';
  return `${HUB_BASE}/api/${kindPath}/${row.id}/gallery/${encodeURIComponent(first)}`;
}

function renderUploads() {
  const list = document.getElementById('account-uploads-list');
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

async function loadUploads() {
  if (!isAdmin()) uploadScope = 'mine';
  const sw = document.getElementById('account-uploads-switch');
  sw.style.display = isAdmin() ? '' : 'none';
  sw.querySelectorAll('.subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.scope === uploadScope));
  document.getElementById('account-uploads-header').textContent = uploadScope === 'all' ? 'All Uploads' : 'My Uploads';
  try {
    const res = await fetch(`${HUB_BASE}${isAdmin() && uploadScope === 'all' ? '/api/admin/submissions' : '/api/me/submissions'}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error('failed to load uploads');
    myUploads = await res.json();
  } catch (err) {
    myUploads = [];
  }
  renderUploads();
}

window.__acctEdit = function (id) {
  const row = myUploads.find((r) => r.id === id);
  if (!row) return;
  editingId = id;
  document.getElementById('account-edit-name').value = row.name;
  document.getElementById('account-edit-author').value = row.author;
  document.getElementById('account-edit-description').value = row.description || '';
  openModal('account-edit-overlay');
};

function closeEditModal() {
  closeModal('account-edit-overlay');
  editingId = null;
}

async function saveEdit() {
  if (!editingId) return;
  const name = document.getElementById('account-edit-name').value.trim();
  const author = document.getElementById('account-edit-author').value.trim();
  const description = document.getElementById('account-edit-description').value;
  if (!name || !author) {
    alert('Name and author are required.');
    return;
  }
  try {
    const res = await fetch(`${HUB_BASE}/api/submissions/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ name, author, description }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'edit failed');
    }
    closeEditModal();
    await loadUploads();
  } catch (err) {
    alert(String(err.message || err));
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
  fetch(`${HUB_BASE}/api/submissions/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getToken()}` },
  })
    .then(async (res) => {
      if (!res.ok) throw new Error('delete failed');
      await loadUploads();
    })
    .catch((err) => alert(String(err.message || err)));
};

async function refreshAll() {
  if (!isLoggedIn()) { window.goHome(); return; }
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
  await refreshAll();
}

export async function onShow() { await refreshAll(); }
