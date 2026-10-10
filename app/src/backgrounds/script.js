import { escapeHtml, ICON_TRASH } from '../ui.js';
import { getToken, getUsername, isLoggedIn } from '../auth.js';
import { openAccount } from '../login-prompt.js';
import { recheckBackground, applySoundSetting } from '../theme.js';
import { getAudioPrefs, saveAudioPrefs } from '../bgmedia.js';
import { lazyThumb, loadThumb, hubCoverThumb, schedulePosters, forgetPoster } from './thumbs.js';
import { mediaKind, countsText, formatDuration, cardAction, SHARE_HINT, activeButtonLabel, addingText, errText, activeTarget, soundOptions, PLAY_OVERLAY, MAY_NOT_PLAY_TEXT, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, LIMITS_MB, withoutPosters } from './media.js';

import { newDraft, draftFromPlaylist, addItems, removeItem, moveItem, editorSoundOptions, validateDraft, savePayload, summarizeImport, progressText, skippedText, pathsFrom, LIMITS_TEXT } from './editor.js';
import { loadCommunity, imageCardsHtml, playlistCardsHtml, previewTilesHtml, startPreview, fillHubCovers, applyCover, UNSUPPORTED_PLAYLISTS as UNSUPPORTED } from './community.js';

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
let draft = null; // the playlist being edited in the Playlists tab
let currentSubtab = 'browse';
let communitySection = 'images';
let imagePublic = {}; // file -> hub id while public
let shareMode = false;
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>';

const audioPrefs = () => getAudioPrefs();

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
  images = withoutPosters(await invoke('list_background_images').catch(() => [])); // poster sidecars are never items
  const config = await invoke('get_backgrounds_config').catch(() => ({}));
  imagePublic = config.image_public || {};
}

// Puts the picture / video frame of a library file into a thumbnail element (and a video's duration into its badge).
// Small cached thumbnails (see thumbs.js), fetched only when the element is near the viewport.
function fillThumb(invoke, el, file) {
  const kind = mediaKind(file);
  if (kind !== 'image' && kind !== 'video') return;
  lazyThumb(el, async () => {
    const t = await loadThumb(invoke, file, kind);
    if (!el.isConnected && !t) return;
    if (t?.url) el.style.backgroundImage = `url("${t.url}")`;
    else if (kind === 'image' && !t) {
      // media server not reachable: fall back to the whole picture through the backend
      invoke('read_background_image', { fileName: file }).then((url) => { el.style.backgroundImage = `url("${url}")`; }).catch(() => {});
    }
    if (kind === 'video') {
      // a video the engine could not decode / read: say so instead of leaving a black tile
      el.classList.toggle('is-failed', !t?.url);
      el.classList.toggle('has-cover', !!t?.cover);
      el.classList.toggle('may-not-play', !!t?.mayNotPlay);
      if (!t?.url) el.title = `Can't preview this video${t?.reason ? ` (${t.reason})` : ''}${t?.mayNotPlay ? ` - ${MAY_NOT_PLAY_TEXT}` : ''}`;
      else if (t.mayNotPlay) el.title = `This video ${MAY_NOT_PLAY_TEXT}`;
      const badge = el.parentElement?.querySelector('[data-duration]') || el.querySelector('[data-duration]');
      if (badge) badge.textContent = formatDuration(t?.duration) || 'video';
    }
  });
}

function updateShareUi() {
  const btn = document.getElementById('bg-share-btn');
  btn.classList.toggle('btn-primary', shareMode);
  btn.classList.toggle('is-on', shareMode);
  btn.setAttribute('aria-pressed', String(shareMode));
  const hint = document.getElementById('bg-share-hint');
  hint.hidden = !shareMode;
  hint.textContent = SHARE_HINT;
}

function renderBrowse() {
  const { invoke } = window.__TAURI__.core;
  const grid = document.getElementById('bg-browse-grid');
  grid.classList.toggle('bg-share-mode', shareMode);
  updateShareUi();
  if (!images.length) {
    grid.innerHTML = '<div class="empty-state">No backgrounds yet - click Add image... to add pictures, videos or sounds.</div>';
    return;
  }
  grid.innerHTML = images
    .map((file) => {
      const kind = mediaKind(file);
      const shared = !!imagePublic[file];
      return `
    <div class="browse-card" data-file="${escapeHtml(file)}" data-kind="${kind}">
      <div class="browse-card-media">
        <div class="browse-card-thumb${kind === 'audio' ? ' bg-audio-thumb' : ''}" data-thumb="${escapeHtml(file)}">${kind === 'audio' ? NOTE_ICON : ''}${kind === 'video' ? PLAY_OVERLAY : ''}</div>
        ${kind === 'video' ? '<span class="bg-duration" data-duration></span>' : ''}
        ${shared ? '<span class="badge-shared">Shared</span>' : ''}
      </div>
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(file)}</div>
      </div>
      <div class="browse-card-actions">
        <span class="browse-card-meta" data-status></span>
        <div class="browse-card-actions-right">
          <button class="icon-btn" title="Delete" data-act="delete">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
    })
    .join('');

  grid.querySelectorAll('.browse-card').forEach((card) => {
    const file = card.dataset.file;
    card.onclick = () => {
      const action = cardAction({ shareMode, shared: !!imagePublic[file], loggedIn: isLoggedIn() });
      if (action === 'none') return;
      if (action === 'login') {
        showError('Log in to share an image.', true);
      } else {
        setImagePublic(card, file, action === 'publish');
      }
    };
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
      await invoke('delete_background_image', { fileName: file }); // the backend removes the poster too
      forgetPoster(file);
      await refreshImages();
      renderBrowse();
    };
  });
  grid.querySelectorAll('[data-thumb]').forEach((el) => fillThumb(invoke, el, el.dataset.thumb));
}

function setCardBusy(card, text) {
  const el = card.querySelector('[data-status]');
  if (el) el.textContent = text;
  card.querySelectorAll('input, button').forEach((c) => { c.disabled = !!text; });
}

// Share mode click: upload the image as public, or take the public copy down again.
async function setImagePublic(card, file, on) {
  const { invoke } = window.__TAURI__.core;
  clearError();
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
    list.innerHTML = '<div class="empty-state">No playlists yet - click + New playlist to make one.</div>';
    return;
  }
  list.innerHTML = config.playlists
    .map(
      (p) => `
    <div class="bg-playlist-row ${p.id === config.active_playlist ? 'is-active' : ''}" data-id="${p.id}">
      <div class="bg-playlist-name">${escapeHtml(p.name)}</div>
      <div class="bg-playlist-count">${escapeHtml(countsText(p.images))}</div>
      <span class="bg-playlist-status" data-status></span>
      <select class="settings-input bg-interval" data-act="interval" title="Change background">
        ${INTERVALS.map(([sec, label]) => `<option value="${sec}"${(p.interval || 0) === sec ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <label class="bg-switch" title="Share this playlist with the community">
        <input type="checkbox" data-act="public"${p.public_id ? ' checked' : ''} />
        <span class="bg-switch-track"></span>
        <span class="bg-switch-label">${p.public_id ? 'Public' : 'Private'}</span>
      </label>
      <select class="settings-input bg-interval" data-act="sound" title="Sound while this playlist is active (turn the speaker on above)">
        ${soundOptions(images).map(([v, label]) => `<option value="${escapeHtml(v)}"${(p.sound || 'auto') === v ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
      <button class="btn" data-act="active">${activeButtonLabel(p.id, config.active_playlist)}</button>
      <button class="btn" data-act="edit">Edit</button>
      <button class="btn" data-act="delete">Delete</button>
    </div>`
    )
    .join('');
  list.querySelectorAll('.bg-playlist-row').forEach((row) => {
    const id = row.dataset.id;
    const playlist = config.playlists.find((p) => p.id === id);
    row.querySelector('[data-act=active]').onclick = async () => {
      await invoke('set_active_playlist', { id: activeTarget(id, config.active_playlist) });
      renderPlaylists();
      recheckBackground(true);
    };
    row.querySelector('[data-act=sound]').onchange = async (e) => {
      await invoke('set_playlist_sound', { id, sound: e.target.value });
      applySoundSetting();
    };
    row.querySelector('[data-act=interval]').onchange = async (e) => {
      await invoke('set_playlist_interval', { id, interval: Number(e.target.value) });
      recheckBackground();
    };
    row.querySelector('[data-act=public]').onchange = (e) => setPublic(row, playlist, e.target.checked);
    row.querySelector('[data-act=edit]').onclick = () => {
      openEditor(draftFromPlaylist(playlist));
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
  for (const id of ['bg-upload-btn', 'bg-share-btn']) document.getElementById(id).style.display = tab === 'community' ? 'none' : '';
  document.getElementById('bg-share-hint').hidden = !(shareMode && tab === 'browse');
  clearError();
  if (tab === 'browse') renderBrowse();
  else if (tab === 'playlists') renderPlaylists();
  else renderCommunity();
};

let hubCovers = null; // the running "pictures for video cards" job; aborted when the grid is redrawn or the tab changes
const coverEnv = { cover: (key, reader) => hubCoverThumb(key, reader) };

async function renderCommunity() {
  hubCovers?.abort();
  hubCovers = null;
  const { invoke } = window.__TAURI__.core;
  const grid = document.getElementById('bg-community-grid');
  document.querySelectorAll('#bg-community-view [data-csection]').forEach((el) => el.classList.toggle('active', el.dataset.csection === communitySection));
  grid.innerHTML = '<div class="empty-state">Loading...</div>';
  const data = await loadCommunity(invoke);
  if (communitySection === 'images') {
    grid.innerHTML = imageCardsHtml(data.images, data.myImages, data.imageAdded);
    hubCovers = fillHubCovers(grid, coverEnv);
    grid.querySelectorAll('.browse-card').forEach((card) => {
      const row = data.images.rows.find((r) => r.id === card.dataset.id);
      card.querySelector('[data-act=add-image]').onclick = async (e) => {
        if (e.currentTarget.disabled) return;
        const btn = e.currentTarget;
        clearError();
        btn.disabled = true;
        btn.textContent = 'Adding...';
        try {
          await invoke('download_hub_background', { id: row.id, name: row.name });
          postersSoon();
          btn.textContent = 'Added';
          await refreshImages();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Add';
          showError(`Couldn't add "${row.name}": ${errText(err)}`);
        }
      };
    });
    return;
  }
  grid.innerHTML = playlistCardsHtml(data.playlists, data.myPlaylists, data.playlistAdded);
  hubCovers = fillHubCovers(grid, coverEnv);
  grid.querySelectorAll('.browse-card').forEach((card) => {
    card.onclick = () => openPreview(data.playlists.rows.find((r) => r.id === card.dataset.id), data.playlistAdded);
  });
}

window.__bgCommunity = function (section) {
  communitySection = section;
  renderCommunity();
};

let previewMedia = null;
function closePreview() {
  previewMedia?.release(); // videos paused + emptied, sound stopped
  previewMedia = null;
  document.getElementById('bg-preview').hidden = true;
}

function openPreview(row, isAdded = () => false) {
  const { invoke } = window.__TAURI__.core;
  const box = document.getElementById('bg-preview');
  document.getElementById('bg-preview-title').textContent = `${row.name} - by ${row.author || '?'}`;
  previewMedia?.release();
  const grid = document.getElementById('bg-preview-grid');
  grid.innerHTML = previewTilesHtml(row);
  previewMedia = startPreview(grid, undefined, coverEnv);
  const add = document.getElementById('bg-preview-add');
  const already = isAdded(row);
  add.disabled = already;
  add.textContent = already ? 'Added' : 'Add to my playlists';
  add.onclick = async () => {
    if (already) return;
    clearError();
    add.disabled = true;
    add.textContent = 'Adding...';
    // the download can take minutes on a slow connection: show the percentage the backend reports
    let unlisten = null;
    try {
      unlisten = await window.__TAURI__.event?.listen?.('hub-download-progress', (e) => {
        if (e.payload?.id === row.id) add.textContent = addingText(e.payload.percent, e.payload.total);
      });
    } catch (e) {}
    try {
      await invoke('download_hub_playlist', { id: row.id, name: row.name, author: row.author || '' });
      postersSoon();
      await refreshImages();
      closePreview();
      window.__bgSubtab('playlists');
    } catch (err) {
      add.disabled = false;
      add.textContent = 'Add to my playlists';
      showError(`Couldn't add "${row.name}": ${errText(err)}`);
    } finally {
      try { unlisten?.(); } catch (e) {}
    }
  };
  document.getElementById('bg-preview-close').onclick = closePreview;
  box.hidden = false;
}

// ---- Playlist editor ----
const $ = (id) => document.getElementById(id);
let importing = false;
let pickerChosen = new Set();

function setProgress(text) {
  const el = $('bg-ed-progress');
  el.textContent = text || '';
  el.hidden = !text;
}

function setSkipped(lines) {
  const el = $('bg-ed-skipped');
  el.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') + (lines.length ? `<div>${escapeHtml(LIMITS_TEXT)}</div>` : '');
  el.hidden = !lines.length;
}

function openEditor(d) {
  const { invoke } = window.__TAURI__.core;
  clearError();
  draft = d;
  $('bg-editor-title').textContent = d.id ? `Edit playlist` : 'New playlist';
  $('bg-ed-name').value = d.name;
  $('bg-ed-interval').innerHTML = INTERVALS.map(([sec, label]) => `<option value="${sec}"${d.interval === sec ? ' selected' : ''}>${label}</option>`).join('');
  setProgress('');
  setSkipped([]);
  $('bg-ed-picker').hidden = true;
  $('bg-editor').hidden = false;
  $('bg-pl-toolbar').hidden = true;
  $('bg-playlist-list').hidden = true;
  renderEditor(invoke);
  $('bg-ed-name').focus();
}

function closeEditor() {
  draft = null;
  importing = false;
  $('bg-editor').hidden = true;
  $('bg-pl-toolbar').hidden = false;
  $('bg-playlist-list').hidden = false;
}

function renderSoundSelect() {
  $('bg-ed-sound').innerHTML = editorSoundOptions(draft)
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${draft.sound === v ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
}

function renderEditor(invoke) {
  renderSoundSelect();
  const n = draft.items.length;
  $('bg-ed-count').textContent = `${n} item${n === 1 ? '' : 's'} - drag to reorder`;
  const strip = $('bg-ed-strip');
  if (!n) {
    strip.innerHTML = '<div class="bg-empty-strip">Nothing here yet - add files, a folder, or items from your library.</div>';
    return;
  }
  strip.innerHTML = draft.items
    .map((file, i) => {
      const kind = mediaKind(file);
      return `<div class="bg-strip-item" draggable="true" data-i="${i}" data-kind="${kind}">
      <button class="bg-strip-remove" data-act="remove" title="Remove from playlist" aria-label="Remove ${escapeHtml(file)}">x</button>
      <div class="bg-strip-thumb${kind === 'audio' ? ' bg-audio-thumb' : ''}" data-thumb="${escapeHtml(file)}">${kind === 'audio' ? NOTE_ICON : ''}${kind === 'video' ? PLAY_OVERLAY + '<span class="bg-badge" data-duration>video</span>' : ''}</div>
      <div class="bg-strip-name" title="${escapeHtml(file)}">${escapeHtml(file)}</div>
      <div class="bg-strip-ctl"><button data-act="left" title="Move earlier" aria-label="Move earlier"${i === 0 ? ' disabled' : ''}>&larr;</button><button data-act="right" title="Move later" aria-label="Move later"${i === n - 1 ? ' disabled' : ''}>&rarr;</button></div>
    </div>`;
    })
    .join('');
  let dragFrom = null;
  strip.querySelectorAll('.bg-strip-item').forEach((el) => {
    const i = Number(el.dataset.i);
    fillThumb(invoke, el.querySelector('[data-thumb]'), draft.items[i]);
    el.querySelector('[data-act=remove]').onclick = () => { removeItem(draft, i); renderEditor(invoke); };
    el.querySelector('[data-act=left]').onclick = () => { moveItem(draft, i, i - 1); renderEditor(invoke); };
    el.querySelector('[data-act=right]').onclick = () => { moveItem(draft, i, i + 1); renderEditor(invoke); };
    el.ondragstart = (e) => {
      dragFrom = i;
      el.classList.add('is-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }
    };
    el.ondragend = () => { el.classList.remove('is-dragging'); strip.querySelectorAll('.is-over').forEach((x) => x.classList.remove('is-over')); };
    el.ondragover = (e) => { if (dragFrom === null) return; e.preventDefault(); el.classList.add('is-over'); };
    el.ondragleave = () => el.classList.remove('is-over');
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('is-over');
      if (dragFrom === null) return;
      moveItem(draft, dragFrom, i);
      dragFrom = null;
      renderEditor(invoke);
    };
  });
}

// Imports the given paths one at a time (so the progress line updates), then adds them to the draft.
async function importPaths(invoke, paths, extra = {}) {
  if (!paths.length) {
    setSkipped(skippedText([], extra));
    return;
  }
  importing = true;
  setSkipped([]);
  const results = [];
  for (let i = 0; i < paths.length; i++) {
    setProgress(progressText(i, paths.length));
    try {
      const r = await invoke('import_background_files', { paths: [paths[i]] });
      results.push(...r);
    } catch (err) {
      results.push({ source: paths[i], error: String(err) });
    }
    if (!draft) { importing = false; return; } // editor closed meanwhile
  }
  const { added, skipped } = summarizeImport(results);
  addItems(draft, added);
  postersSoon();
  await refreshImages();
  importing = false;
  setProgress(`Added ${added.length} of ${paths.length}.`);
  setSkipped(skippedText(skipped, extra));
  renderEditor(invoke);
}

function openPicker(invoke) {
  pickerChosen = new Set();
  const grid = $('bg-ed-picker-grid');
  if (!images.length) {
    grid.innerHTML = '<div class="bg-empty-strip">Your library is empty - use Add files... first.</div>';
  } else {
    grid.innerHTML = images
      .map((file) => {
        const kind = mediaKind(file);
        const inList = draft.items.includes(file);
        return `<label class="bg-pick" data-file="${escapeHtml(file)}">
        <input type="checkbox" ${inList ? 'checked disabled' : ''} aria-label="${escapeHtml(file)}" />
        <div class="bg-strip-thumb${kind === 'audio' ? ' bg-audio-thumb' : ''}" data-thumb="${escapeHtml(file)}">${kind === 'audio' ? NOTE_ICON : ''}${kind === 'video' ? PLAY_OVERLAY + '<span class="bg-badge" data-duration>video</span>' : ''}${kind === 'audio' ? '<span class="bg-badge">sound</span>' : ''}</div>
        <div class="bg-strip-name" title="${escapeHtml(file)}">${escapeHtml(file)}${inList ? ' (in playlist)' : ''}</div>
      </label>`;
      })
      .join('');
    grid.querySelectorAll('.bg-pick').forEach((el) => {
      fillThumb(invoke, el.querySelector('[data-thumb]'), el.dataset.file);
      const box = el.querySelector('input');
      box.onchange = () => {
        if (box.checked) pickerChosen.add(el.dataset.file);
        else pickerChosen.delete(el.dataset.file);
        el.classList.toggle('is-picked', box.checked);
      };
    });
  }
  $('bg-ed-picker').hidden = false;
}

function wireEditor(invoke) {
  $('bg-pl-new').onclick = () => openEditor(newDraft());
  $('bg-ed-cancel').onclick = () => closeEditor();
  $('bg-ed-name').oninput = (e) => { draft.name = e.target.value; };
  $('bg-ed-interval').onchange = (e) => { draft.interval = Number(e.target.value); };
  $('bg-ed-sound').onchange = (e) => { draft.sound = e.target.value; };

  $('bg-ed-files').onclick = async () => {
    if (importing) return;
    clearError();
    try {
      const chosen = await window.__TAURI__.dialog.open({
        multiple: true,
        title: 'Add pictures, videos and sounds',
        filters: [
          { name: 'Pictures, videos and sounds', extensions: [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS] },
          { name: 'Pictures', extensions: IMAGE_EXTS },
          { name: 'Videos', extensions: VIDEO_EXTS },
          { name: 'Sounds', extensions: AUDIO_EXTS },
        ],
      });
      await importPaths(invoke, pathsFrom(chosen));
    } catch (err) {
      importing = false;
      showError(String(err));
    }
  };

  $('bg-ed-folder').onclick = async () => {
    if (importing) return;
    clearError();
    try {
      const chosen = pathsFrom(await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: 'Add a folder' }))[0];
      if (!chosen) return;
      setProgress('Looking through the folder...');
      const listing = await invoke('list_media_in_folder', { path: chosen, recursive: $('bg-ed-recursive').checked });
      setProgress('');
      if (!listing.files.length) {
        setSkipped(['No pictures, videos or sounds found in that folder.', ...skippedText([], listing)]);
        return;
      }
      await importPaths(invoke, listing.files, { unsupported: listing.unsupported, truncated: listing.truncated });
    } catch (err) {
      importing = false;
      setProgress('');
      showError(String(err));
    }
  };

  $('bg-ed-library').onclick = () => (!$('bg-ed-picker').hidden ? ($('bg-ed-picker').hidden = true) : openPicker(invoke));
  $('bg-ed-picker-close').onclick = () => { $('bg-ed-picker').hidden = true; };
  $('bg-ed-picker-add').onclick = () => {
    // keep the library's order
    addItems(draft, images.filter((f) => pickerChosen.has(f)));
    $('bg-ed-picker').hidden = true;
    renderEditor(invoke);
  };

  $('bg-ed-save').onclick = async () => {
    clearError();
    if (importing) { showError('Wait for the files to finish adding.'); return; }
    const bad = validateDraft(draft);
    if (bad) { showError(bad); $('bg-ed-name').focus(); return; }
    const p = savePayload(draft);
    try {
      const saved = await invoke('save_playlist', { id: p.id, name: p.name, images: p.images });
      await invoke('set_playlist_interval', { id: saved.id, interval: p.interval });
      await invoke('set_playlist_sound', { id: saved.id, sound: p.sound });
      closeEditor();
      await renderPlaylists();
      recheckBackground(true);
      if (saved.public_id) await republish(saved);
    } catch (err) {
      showError(String(err));
    }
  };
}

// New videos entered the library (added, imported, downloaded): their posters are made in the background, one at a time.
function postersSoon() {
  try { schedulePosters(window.__TAURI__.core.invoke, { delay: 300 }); } catch (e) {}
}

export async function init() {
  const { invoke } = window.__TAURI__.core;
  await refreshImages();
  renderBrowse();

  // A background or playlist was beamed in from the site.
  window.addEventListener('backgrounds-changed', async () => {
    postersSoon();
    await refreshImages();
    window.__bgSubtab(currentSubtab === 'community' ? 'playlists' : currentSubtab);
  });

  document.getElementById('bg-upload-btn').onclick = async () => {
    document.getElementById('bg-error').hidden = true;
    const { open } = window.__TAURI__.dialog;
    const chosen = await open({
      multiple: false,
      title: 'Add a background',
      filters: [
        { name: 'Pictures, videos and sounds', extensions: [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS] },
        { name: 'Pictures', extensions: IMAGE_EXTS },
        { name: 'Videos', extensions: VIDEO_EXTS },
        { name: 'Sounds', extensions: AUDIO_EXTS },
      ],
    });
    if (!chosen) return;
    try {
      await invoke('upload_background_image', { path: chosen });
      postersSoon();
      await refreshImages();
      renderBrowse();
    } catch (err) {
      showError(String(err));
    }
  };

  document.getElementById('bg-share-btn').onclick = () => {
    shareMode = !shareMode;
    clearError();
    renderBrowse();
  };

  // Speaker + volume (the sound itself is chosen per playlist; off by default).
  const speaker = document.getElementById('bg-speaker');
  const volume = document.getElementById('bg-volume');
  const keep = document.getElementById('bg-keep-playing');
  const syncAudioUi = () => {
    const p = audioPrefs();
    speaker.classList.toggle('is-on', p.enabled);
    speaker.textContent = p.enabled ? 'Sound on' : 'Sound off';
    speaker.setAttribute('aria-pressed', String(p.enabled));
    volume.value = String(Math.round(p.volume * 100));
    keep.checked = p.keepPlaying;
  };
  speaker.onclick = () => { const p = audioPrefs(); saveAudioPrefs({ ...p, enabled: !p.enabled }); syncAudioUi(); };
  volume.oninput = () => saveAudioPrefs({ ...audioPrefs(), volume: Number(volume.value) / 100 });
  keep.onchange = () => saveAudioPrefs({ ...audioPrefs(), keepPlaying: keep.checked });
  syncAudioUi();

  wireEditor(invoke);
}
