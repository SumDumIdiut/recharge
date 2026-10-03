import { escapeHtml, ICON_TRASH } from '../ui.js';

let images = []; // filenames, newest first
let selected = new Set();
let editingId = null;
let currentSubtab = 'browse';

function showError(msg) {
  const el = document.getElementById('bg-error');
  el.textContent = msg;
  el.hidden = false;
}

async function refreshImages() {
  const { invoke } = window.__TAURI__.core;
  images = await invoke('list_background_images').catch(() => []);
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
        <span class="browse-card-meta">${selected.has(file) ? 'Selected' : ''}</span>
        <div class="browse-card-actions-right">
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
    card.querySelector('[data-act=delete]').onclick = async (e) => {
      e.stopPropagation();
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
    };
    row.querySelector('[data-act=edit]').onclick = () => {
      editingId = id;
      selected = new Set(playlist.images);
      document.getElementById('bg-selection-name').value = playlist.name;
      window.__bgSubtab('browse');
    };
    row.querySelector('[data-act=delete]').onclick = async () => {
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
  if (tab === 'browse') renderBrowse();
  else renderPlaylists();
};

export async function init() {
  const { invoke } = window.__TAURI__.core;
  await refreshImages();
  renderBrowse();

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
      await invoke('save_playlist', { id: editingId, name, images: Array.from(selected) });
      resetSelection();
      renderBrowse();
      renderPlaylists();
    } catch (err) {
      showError(String(err));
    }
  };

  document.getElementById('bg-selection-cancel').onclick = () => {
    resetSelection();
    renderBrowse();
  };
}
