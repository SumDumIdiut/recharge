import { isActive, onActivity } from '../activity.js';
import { getToken, getUsername, isLoggedIn, isAdmin } from '../auth.js';
import { uploaderHtml } from '../social/avatar.js';
import { canRemoveUpload } from '../social/perms.js';
import { requireLogin } from '../login-prompt.js';
import { hubStamp, cardImage, needsView, viewFailed, retryView } from './mapthumb.js';
import { mountComments } from '../social/comments.js';
import { escapeHtml, galleryImages, sleep, thumb, openModal, closeModal, setBadgeState, confirmDestructive, armConfirm, ICON_CHECK, ICON_DOWNLOAD, ICON_TRASH, patchCards } from '../ui.js';

import { HUB_BASE } from '../hub.js';
import { checkTab } from '../autoupdate.js';
import { fillUpdateSelect, chosenUpdate } from '../upload-update.js';
import { isTestMap } from './test-map.js';
import { submissions } from '../social/api.js';

let currentSubtab = 'installed';
let searchTerm = '';
let installedCache = [];
// Installed maps' pictures (the whole map, zoomed out): id -> data URL.
const thumbs = new Map();
let catalog = [];
let catalogError = false;
let myUploadIds = new Set();
let myUploads = []; // the user's own map uploads (id, name, mapUid, ...), for the upload form's "Update of"
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
      // Keyed on what changes when a map is updated, not on when it was first published:
      // createdAt never moves, so a stamp built from it would reuse the drawn view of the
      // first version forever and the thumbnail would never change.
      stamp: hubStamp(`${row.updatedAt || row.createdAt}|${row.revision || 1}`),
      revision: row.revision || 1,
      updatedAt: row.updatedAt || row.createdAt,
      uploader: row.uploader || null,
      uploader_name_color: row.uploader_name_color || null,
      images: galleryImages(row.gallery).map((f) => `${HUB_BASE}/api/maps/${row.id}/gallery/${encodeURIComponent(f)}`),
      image: galleryImages(row.gallery).length ? `${HUB_BASE}/api/maps/${row.id}/gallery/${encodeURIComponent(galleryImages(row.gallery)[0])}` : null,
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
    myUploads = [];
    return;
  }
  try {
    const rows = await submissions.mine();
    myUploads = (Array.isArray(rows) ? rows : []).filter((r) => r.kind === 'map');
    myUploadIds = new Set(myUploads.map((r) => r.id));
  } catch {
    myUploadIds = new Set();
    myUploads = [];
  }
}

// A map from the Hub goes by its Hub name (two uploads of one map can share the name in their files).
const shownName = (m) => catalog.find((c) => c.id === m.id || c.id === m.hub)?.name || m.name;

// A card's picture: the author's, else the map drawn zoomed out. When that could not be drawn the card
// says so, and offers another try, rather than showing an empty box for ever.
function cardThumb(id, uploaded, drawn, badge) {
  const pic = cardImage(uploaded, drawn);
  const retry = !pic && viewFailed(id)
    ? `<button class="thumb-retry" title="The map's view could not be drawn" onclick="event.stopPropagation(); window.__mapRetryView('${escapeHtml(id)}')">view unavailable - retry</button>`
    : '';
  return thumb(pic, badge, retry);
}
// Another try at a map whose view failed: what failed is forgotten, and the view is drawn again.
window.__mapRetryView = function (id) {
  if (!retryView(id)) return;
  render();
  loadThumbs();
};

function renderInstalled() {
  const list = document.getElementById('maps-installed-view');
  const filtered = installedCache
    .filter((m) => matchesSearch(shownName(m)))
    .sort((a, b) => shownName(a).localeCompare(shownName(b), undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    patchCards(list, [], installedCache.length
      ? '<div class="empty-state">No maps match your search.</div>'
      : '<div class="empty-state">No maps installed yet. Browse the catalog to add one.</div>');
    return;
  }
  patchCards(list, filtered
    .map((m) => {
      const entry = catalog.find((c) => c.id === m.id || c.id === m.hub);
      return `
    <div class="browse-card" data-k="${escapeHtml(m.id)}"${entry ? ` onclick="window.__mapOpenDetail('${escapeHtml(entry.id)}')"` : ''}>
      ${cardThumb(m.id, entry?.image, thumbs.get(m.id))}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(shownName(m))}</div>
        <div class="browse-card-meta">${entry?.author ? uploaderHtml(entry) + ' &middot; ' : ''}${m.groupCount} course${m.groupCount === 1 ? '' : 's'}</div>
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="icon-btn" title="Delete" onclick="event.stopPropagation(); window.__mapConfirmUninstall('${escapeHtml(m.id)}', this)">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
    })
  );
}

function renderBrowse() {
  const list = document.getElementById('maps-browse-view');
  if (catalogError) {
    patchCards(list, [], '<div class="empty-state">Couldn\'t reach the Recharge Hub library. Check your connection and reopen this tab.</div>');
    return;
  }
  const filtered = catalog
    .filter((m) => matchesSearch(m.name + ' ' + (m.description || '') + ' ' + (m.author || '')))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (!filtered.length) {
    patchCards(list, [], '<div class="empty-state">No maps published yet.</div>');
    return;
  }
  patchCards(list, filtered
    .map((entry) => {
      const installed = installedCache.some((m) => m.id === entry.id || m.hub === entry.id);
      const badge = installed
        ? `<div class="badge badge-installed" title="Installed">${ICON_CHECK}</div>`
        : `<button class="badge badge-install" title="Install" onclick="event.stopPropagation(); window.__mapInstall('${escapeHtml(entry.id)}', this)">${ICON_DOWNLOAD}</button>`;
      const mine = canRemoveUpload(myUploadIds.has(entry.id), isAdmin());
      return `
    <div class="browse-card" data-k="${escapeHtml(entry.id)}" onclick="window.__mapOpenDetail('${escapeHtml(entry.id)}')">
      ${cardThumb(entry.id, entry.image, thumbs.get(entry.id), badge)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(entry.name)}</div>
        <div class="browse-card-meta">${uploaderHtml(entry)}</div>
      </div>
      <div class="browse-card-desc">${escapeHtml(entry.description || '')}</div>
      ${mine ? `<div class="browse-card-actions">
        <div class="browse-card-actions-right">
          <button class="icon-btn" title="Remove from the Recharge Library" onclick="event.stopPropagation(); window.__mapConfirmDeleteFromHub('${escapeHtml(entry.id)}', '${escapeHtml(entry.name).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>` : ''}
    </div>`;
    })
  );
}

// Map page: a full-page view like the Skins/Mods ones (gallery, description, actions, comments underneath).
// Pictures: the map's Hub gallery, else its drawn view (the same picture its card shows).
let mapComments = null;
let openDetailId = null;
let detailImages = [];
let detailImageIndex = 0;
let detailSig = '';

const installedFor = (entry) => installedCache.find((m) => m.id === entry.id || m.hub === entry.id);

function detailPictures(entry, installed) {
  if (entry.images?.length) return entry.images;
  const pic = cardImage(entry.image, thumbs.get(entry.id) || (installed && thumbs.get(installed.id)));
  return pic ? [pic] : [];
}

window.__mapGalleryStep = function (delta) {
  if (detailImages.length < 2) return;
  detailImageIndex = (detailImageIndex + delta + detailImages.length) % detailImages.length;
  document.getElementById('maps-gallery-img').src = detailImages[detailImageIndex];
  document.getElementById('maps-gallery-count').textContent = `${detailImageIndex + 1} / ${detailImages.length}`;
};

// Builds (or refreshes) the page above the comments. Returns false when the map is gone from the library.
function fillDetail(entry) {
  const installed = installedFor(entry);
  const pics = detailPictures(entry, installed);
  const canRemove = canRemoveUpload(myUploadIds.has(entry.id), isAdmin());
  // Only rebuild when something shown changed, so a thumbnail finishing elsewhere doesn't reset the gallery position.
  const sig = [entry.id, entry.name, entry.author, entry.description, !!installed, installed?.id, canRemove, pics.join('|')].join('\u0001');
  if (sig === detailSig) return;
  detailSig = sig;
  detailImages = pics;
  detailImageIndex = 0;
  const safeName = escapeHtml(entry.name).replace(/'/g, "\\'");
  document.getElementById('maps-detail-body').innerHTML = `
    <button class="crumb-back" onclick="window.__mapCloseDetail()" style="margin-bottom:20px;">&lt; Maps</button>
    ${pics.length ? `<div class="gallery">
      <img class="detail-image" id="maps-gallery-img" src="${escapeHtml(pics[0])}" alt=""${pics.length > 1 ? ' onclick="window.__mapGalleryStep(1)" style="cursor:pointer;"' : ''} />
      ${pics.length > 1 ? `<button class="gallery-nav gallery-prev" title="Previous image" onclick="window.__mapGalleryStep(-1)">&lsaquo;</button>
      <button class="gallery-nav gallery-next" title="Next image" onclick="window.__mapGalleryStep(1)">&rsaquo;</button>
      <div class="gallery-count" id="maps-gallery-count">1 / ${pics.length}</div>` : ''}
    </div>` : ''}
    <div class="detail-header">
      <div class="detail-name">${escapeHtml(entry.name)}</div>
      ${entry.author ? `<div class="detail-meta">by ${uploaderHtml(entry)}</div>` : ''}
    </div>
    ${entry.description ? `<div class="detail-desc">${escapeHtml(entry.description)}</div>` : ''}
    <div class="detail-actions">
      ${installed
        ? `<span class="browse-card-meta">Installed</span>
           <button class="btn btn-danger" onclick="window.__mapConfirmUninstall('${escapeHtml(installed.id)}', this)">Delete</button>`
        : `<button class="btn btn-primary" onclick="window.__mapInstall('${escapeHtml(entry.id)}', this)">Install</button>`}
      ${canRemove ? `<button class="btn btn-danger" onclick="window.__mapConfirmDeleteFromHub('${escapeHtml(entry.id)}', '${safeName}')">Remove from Library</button>` : ''}
    </div>`;
}

window.__mapOpenDetail = function (id) {
  const entry = catalog.find((c) => c.id === id);
  if (!entry) return false;
  const reopen = openDetailId !== id;
  if (reopen) {
    mapComments?.destroy();
    mapComments = null;
    detailSig = '';
    openDetailId = id;
    document.getElementById('maps-detail').innerHTML = '<div id="maps-detail-body" class="detail-main"></div><div id="maps-detail-comments"></div>';
    mapComments = mountComments(document.getElementById('maps-detail-comments'), 'maps', id);
  }
  fillDetail(entry);
  document.getElementById('maps-list').style.display = 'none';
  document.getElementById('maps-detail').style.display = ''; // the stylesheet lays it out (two columns)
  return true;
};
window.__mapCloseDetail = function () {
  mapComments?.destroy();
  mapComments = null;
  openDetailId = null;
  detailSig = '';
  document.getElementById('maps-detail').style.display = 'none';
  document.getElementById('maps-list').style.display = 'block';
};

async function render() {
  document.querySelectorAll('#view-maps .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === currentSubtab));
  document.getElementById('maps-installed-view').style.display = currentSubtab === 'installed' ? '' : 'none';
  document.getElementById('maps-browse-view').style.display = currentSubtab === 'browse' ? '' : 'none';
  document.getElementById('maps-upload-btn').style.display = ''; // always shown: logged-out clicks explain how to log in
  // Only the list on show is drawn; the other is brought up to date when its tab is opened.
  if (currentSubtab === 'installed') renderInstalled(); else renderBrowse();
  // Keep an open map page in step with installs, deletes and finished pictures, or leave it if its map left the library.
  if (openDetailId && !window.__mapOpenDetail(openDetailId)) window.__mapCloseDetail();
}

window.__mapsSubtab = function (tab) {
  currentSubtab = tab;
  document.querySelectorAll('#view-maps .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === tab));
  render();
  loadThumbs();
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

window.__mapConfirmUninstall = function (id, btn) {
  if (!armConfirm(btn)) return;
  btn.disabled = true;
  const { invoke } = window.__TAURI__.core;
  invoke('uninstall_map', { id })
    .then(refresh)
    .catch((err) => { btn.disabled = false; alert(String(err)); });
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
    el.textContent = `None chosen: the map's drawn view is used (up to ${MAX_GALLERY_IMAGES} screenshots)`;
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
// Maps not on the Hub yet, and maps whose Hub entry is the user's own (those can be uploaded as a new version of it).
const uploadable = () => installedCache.filter((m) => !onHub(m) || myUploadIds.has(m.hub) || myUploadIds.has(m.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
// The picked map's own name and description, to start from.
function fillUploadFields() {
  const m = installedCache.find((x) => x.id === document.getElementById('maps-upload-map').value);
  document.getElementById('maps-upload-name').value = m?.name || '';
  document.getElementById('maps-upload-description').value = m?.description || '';
  // A new version of one of your uploads: pre-picked when it is the same map (map id), or the upload this folder came from.
  fillUpdateSelect(document, 'maps', 'maps', myUploads, { mapUid: m?.uid, hubId: m?.hub, name: m?.name }, escapeHtml);
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
    // No screenshots picked: the map's drawn view goes up as its picture.
    let gallery = chosenGalleryPaths;
    if (!gallery.length) {
      const { mapViewFile } = await import('./mapthumb.js');
      const view = await mapViewFile(id).catch(() => null);
      if (view) gallery = [view];
    }
    await invoke('submit_installed_map_cmd', {
      token: getToken(),
      id,
      displayName: name,
      author: getUsername(),
      description,
      galleryPaths: gallery,
      updates: chosenUpdate(document, 'maps'),
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
  installedCache = (await invoke('list_maps')).filter((m) => !isTestMap(m));
  // A fresh list: a map whose view failed to draw is tried again (the failure was about the session).
  const { clearFailed } = await import('./mapthumb.js');
  clearFailed();
  render();
  syncHubNames();
  loadThumbs();
}

// Maps with no uploaded picture get their drawn view: the kept one while the map is unchanged, else drawn here (one at a time, in the background) and kept in the app's data folder.
let viewing = null;
async function loadThumbs() {
  if (viewing) { viewing.again = true; return; }
  const run = viewing = { again: false };
  try {
    do {
      run.again = false;
      const { mapThumbFor } = await import('./mapthumb.js');
      // Installed maps first (what the user sees), then the Browse maps they haven't installed.
      const todo = [];
      for (const m of installedCache) {
        const entry = catalog.find((c) => c.id === m.id || c.id === m.hub);
        todo.push({ key: m.id, id: m.id, stamp: entry && entry.id === m.id ? entry.stamp : undefined, uploaded: entry?.image });
      }
      for (const entry of catalog) if (!todo.some((t) => t.key === entry.id)) todo.push({ key: entry.id, id: entry.id, stamp: entry.stamp, uploaded: entry.image });
      for (const t of todo) {
        // Drawing a view is heavy: only while the Maps page is on show and the window is live, and only for the tab being looked at.
        // What is left is picked up by the next onShow / tab switch.
        if (!document.getElementById('view-maps')?.classList.contains('v-on') || !isActive()) break;
        if (!(currentSubtab === 'installed' ? installedCache.some((m) => m.id === t.key) : catalog.some((c) => c.id === t.key))) continue;
        if (!needsView(t.uploaded, thumbs.get(t.key))) continue;
        const img = await mapThumbFor(t.id, { stamp: t.stamp }).catch(() => null);
        if (img) { thumbs.set(t.key, img); render(); }
        // It could not be drawn: the card says so (and offers another try) instead of showing nothing.
        else if (viewFailed(t.id)) render();
        await sleep(50);
      }
    } while (run.again);
  } finally { viewing = null; }
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
  loadThumbs();
  // Installed maps the Hub has a newer revision of are updated in place (not awaited: the tab is already usable).
  if (!catalogError) checkTab('maps', installedCache, catalog, refresh).catch(() => {});
}

// Back from a minimised window: carry on drawing what was left.
onActivity((on) => { if (on) loadThumbs(); });
