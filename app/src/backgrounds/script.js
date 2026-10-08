import { escapeHtml, ICON_TRASH } from '../ui.js';
import { getToken, getUsername, isLoggedIn } from '../auth.js';
import { openAccount } from '../login-prompt.js';
import { recheckBackground } from '../theme.js';

import { loadCommunity, imageCardsHtml, playlistCardsHtml, playlistGalleryUrl as galleryUrl, UNSUPPORTED_PLAYLISTS as UNSUPPORTED } from './community.js';

const INTERVALS = [
  [0, 'Every launch'],
  [60, '1 min'],
  [300, '5 min'],
  [900, '15 min'],
  [1800, '30 min'],
  [3600, '1 hour'],
  [86400, '1 day'],
];

let images = []; // filenames, newest first
let selected = new Set();
let editingId = null;
let currentSubtab = 'browse';
let communitySection = 'images';
let imagePublic = {}; // file -> hub id while public

function showError(msg, withAccountLink = false) {
  const el = document.getElementById('bg-error');
  el.textContent = String(msg).includes('UNSUPPORTED') ? UNSUPPORTED : msg;
  if (withAccountLink) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.marginLeft = '10px';
    btn.textContent = 'Open Account';
    btn.onclick = () => openAccount();
    el.appendChild(btn);
  }
  el.hidden = false;
}

function clearError() {
  document.getElementById('bg-error').hidden = true;
}

async function refreshImages() {
  const { invoke } = window.__TAURI__.core;
  images = await invoke('list_background_images').catch(() => []);
  const config = await invoke('get_backgrounds_config').catch(() => ({}));
  imagePublic = config.image_public || {};
}

function updateSelectionBar() {
  const bar = document.getElementById('bg-selection-bar');
  bar.hidden = selected.size === 0;
  document.getElementById('bg-selection-count').textContent = `${selected.size} selected`;
}

function resetSelection() {
  editingId = null;
  selected = new Set();
  document.getElementById('bg-selection-name').value = '';
}

function renderBrowse() {
  const { invoke } = window.__TAURI__.core;
  const grid = document.getElementById('bg-browse-grid');
  if (!images.length) {
    grid.innerHTML = '<div class="empty-state">No background images yet - click Upload to add some.</div>';
    updateSelectionBar();
    return;
  }
  grid.innerHTML = images
    .map(
      (file) => `
    <div class="browse-card${selected.has(file) ? ' bg-card-selected' : ''}" data-file="${escapeHtml(file)}">
      <div class="browse-card-media"><div class="browse-card-thumb" data-thumb="${escapeHtml(file)}"></div></div>
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(file)}</div>
      </div>
      <div class="browse-card-actions">
        <span class="browse-card-meta" data-status>${selected.has(file) ? 'Selected' : ''}</span>
        <div class="browse-card-actions-right">
          <label class="bg-switch" title="Share this image with the community">
            <input type="checkbox" data-act="public"${imagePublic[file] ? ' checked' : ''} />
            <span class="bg-switch-track"></span>
            <span class="bg-switch-label">${imagePublic[file] ? 'Public' : 'Private'}</span>
          </label>
          <button class="icon-btn" title="Delete" data-act="delete">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`
    )
    .join('');

  grid.querySelectorAll('.browse-card').forEach((card) => {
    const file = card.dataset.file;
    card.onclick = () => {
      if (selected.has(file)) selected.delete(file);
      else selected.add(file);
      renderBrowse();
    };
    const sw = card.querySelector('.bg-switch');
    sw.onclick = (e) => e.stopPropagation();
    card.querySelector('[data-act=public]').onchange = (e) => setImagePublic(card, file, e.target.checked);
    card.querySelector('[data-act=delete]').onclick = async (e) => {
      e.stopPropagation();
      clearError();
      if (imagePublic[file]) {
        if (!isLoggedIn()) {
          showError('Log in to remove the public copy of this image first.', true);
          return;
        }
        setCardBusy(card, 'Removing from the hub...');
        try {
          await invoke('unpublish_background_image', { token: getToken(), fileName: file });
        } catch (err) {
          setCardBusy(card, '');
          showError(String(err));
          return;
        }
      }
      await invoke('delete_background_image', { fileName: file });
      selected.delete(file);
      await refreshImages();
      renderBrowse();
    };
  });
  grid.querySelectorAll('[data-thumb]').forEach((el) => {
    invoke('read_background_image', { fileName: el.dataset.thumb })
      .then((url) => { el.style.backgroundImage = `url("${url}")`; })
      .catch(() => {});
  });
  updateSelectionBar();
}

function setCardBusy(card, text) {
  const el = card.querySelector('[data-status]');
  if (el) el.textContent = text;
  card.querySelectorAll('input, button').forEach((c) => { c.disabled = !!text; });
}

// Private <-> Public switch of an image card.
async function setImagePublic(card, file, on) {
  const { invoke } = window.__TAURI__.core;
  clearError();
  if (!isLoggedIn()) {
    card.querySelector('[data-act=public]').checked = !on;
    showError('Log in to make an image public.', true);
    return;
  }
  setCardBusy(card, on ? 'Uploading...' : 'Removing from the hub...');
  try {
    if (on) await invoke('publish_background_image', { token: getToken(), fileName: file, author: getUsername() || '' });
    else await invoke('unpublish_background_image', { token: getToken(), fileName: file });
  } catch (err) {
    showError(String(err));
  }
  await refreshImages();
  renderBrowse();
}

function setRowStatus(row, text) {
  const el = row.querySelector('[data-status]');
  if (el) el.textContent = text;
  row.querySelectorAll('input, select, button').forEach((c) => { c.disabled = !!text; });
}

// Private <-> Public switch of a playlist row.
async function setPublic(row, playlist, on) {
  const { invoke } = window.__TAURI__.core;
  clearError();
  if (!isLoggedIn()) {
    row.querySelector('[data-act=public]').checked = !on;
    showError('Log in to make a playlist public.', true);
    return;
  }
  setRowStatus(row, on ? 'Uploading...' : 'Removing from the hub...');
  try {
    if (on) await invoke('publish_playlist', { token: getToken(), id: playlist.id, author: getUsername() || '' });
    else await invoke('unpublish_playlist', { token: getToken(), id: playlist.id });
  } catch (err) {
    showError(String(err));
  }
  renderPlaylists();
}

// An edited public playlist: upload the new version, then the old one is removed.
async function republish(playlist) {
  const { invoke } = window.__TAURI__.core;
  if (!isLoggedIn()) {
    showError('Saved here, but log in to update the public copy.', true);
    return;
  }
  const row = document.querySelector(`.bg-playlist-row[data-id="${playlist.id}"]`);
  if (row) setRowStatus(row, 'Updating the public copy...');
  try {
    await invoke('publish_playlist', { token: getToken(), id: playlist.id, author: getUsername() || '' });
  } catch (err) {
    showError(String(err));
  }
  renderPlaylists();
}

async function renderPlaylists() {
  const { invoke } = window.__TAURI__.core;
  const config = await invoke('get_backgrounds_config').catch(() => ({ playlists: [], active_playlist: null }));
  const list = document.getElementById('bg-playlist-list');
  if (!config.playlists.length) {
    list.innerHTML = '<div class="empty-state">No playlists yet - select some images in Browse and save them as one.</div>';
    return;
  }
  list.innerHTML = config.playlists
    .map(
      (p) => `
    <div class="bg-playlist-row ${p.id === config.active_playlist ? 'is-active' : ''}" data-id="${p.id}">
      <div class="bg-playlist-name">${escapeHtml(p.name)}</div>
      <div class="bg-playlist-count">${p.images.length} image${p.images.length === 1 ? '' : 's'}</div>
      <span class="bg-playlist-status" data-status></span>
      <select class="settings-input bg-interval" data-act="interval" title="Change background">
        ${INTERVALS.map(([sec, label]) => `<option value="${sec}"${(p.interval || 0) === sec ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <label class="bg-switch" title="Share this playlist with the community">
        <input type="checkbox" data-act="public"${p.public_id ? ' checked' : ''} />
        <span class="bg-switch-track"></span>
        <span class="bg-switch-label">${p.public_id ? 'Public' : 'Private'}</span>
      </label>
      <button class="btn" data-act="active">${p.id === config.active_playlist ? 'Active' : 'Make active'}</button>
      <button class="btn" data-act="edit">Edit</button>
      <button class="btn" data-act="delete">Delete</button>
    </div>`
    )
    .join('');
  list.querySelectorAll('.bg-playlist-row').forEach((row) => {
    const id = row.dataset.id;
    const playlist = config.playlists.find((p) => p.id === id);
    row.querySelector('[data-act=active]').onclick = async () => {
      await invoke('set_active_playlist', { id });
      renderPlaylists();
      recheckBackground(true);
    };
    row.querySelector('[data-act=interval]').onchange = async (e) => {
      await invoke('set_playlist_interval', { id, interval: Number(e.target.value) });
      recheckBackground();
    };
    row.querySelector('[data-act=public]').onchange = (e) => setPublic(row, playlist, e.target.checked);
    row.querySelector('[data-act=edit]').onclick = () => {
      editingId = id;
      selected = new Set(playlist.images);
      document.getElementById('bg-selection-name').value = playlist.name;
      window.__bgSubtab('browse');
    };
    row.querySelector('[data-act=delete]').onclick = async () => {
      clearError();
      if (playlist.public_id) {
        if (!isLoggedIn()) {
          showError('Log in to remove the public copy of this playlist first.', true);
          return;
        }
        setRowStatus(row, 'Removing from the hub...');
        try {
          await invoke('unpublish_playlist', { token: getToken(), id });
        } catch (err) {
          setRowStatus(row, '');
          showError(String(err));
          return;
        }
      }
      await invoke('delete_playlist', { id });
      renderPlaylists();
    };
  });
}

window.__bgSubtab = function (tab) {
  currentSubtab = tab;
  document.querySelectorAll('#view-backgrounds .subtab-btn[data-subtab]').forEach((el) => el.classList.toggle('active', el.dataset.subtab === tab));
  document.getElementById('bg-browse-view').style.display = tab === 'browse' ? '' : 'none';
  document.getElementById('bg-playlists-view').style.display = tab === 'playlists' ? '' : 'none';
  document.getElementById('bg-community-view').style.display = tab === 'community' ? '' : 'none';
  document.getElementById('bg-upload-btn').style.display = tab === 'community' ? 'none' : '';
  clearError();
  if (tab === 'browse') renderBrowse();
  else if (tab === 'playlists') renderPlaylists();
  else renderCommunity();
};

async function renderCommunity() {
  const { invoke } = window.__TAURI__.core;
  const grid = document.getElementById('bg-community-grid');
  document.querySelectorAll('#bg-community-view [data-csection]').forEach((el) => el.classList.toggle('active', el.dataset.csection === communitySection));
  grid.innerHTML = '<div class="empty-state">Loading...</div>';
  const data = await loadCommunity(invoke);
  if (communitySection === 'images') {
    grid.innerHTML = imageCardsHtml(data.images, data.myImages);
    grid.querySelectorAll('.browse-card').forEach((card) => {
      const row = data.images.rows.find((r) => r.id === card.dataset.id);
      card.querySelector('[data-act=add-image]').onclick = async (e) => {
        const btn = e.currentTarget;
        clearError();
        btn.disabled = true;
        btn.textContent = 'Adding...';
        try {
          await invoke('download_hub_background', { id: row.id, name: row.name });
          btn.textContent = 'Added';
          await refreshImages();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Add';
          showError(String(err));
        }
      };
    });
    return;
  }
  grid.innerHTML = playlistCardsHtml(data.playlists, data.myPlaylists);
  grid.querySelectorAll('.browse-card').forEach((card) => {
    card.onclick = () => openPreview(data.playlists.rows.find((r) => r.id === card.dataset.id));
  });
}

window.__bgCommunity = function (section) {
  communitySection = section;
  renderCommunity();
};

function closePreview() {
  document.getElementById('bg-preview').hidden = true;
}

function openPreview(row) {
  const { invoke } = window.__TAURI__.core;
  const box = document.getElementById('bg-preview');
  document.getElementById('bg-preview-title').textContent = `${row.name} - by ${row.author || '?'}`;
  document.getElementById('bg-preview-grid').innerHTML = (row.gallery || [])
    .map((f) => `<img loading="lazy" src="${galleryUrl(row, f)}" alt="">`)
    .join('');
  const add = document.getElementById('bg-preview-add');
  add.disabled = false;
  add.textContent = 'Add to my playlists';
  add.onclick = async () => {
    clearError();
    add.disabled = true;
    add.textContent = 'Adding...';
    try {
      await invoke('download_hub_playlist', { id: row.id, name: row.name, author: row.author || '' });
      await refreshImages();
      closePreview();
      window.__bgSubtab('playlists');
    } catch (err) {
      add.disabled = false;
      add.textContent = 'Add to my playlists';
      showError(String(err));
    }
  };
  document.getElementById('bg-preview-close').onclick = closePreview;
  box.hidden = false;
}

export async function init() {
  const { invoke } = window.__TAURI__.core;
  await refreshImages();
  renderBrowse();

  // A background or playlist was beamed in from the site.
  window.addEventListener('backgrounds-changed', async () => {
    await refreshImages();
    window.__bgSubtab(currentSubtab === 'community' ? 'playlists' : currentSubtab);
  });

  document.getElementById('bg-upload-btn').onclick = async () => {
    document.getElementById('bg-error').hidden = true;
    const { open } = window.__TAURI__.dialog;
    const chosen = await open({
      multiple: false,
      title: 'Upload a background image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (!chosen) return;
    try {
      await invoke('upload_background_image', { path: chosen });
      await refreshImages();
      renderBrowse();
    } catch (err) {
      showError(String(err));
    }
  };

  document.getElementById('bg-selection-save').onclick = async () => {
    document.getElementById('bg-error').hidden = true;
    const name = document.getElementById('bg-selection-name').value.trim();
    if (!name) {
      showError('Give the playlist a name.');
      return;
    }
    try {
      const saved = await invoke('save_playlist', { id: editingId, name, images: Array.from(selected) });
      resetSelection();
      renderBrowse();
      await renderPlaylists();
      if (saved.public_id) await republish(saved);
    } catch (err) {
      showError(String(err));
    }
  };

  document.getElementById('bg-selection-cancel').onclick = () => {
    resetSelection();
    renderBrowse();
  };
}
