import { getToken, getUsername, isAdmin, clearSession, isLoggedIn } from '../auth.js';

const HUB_BASE = 'https://codecade.co.za/recharge';

let myUploads = [];
let editingId = null;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h10l1-13"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function galleryUrl(row) {
  if (!row.gallery?.length) return null;
  const kindPath = row.kind === 'mod' ? 'mods' : row.kind === 'map' ? 'maps' : 'skins';
  return `${HUB_BASE}/api/${kindPath}/${row.id}/gallery/${encodeURIComponent(row.gallery[0])}`;
}

function renderUploads() {
  const list = document.getElementById('account-uploads-list');
  if (!myUploads.length) {
    list.innerHTML = '<div class="empty-state">You haven\'t uploaded anything yet.</div>';
    return;
  }
  list.innerHTML = myUploads
    .map((row) => {
      const img = galleryUrl(row);
      const thumb = img
        ? `<img class="browse-card-thumb" src="${escapeHtml(img)}" alt="" />`
        : `<div class="browse-card-thumb browse-card-thumb-empty"></div>`;
      return `
    <div class="browse-card">
      <div class="browse-card-media">${thumb}</div>
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(row.name)}</div>
        <div class="browse-card-meta">${escapeHtml(row.kind)} &middot; ${escapeHtml(row.author)}</div>
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="browse-card-icon-btn" title="Edit" onclick="window.__acctEdit('${escapeHtml(row.id)}')">${ICON_EDIT}</button>
          <button class="browse-card-icon-btn" title="Delete" onclick="window.__acctDelete('${escapeHtml(row.id)}', '${escapeHtml(row.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
    })
    .join('');
}

async function loadUploads() {
  try {
    const res = await fetch(`${HUB_BASE}/api/me/submissions`, {
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
  document.getElementById('account-edit-overlay').hidden = false;
};

function closeEditModal() {
  document.getElementById('account-edit-overlay').hidden = true;
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

window.__acctDelete = function (id, name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
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

export async function init() {
  if (!isLoggedIn()) {
    window.goHome();
    return;
  }
  document.getElementById('account-username-display').textContent = `Logged in as ${getUsername()}${isAdmin() ? ' (admin)' : ''}`;
  document.getElementById('account-logout-btn').addEventListener('click', () => {
    clearSession();
    window.goHome();
  });
  document.getElementById('account-edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('account-edit-save').addEventListener('click', saveEdit);
  await loadUploads();
}
