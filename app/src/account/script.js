import { getToken, getUsername, isAdmin, clearSession, isLoggedIn } from '../auth.js';
import { escapeHtml, thumb, openModal, closeModal, ICON_TRASH, ICON_EDIT } from '../ui.js';

const HUB_BASE = 'https://codecade.co.za/recharge';

let myUploads = [];
let editingId = null;

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
      return `
    <div class="browse-card">
      ${thumb(img)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(row.name)}</div>
        <div class="browse-card-meta">${escapeHtml(row.kind)} &middot; ${escapeHtml(row.author)}</div>
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
