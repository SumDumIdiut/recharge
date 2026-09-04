// The catalog used to be a hardcoded local file - now it's fetched from
// Recharge Hub, so a new mod shows up here the moment it's approved there,
// with no app update needed. See app/src-tauri/src/commands/hub.rs for the
// actual download+install this tab's Install button triggers.
const HUB_BASE = 'https://codecade.co.za/recharge';

// recharge.maps is infrastructure the Map Editor/Maps tabs always need, not an
// optional feature a user picks - it stays fully installed and running, just
// never shown here so it doesn't look like a toggleable, ordinary mod.
const HIDDEN_MOD_IDS = new Set(['recharge.maps']);

let currentSubtab = 'installed';
let searchTerm = '';
let installedCache = [];
let catalog = [];
let catalogError = false;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function matchesSearch(haystack) {
  if (!searchTerm) return true;
  return haystack.toLowerCase().includes(searchTerm.toLowerCase());
}

function thumb(entry, badge) {
  const img = entry?.image
    ? `<img class="browse-card-thumb" src="${escapeHtml(entry.image)}" alt="" />`
    : `<div class="browse-card-thumb browse-card-thumb-empty"></div>`;
  return `<div class="browse-card-media">${img}${badge || ''}</div>`;
}

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h10l1-13"/></svg>';

// Numeric-segment compare ("1.10.0" > "1.9.0", unlike a plain string compare)
// - good enough for the plain "major.minor.patch" versions this project
// actually uses, not a full semver parser (no pre-release/build metadata).
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

async function loadCatalog() {
  try {
    const res = await fetch(`${HUB_BASE}/api/mods`);
    const rows = await res.json();
    catalog = rows.map((row) => ({
      id: row.id,
      modId: row.modId || null,
      name: row.name,
      author: row.author,
      version: row.version || '1.0.0',
      description: row.description,
      image: row.gallery?.length ? `${HUB_BASE}/api/mods/${row.id}/gallery/${encodeURIComponent(row.gallery[0])}` : null,
      dependencies: [],
    }));
    catalogError = false;
  } catch (err) {
    catalog = [];
    catalogError = true;
  }
}

function renderInstalled() {
  const list = document.getElementById('mods-installed-view');
  const filtered = installedCache.filter((m) => matchesSearch(m.displayName + ' ' + (m.author || '')));
  if (!filtered.length) {
    list.innerHTML = installedCache.length
      ? '<div class="empty-state">No mods match your search.</div>'
      : '<div class="empty-state">No mods installed. Browse the catalog to add one.</div>';
    return;
  }
  list.innerHTML = filtered
    .map((m) => {
      const entry = catalog.find((c) => c.modId === m.id);
      const hasUpdate = entry && isNewerVersion(entry.version, m.version);
      return `
    <div class="browse-card" onclick="window.__modOpenDetail('${escapeHtml(m.id)}')">
      ${thumb(entry, hasUpdate ? `<button class="browse-card-badge browse-card-badge-update" title="Update to v${escapeHtml(entry.version)}" onclick="event.stopPropagation(); window.__modInstall('${escapeHtml(entry.id)}', this)">${ICON_DOWNLOAD}</button>` : '')}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(m.displayName)}</div>
        <div class="browse-card-meta">${m.author ? escapeHtml(m.author) : 'unknown'} &middot; v${escapeHtml(m.version)}${hasUpdate ? ` <span class="mod-update-available">&rarr; v${escapeHtml(entry.version)} available</span>` : ''}</div>
      </div>
      <div class="browse-card-actions">
        <span class="browse-card-meta">${m.enabled ? 'Enabled' : 'Disabled'}</span>
        <div class="browse-card-actions-right">
          <div class="mod-toggle ${m.enabled ? 'on' : ''}" data-id="${escapeHtml(m.id)}" onclick="event.stopPropagation(); window.__modToggle(this)"></div>
          <button class="browse-card-icon-btn" title="Uninstall" onclick="event.stopPropagation(); window.__modConfirmUninstall('${escapeHtml(m.id)}', '${escapeHtml(m.displayName).replace(/'/g, "\\'")}')">${ICON_TRASH}</button>
        </div>
      </div>
    </div>`;
    })
    .join('');
}

function renderBrowse() {
  const list = document.getElementById('mods-browse-view');
  if (catalogError) {
    list.innerHTML = '<div class="empty-state">Couldn\'t reach the Recharge Hub library. Check your connection and reopen this tab.</div>';
    return;
  }
  const filtered = catalog.filter((m) => matchesSearch(m.name + ' ' + m.description + ' ' + m.author));
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No mods match your search.</div>';
    return;
  }
  list.innerHTML = filtered
    .map((entry) => {
      const installed = installedCache.some((m) => m.id === entry.id);
      const badge = installed
        ? `<div class="browse-card-badge browse-card-badge-installed" title="Installed">${ICON_CHECK}</div>`
        : `<button class="browse-card-badge browse-card-badge-install" title="Install" onclick="event.stopPropagation(); window.__modInstall('${escapeHtml(entry.id)}', this)">${ICON_DOWNLOAD}</button>`;
      return `
    <div class="browse-card" onclick="window.__modOpenDetail('${escapeHtml(entry.id)}')">
      ${thumb(entry, badge)}
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(entry.name)}</div>
        <div class="browse-card-meta">${escapeHtml(entry.author)} &middot; v${escapeHtml(entry.version)}</div>
      </div>
    </div>`;
    })
    .join('');
}

function render() {
  document.getElementById('mods-installed-view').style.display = currentSubtab === 'installed' ? '' : 'none';
  document.getElementById('mods-browse-view').style.display = currentSubtab === 'browse' ? '' : 'none';
  renderInstalled();
  renderBrowse();
}

window.__modsSubtab = function (tab) {
  currentSubtab = tab;
  document.querySelectorAll('#view-mods .subtab-btn').forEach((el) => el.classList.toggle('active', el.dataset.subtab === tab));
  render();
};

window.__modsSearch = function (value) {
  searchTerm = value;
  render();
};

window.__modToggle = async function (el) {
  const { invoke } = window.__TAURI__.core;
  const enabled = !el.classList.contains('on');
  await invoke('set_mod_enabled', { id: el.dataset.id, enabled });
  const mod = installedCache.find((m) => m.id === el.dataset.id);
  if (mod) mod.enabled = enabled;
  render();
  if (!document.getElementById('mods-detail-toggle')) return;
  const detailToggle = document.getElementById('mods-detail-toggle');
  if (detailToggle && detailToggle.dataset.id === el.dataset.id) {
    detailToggle.classList.toggle('on', enabled);
  }
};

// Walks entry.dependencies transitively (a required mod can itself require
// another), splitting into: alreadyInstalled (nothing to do), missing (in
// the catalog, not installed - offer to install alongside), and unavailable
// (required but not in the catalog at all - this mod genuinely can't work,
// matching the loader's own real "requires X, which is not installed"
// runtime check in RechargeLoaderBootstrap - this is the same rule, just
// caught before install instead of discovered later in Player.log).
function resolveMissingDependencies(entry) {
  const missing = [];
  const unavailable = [];
  const seen = new Set([entry.id]);
  const queue = [...(entry.dependencies || [])];

  while (queue.length) {
    const depId = queue.shift();
    if (seen.has(depId)) continue;
    seen.add(depId);

    if (installedCache.some((m) => m.id === depId)) continue;

    const depEntry = catalog.find((c) => c.id === depId);
    if (!depEntry) {
      unavailable.push(depId);
      continue;
    }
    missing.push(depEntry);
    queue.push(...(depEntry.dependencies || []));
  }
  return { missing, unavailable };
}

function closeDepModal() {
  document.getElementById('mods-dep-overlay').hidden = true;
}

window.__modInstall = async function (id, btn) {
  const entry = catalog.find((c) => c.id === id);
  const { missing, unavailable } = resolveMissingDependencies(entry);

  if (unavailable.length) {
    document.getElementById('mods-dep-title').textContent = "Can't Install";
    document.getElementById('mods-dep-body').innerHTML =
      `<p><b>${escapeHtml(entry.name)}</b> requires the following, which ${unavailable.length === 1 ? "isn't" : "aren't"} available in the catalog:</p>` +
      `<ul class="mods-dep-list">${unavailable.map((depId) => `<li class="mods-dep-unavailable">${escapeHtml(depId)}</li>`).join('')}</ul>`;
    document.getElementById('mods-dep-confirm').style.display = 'none';
    document.getElementById('mods-dep-cancel').textContent = 'Close';
    document.getElementById('mods-dep-overlay').hidden = false;
    return;
  }

  if (missing.length) {
    document.getElementById('mods-dep-title').textContent = 'Additional Mods Required';
    document.getElementById('mods-dep-body').innerHTML =
      `<p><b>${escapeHtml(entry.name)}</b> requires the following mod${missing.length === 1 ? '' : 's'}, which ${missing.length === 1 ? "isn't" : "aren't"} installed yet:</p>` +
      `<ul class="mods-dep-list">${missing.map((m) => `<li>${escapeHtml(m.name)}</li>`).join('')}</ul>` +
      `<p>Install ${missing.length === 1 ? 'it' : 'them'} along with <b>${escapeHtml(entry.name)}</b>?</p>`;
    document.getElementById('mods-dep-confirm').style.display = '';
    document.getElementById('mods-dep-cancel').textContent = 'Cancel';
    document.getElementById('mods-dep-overlay').hidden = false;

    document.getElementById('mods-dep-confirm').onclick = () => {
      closeDepModal();
      doInstall([...missing.map((m) => m.id), id], btn);
    };
    return;
  }

  doInstall([id], btn);
};

async function doInstall(ids, btn) {
  const { invoke } = window.__TAURI__.core;
  if (btn) {
    btn.disabled = true;
    btn.textContent = ids.length > 1 ? `Installing (${ids.length})…` : 'Installing…';
  }
  try {
    // Each id is downloaded and dropped into place individually - a real
    // per-mod install (not a full local rebuild), so this works without the
    // mod's source ever being bundled with the app.
    for (const id of ids) {
      await invoke('install_from_hub_cmd', { kind: 'mods', id });
    }
    await refresh();
    const openId = ids[ids.length - 1];
    if (document.getElementById('mods-detail').style.display !== 'none') window.__modOpenDetail(openId);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
    alert(String(err));
  }
}

window.__modOpenDetail = function (id) {
  // "id" may be a hub catalog id (opened from Browse) or a real installed
  // mod id (opened from Installed) - those are different id spaces now that
  // a hub submission carries its own arbitrary UUID separate from the mod's
  // own mod.json id (see loadCatalog's "modId").
  let entry = catalog.find((c) => c.id === id);
  let installedMod = installedCache.find((m) => m.id === id);
  if (!entry && installedMod) entry = catalog.find((c) => c.modId === installedMod.id);
  if (!installedMod && entry?.modId) installedMod = installedCache.find((m) => m.id === entry.modId);
  // A mod can be installed without being in the catalog at all (built and
  // dropped in locally, ahead of ever being published) - fall back to
  // whatever the real manifest itself has rather than refusing to show
  // anything, so it's still reachable to disable/uninstall.
  if (!entry && !installedMod) return;
  const installed = !!installedMod;
  const hubId = entry?.id;
  const realId = installedMod?.id;
  const name = entry ? entry.name : installedMod.displayName;
  const author = entry ? entry.author : installedMod.author;
  const version = entry ? entry.version : installedMod.version;
  const deps = installedMod?.dependencies?.length ? installedMod.dependencies : entry?.dependencies;

  document.getElementById('mods-detail').innerHTML = `
    <button class="crumb-back" id="mods-detail-back" onclick="window.__modCloseDetail()" style="margin-bottom:20px;">&lt; Mods</button>
    ${entry?.image ? `<img class="mod-detail-image" src="${escapeHtml(entry.image)}" alt="" />` : ''}
    <div class="mod-detail-header">
      <div class="mod-detail-name">${escapeHtml(name)}</div>
      <div class="mod-detail-meta">${author ? escapeHtml(author) + ' \u00b7 ' : ''}v${escapeHtml(version)}</div>
    </div>
    ${entry?.description ? `<div class="mod-detail-desc">${escapeHtml(entry.description)}</div>` : ''}
    ${deps?.length ? `<div class="mod-detail-deps">Requires: ${deps.map(escapeHtml).join(', ')}</div>` : ''}
    <div class="mod-detail-actions">
      ${
        installed
          ? `<div class="settings-row">
               <span class="browse-card-meta">${installedMod.enabled ? 'Enabled' : 'Disabled'}</span>
               <div class="mod-toggle ${installedMod.enabled ? 'on' : ''}" id="mods-detail-toggle" data-id="${escapeHtml(realId)}" onclick="window.__modToggle(this)"></div>
             </div>
             <button class="btn mod-detail-uninstall" onclick="window.__modConfirmUninstall('${escapeHtml(realId)}', '${escapeHtml(name).replace(/'/g, "\\'")}')">Uninstall</button>`
          : entry
            ? `<button class="btn btn-primary" onclick="window.__modInstall('${escapeHtml(hubId)}', this)">Install</button>`
            : ''
      }
    </div>
  `;

  document.getElementById('mods-list').style.display = 'none';
  document.getElementById('mods-detail').style.display = 'block';
};

window.__modConfirmUninstall = function (id, name) {
  document.getElementById('mods-dep-title').textContent = 'Uninstall Mod?';
  document.getElementById('mods-dep-body').innerHTML =
    `<p>Remove <b>${escapeHtml(name)}</b> and its data? This can't be undone from here - you'd need to reinstall it.</p>`;
  const confirmBtn = document.getElementById('mods-dep-confirm');
  confirmBtn.style.display = '';
  confirmBtn.textContent = 'Uninstall';
  document.getElementById('mods-dep-cancel').textContent = 'Cancel';
  document.getElementById('mods-dep-overlay').hidden = false;

  confirmBtn.onclick = async () => {
    closeDepModal();
    confirmBtn.textContent = 'Install All'; // restore for the next (unrelated) use of this shared modal
    const { invoke } = window.__TAURI__.core;
    try {
      await invoke('uninstall_mod', { id });
      await refresh();
      window.__modCloseDetail();
    } catch (err) {
      alert(String(err));
    }
  };
};

window.__modCloseDetail = function () {
  document.getElementById('mods-detail').style.display = 'none';
  document.getElementById('mods-list').style.display = 'block';
};

async function refresh() {
  const { invoke } = window.__TAURI__.core;
  const all = await invoke('list_installed_mods');
  installedCache = all.filter((m) => !HIDDEN_MOD_IDS.has(m.id));
  render();
}

export async function init() {
  document.getElementById('mods-dep-cancel').addEventListener('click', closeDepModal);
  render();
  await Promise.all([loadCatalog(), refresh()]);
  render();
}
