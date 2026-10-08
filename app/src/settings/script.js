import {
  PRESETS, ATTRS, getColors, applyColors, applyPreset,
  getBgTexture, applyBgTexture, getCustomCss, applyCustomCss,
  getWaveSettings, saveWaveSettings,
} from '/theme.js';
import { startWaveform } from '/home.js';
import { confirmDestructive } from '/ui.js';
import { renderInstallList } from '/install-list.js';
import { loadChangelog } from '/whatsnew.js';

function renderAppearance() {
  const presetsEl = document.getElementById('theme-presets');
  const colorsEl = document.getElementById('theme-colors');
  if (!presetsEl || !colorsEl) return;
  const current = getColors();

  presetsEl.innerHTML = PRESETS.map((p) => {
    const swatch = [p.bg, p.panel, p.accent, p.accent2].map((c) => `<span style="background:${c}"></span>`).join('');
    return `<button class="preset-option" data-preset-id="${p.id}">
      <div class="theme-swatch">${swatch}</div>
      ${p.name}
    </button>`;
  }).join('');
  presetsEl.querySelectorAll('.preset-option').forEach((btn) => {
    btn.onclick = () => {
      applyPreset(btn.dataset.presetId);
      renderAppearance();
    };
  });

  colorsEl.innerHTML = ATTRS.map(
    (a) => `<label class="color-field">
      <input type="color" data-attr="${a.key}" value="${current[a.key]}" />
      ${a.label}
    </label>`
  ).join('');
  colorsEl.querySelectorAll('input[type=color]').forEach((input) => {
    input.oninput = () => {
      const colors = { ...getColors(), [input.dataset.attr]: input.value };
      applyColors(colors);
    };
  });
}

function readFileAs(file, method) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader[method](file);
  });
}

function renderTexturePreview() {
  const removeBtn = document.getElementById('texture-remove-btn');
  removeBtn.hidden = !getBgTexture();
}

function initTexture() {
  const input = document.getElementById('texture-input');
  const removeBtn = document.getElementById('texture-remove-btn');
  const errorEl = document.getElementById('texture-error');

  renderTexturePreview();

  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    errorEl.hidden = true;
    try {
      const dataUrl = await readFileAs(file, 'readAsDataURL');
      applyBgTexture(dataUrl);
      renderTexturePreview();
    } catch (err) {
      errorEl.textContent = 'Could not use that image: ' + (err?.message || err);
      errorEl.hidden = false;
    }
  };

  removeBtn.onclick = () => {
    applyBgTexture('');
    renderTexturePreview();
  };
}

function initCustomCss() {
  const textarea = document.getElementById('custom-css-textarea');
  const fileInput = document.getElementById('css-file-input');
  const clearBtn = document.getElementById('css-clear-btn');
  const errorEl = document.getElementById('css-error');

  textarea.value = getCustomCss();

  const apply = () => {
    errorEl.hidden = true;
    try {
      applyCustomCss(textarea.value);
    } catch (err) {
      errorEl.textContent = 'Could not save custom CSS: ' + (err?.message || err);
      errorEl.hidden = false;
    }
  };

  textarea.oninput = apply;

  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      textarea.value = await readFileAs(file, 'readAsText');
      apply();
    } catch (err) {
      errorEl.textContent = 'Could not read that file: ' + (err?.message || err);
      errorEl.hidden = false;
    }
  };

  clearBtn.onclick = () => {
    textarea.value = '';
    apply();
  };
}

function initWaveform() {
  const enabledEl = document.getElementById('wave-enabled');
  const speedEl = document.getElementById('wave-speed');
  const amplitudeEl = document.getElementById('wave-amplitude');
  const densityEl = document.getElementById('wave-density');
  const slidersEl = document.getElementById('wave-sliders');

  const settings = getWaveSettings();
  enabledEl.checked = settings.enabled;
  speedEl.value = settings.speed;
  amplitudeEl.value = settings.amplitude;
  densityEl.value = settings.density;
  slidersEl.style.opacity = settings.enabled ? '1' : '0.4';

  // Dragging a slider fires 'input' continuously; rebuilding the whole
  // waveform on every tick is needless work mid-drag, so debounce it.
  let applyTimer = null;
  function apply() {
    const next = {
      enabled: enabledEl.checked,
      speed: Number(speedEl.value),
      amplitude: Number(amplitudeEl.value),
      density: Number(densityEl.value),
    };
    saveWaveSettings(next);
    slidersEl.style.opacity = next.enabled ? '1' : '0.4';
    clearTimeout(applyTimer);
    applyTimer = setTimeout(startWaveform, 100);
  }

  enabledEl.oninput = apply;
  speedEl.oninput = apply;
  amplitudeEl.oninput = apply;
  densityEl.oninput = apply;
}

window.__settingsBrowse = async function () {
  try {
    const { invoke } = window.__TAURI__.core;
    const { open } = window.__TAURI__.dialog;
    const currentPath = document.getElementById('settings-game-path').value || undefined;
    const chosen = await open({
      directory: true,
      multiple: false,
      title: 'Select the IGTAP install folder',
      defaultPath: currentPath,
    });
    if (!chosen) return; // user cancelled
    await invoke('set_game_path', { path: chosen });
    await refreshStatus();
  } catch (err) {
    alert(String(err));
  }
};

window.__settingsAutoDetect = async function () {
  const { invoke } = window.__TAURI__.core;
  const btn = document.getElementById('settings-autodetect-btn');
  btn.disabled = true;
  try {
    await invoke('auto_detect_game_path');
    await refreshStatus();
  } catch (err) {
    alert(String(err));
  } finally {
    btn.disabled = false;
  }
};

function setProgress(text) {
  const track = document.getElementById('loader-progress-track');
  const fill = document.getElementById('loader-progress-fill');
  const progress = document.getElementById('loader-progress');
  progress.textContent = text;
  track.hidden = false;
  const match = text.match(/^(\d+)\/(\d+):/);
  if (match) {
    fill.style.width = (parseInt(match[1], 10) / parseInt(match[2], 10)) * 100 + '%';
  } else if (text === 'Done.') {
    fill.style.width = '100%';
  }
}

window.__loaderInstall = async function () {
  const { invoke } = window.__TAURI__.core;
  const btn = document.getElementById('loader-install-btn');
  const track = document.getElementById('loader-progress-track');
  const fill = document.getElementById('loader-progress-fill');
  btn.disabled = true;
  fill.style.width = '0%';
  track.hidden = false;
  try {
    await invoke('install_or_update_loader');
    setProgress('Done.');
  } catch (err) {
    track.hidden = true;
    document.getElementById('loader-progress').textContent = String(err);
  } finally {
    btn.disabled = false;
    refreshStatus();
  }
};

window.__loaderUninstall = async function () {
  const { invoke } = window.__TAURI__.core;
  const ok = await confirmDestructive({
    title: 'Uninstall Recharge',
    body: 'RechargeLoader and every deployed mod will be removed, and the original game assembly restored. Type UNINSTALL to go ahead.',
    confirmLabel: 'Uninstall',
    name: 'UNINSTALL',
  });
  if (!ok) return;
  const btn = document.getElementById('loader-uninstall-btn');
  btn.disabled = true;
  try {
    await invoke('uninstall_loader');
  } catch (err) {
    alert(String(err));
  } finally {
    btn.disabled = false;
    refreshStatus();
  }
};

async function refreshInstallList() {
  await renderInstallList(document.getElementById('settings-install-list'), {
    onSelectError: (err) => alert(String(err)),
  });
}

async function refreshStatus() {
  const { invoke } = window.__TAURI__.core;
  const status = document.getElementById('loader-status');
  const pathInput = document.getElementById('settings-game-path');
  try {
    const path = await invoke('get_game_path');
    if (path) pathInput.value = path;
    const loader = await invoke('loader_status');
    status.textContent = loader.installed ? `Installed (v${loader.version})` : 'Not installed';
    document.getElementById('loader-uninstall-btn').hidden = !loader.installed;
  } catch (err) {
    status.textContent = String(err);
  }
  refreshInstallList();
}

let launcherUpdateInfo = null;

// Recharge is delivered as live code, so the number shown is the one shipped
// with the code (version.json, bumped on every push) rather than the version
// of the installed package. The beta channel adds its own build counter.
async function shownVersion(fallback) {
  const get = async (file) => {
    try {
      const res = await fetch(`/${file}?t=${Date.now()}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const base = (await get('version.json'))?.version || fallback;
  const { invoke } = window.__TAURI__.core;
  const channel = await invoke('live_get_channel').then((c) => c.channel).catch(() => 'stable');
  if (channel !== 'beta') return base;
  const beta = await get('beta.json');
  return beta?.build != null ? `${base}-beta${beta.build}` : base;
}

// Set when the Recharge launcher started us (it then owns package updates and the channel).
let launcherManaged = false;

// "Recharge 4.0.0-beta1 (Beta) - up to date" / "... - update ready: 4.0.0-beta2 - restart to apply".
// Channel comes from the launcher, not the live-code channel. The CI build counter only shows in the tooltip.
function managedVersionLine(info) {
  const channel = info.channel === 'beta' ? 'Beta' : 'Stable';
  const head = `${info.version ? `Recharge ${info.version}` : 'Recharge'} (${channel})`;
  let status;
  if (info.ready) status = `update ready${info.readyVersion ? `: ${info.readyVersion}` : ''} - restart to apply`;
  else status = 'up to date';
  const tip = [info.build ? `Build ${info.build}` : '', info.ready ? `Staged build ${info.ready}` : ''].filter(Boolean).join(' - ');
  return { text: `${head} - ${status}`, tip };
}

async function refreshManaged() {
  const { invoke } = window.__TAURI__.core;
  const box = document.getElementById('launcher-managed');
  const info = await invoke('launcher_info').catch(() => null);
  launcherManaged = !!info?.managed;
  box.hidden = !launcherManaged;
  if (!launcherManaged) return;
  document.getElementById('launcher-managed-status').textContent = 'Installed by the Recharge launcher';
  // The launcher, not the old package check, decides what "up to date" means here.
  const line = managedVersionLine(info);
  const status = document.getElementById('launcher-status');
  status.textContent = line.text;
  status.title = line.tip;
  document.getElementById('launcher-restart-btn').hidden = !info.ready;
  document.getElementById('launcher-update-btn').hidden = true;
}

// ---- uninstall ----

function manualUninstallText(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('win')) return 'This copy of Recharge was not installed by the Recharge launcher. Uninstall it from Windows Settings > Apps > Installed apps > Recharge (or the "Uninstall Recharge" shortcut in the Start menu).';
  return 'This copy of Recharge was not installed by the Recharge launcher. Remove it the way you installed it: "sudo apt remove recharge" (Debian/Ubuntu), "sudo pacman -R recharge" (Arch), or delete the AppImage / the files install.sh put in ~/.local (bin/recharge, lib/Recharge, share/applications/Recharge.desktop).';
}

function uninstallBody({ deleteData, restoreGame }) {
  return `Recharge will be removed from this computer. ${deleteData ? 'Your settings, mods, skins and map saves will be deleted too. ' : 'Your settings, mods, skins and map saves are kept. '}${restoreGame ? 'RechargeLoader will be removed and the original game restored. ' : 'RechargeLoader stays in the game. '}Type UNINSTALL to go ahead.`;
}

function refreshUninstall() {
  const managedBox = document.getElementById('uninstall-managed');
  const manual = document.getElementById('uninstall-manual');
  if (!managedBox || !manual) return;
  managedBox.hidden = !launcherManaged;
  manual.hidden = launcherManaged;
  if (!launcherManaged) manual.textContent = manualUninstallText(typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '');
}

window.__uninstallRecharge = async function () {
  const { invoke } = window.__TAURI__.core;
  const btn = document.getElementById('uninstall-btn');
  const note = document.getElementById('uninstall-note');
  // Ask twice: this click arms, the next one opens the typed confirmation.
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again to continue';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Uninstall Recharge'; }, 6000);
    return;
  }
  delete btn.dataset.armed;
  btn.textContent = 'Uninstall Recharge';
  const deleteData = !!document.getElementById('uninstall-data').checked;
  const restoreGame = !!document.getElementById('uninstall-restore').checked;
  const ok = await confirmDestructive({
    title: 'Uninstall Recharge',
    body: uninstallBody({ deleteData, restoreGame }),
    confirmLabel: 'Uninstall',
    name: 'UNINSTALL',
  });
  if (!ok) return;
  btn.disabled = true;
  note.hidden = false;
  note.textContent = 'Uninstalling - this window will close.';
  try {
    await invoke('launcher_uninstall', { deleteData, restoreGame });
  } catch (err) {
    btn.disabled = false;
    note.textContent = String(err);
  }
};

window.__launcherCheck = async function () {
  const { invoke } = window.__TAURI__.core;
  const note = document.getElementById('launcher-notes');
  note.hidden = false;
  note.textContent = 'Checking...';
  try {
    const staged = await invoke('launcher_check_now');
    refreshManaged();
    note.textContent = staged ? `Build ${staged} is ready.` : "You're up to date.";
    document.getElementById('launcher-restart-btn').hidden = !staged;
  } catch (err) {
    note.textContent = `Couldn't check: ${String(err)}`;
  }
};

window.__launcherRestart = () => window.__TAURI__.core.invoke('launcher_restart', { repair: false }).catch((e) => {
  document.getElementById('launcher-notes').textContent = String(e);
});

window.__launcherRepair = async function () {
  // window.confirm is unreliable in the webview: ask with a second click instead.
  const btn = document.getElementById('launcher-repair-btn');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again: re-check files and restart';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Repair install'; }, 6000);
    return;
  }
  await window.__TAURI__.core.invoke('launcher_restart', { repair: true }).catch((e) => {
    document.getElementById('launcher-notes').hidden = false;
    document.getElementById('launcher-notes').textContent = String(e);
  });
};

// Offered only to installs the launcher does not manage, and only when the hub has a launcher for this platform.
async function refreshMigrate() {
  const { invoke } = window.__TAURI__.core;
  const box = document.getElementById('migrate-box');
  if (!box) return;
  const info = launcherManaged ? null : await invoke('migrate_info').catch(() => null);
  box.hidden = !info?.available;
  if (!info?.available) return;
  document.getElementById('migrate-text').textContent =
    `Recharge now has its own updater (launcher ${info.launcherVersion}): faster, smaller updates and automatic rollback if something breaks. Your settings, mods and maps stay as they are.`;
  const row = document.getElementById('migrate-cleanup-row');
  row.hidden = !info.canCleanup;
  document.getElementById('migrate-cleanup').checked = false;
  if (info.hint) {
    const n = document.getElementById('migrate-text');
    n.textContent += ' ' + info.hint;
  }
}

window.__migrate = async function () {
  const { invoke } = window.__TAURI__.core;
  const btn = document.getElementById('migrate-btn');
  const progress = document.getElementById('launcher-update-progress');
  const cleanup = !document.getElementById('migrate-cleanup-row').hidden && document.getElementById('migrate-cleanup').checked;
  btn.disabled = true;
  progress.hidden = false;
  progress.textContent = 'Downloading the new Recharge and setting it up - this window will close and reopen.';
  try {
    const hint = await invoke('migrate_to_launcher', { cleanup });
    if (hint) progress.textContent = hint;
  } catch (err) {
    btn.disabled = false;
    progress.textContent = String(err);
  }
};

async function refreshLauncherStatus() {
  refreshChannel();
  await refreshManaged();
  refreshUninstall();
  refreshMigrate();
  const { invoke } = window.__TAURI__.core;
  const status = document.getElementById('launcher-status');
  const notes = document.getElementById('launcher-notes');
  const updateBtn = document.getElementById('launcher-update-btn');
  if (launcherManaged) {
    // Only the Navigator redeploy hint of the old check applies under the launcher.
    try {
      const info = await invoke('check_launcher_update');
      if (info.mapsUpdateAvailable) {
        notes.textContent = `Navigator mod needs redeploying to your game: bundled v${info.bundledMapsVersion}, game has v${info.deployedMapsVersion}.`;
        notes.hidden = false;
        updateBtn.textContent = 'Redeploy Navigator';
        updateBtn.hidden = false;
        launcherUpdateInfo = info;
      } else {
        notes.hidden = true;
        updateBtn.hidden = true;
      }
    } catch (err) { notes.hidden = true; }
    return;
  }
  try {
    const info = await invoke('check_launcher_update');
    launcherUpdateInfo = info;
    const shown = await shownVersion(info.currentVersion);
    if (info.appUpdateAvailable) {
      status.innerHTML = `v${shown} <span class="launcher-update-available">&rarr; v${info.latestVersion} available</span>`;
      updateBtn.textContent = 'Update Now';
      updateBtn.hidden = false;
      if (info.notes) {
        notes.textContent = info.notes;
        notes.hidden = false;
      } else {
        notes.hidden = true;
      }
    } else if (info.mapsUpdateAvailable) {
      status.textContent = `v${shown} (up to date)`;
      notes.textContent = `Navigator mod needs redeploying to your game: bundled v${info.bundledMapsVersion}, game has v${info.deployedMapsVersion}.`;
      notes.hidden = false;
      updateBtn.textContent = 'Redeploy Navigator';
      updateBtn.hidden = false;
    } else {
      status.textContent = `v${shown} (up to date)`;
      updateBtn.hidden = true;
      notes.hidden = true;
    }
    if (launcherManaged && !info.mapsUpdateAvailable) updateBtn.hidden = true;
    const live = await invoke('live_status').catch(() => null);
    if (live?.active && live.sha) status.append(` \u00b7 code ${live.sha.slice(0, 7)}`);
  } catch (err) {
    status.textContent = String(err);
  }
}

const CHANNEL_HELP = 'Stable gets tested changes. Beta gets the newest code first and may break.';

async function refreshChannel() {
  const { invoke } = window.__TAURI__.core;
  const note = document.getElementById('channel-note');
  try {
    const info = await invoke('live_get_channel');
    document.getElementById('channel-stable-btn').classList.toggle('btn-primary', info.channel === 'stable');
    document.getElementById('channel-beta-btn').classList.toggle('btn-primary', info.channel === 'beta');
    note.textContent = info.needsPackage
      ? 'The latest code on this channel needs a newer Recharge package - update the app above, then try again.'
      : CHANNEL_HELP;
  } catch {
    // An older build without channels - hide the row rather than show a dead control.
    document.getElementById('channel-stable-btn').closest('.settings-row').hidden = true;
    note.hidden = true;
  }
}

window.__setChannel = async function (channel) {
  const { invoke } = window.__TAURI__.core;
  const note = document.getElementById('channel-note');
  const buttons = [document.getElementById('channel-stable-btn'), document.getElementById('channel-beta-btn')];
  buttons.forEach((b) => { b.disabled = true; });
  note.textContent = 'Switching...';
  try {
    if (launcherManaged) {
      await invoke('launcher_set_channel', { channel });
      await invoke('launcher_check_now').catch(() => null);
      await refreshManaged();
    }
    const result = await invoke('live_set_channel', { channel });
    await refreshChannel();
    if (result === 'applied') note.textContent = `Switched to ${channel}. Reload to start using it.`;
    else if (result === 'upToDate') note.textContent = `You're on the latest ${channel} code.`;
  } catch (err) {
    note.textContent = `Couldn't switch: ${String(err)}`;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
};

window.__launcherUpdate = async function () {
  const { invoke } = window.__TAURI__.core;
  const btn = document.getElementById('launcher-update-btn');
  const progress = document.getElementById('launcher-update-progress');

  if (launcherUpdateInfo?.appUpdateAvailable) {
    if (!launcherUpdateInfo.downloadUrl) {
      progress.hidden = false;
      progress.innerHTML = `Can't auto-update this install - grab the new version from <a href="${launcherUpdateInfo.url}" target="_blank" rel="noopener">the release page</a> (or your package manager, if you installed via pacman/AUR).`;
      return;
    }
    btn.disabled = true;
    progress.hidden = false;
    progress.textContent = 'Starting…';
    try {
      await invoke('install_launcher_update', { url: launcherUpdateInfo.downloadUrl });
    } catch (err) {
      btn.disabled = false;
      progress.textContent = String(err);
    }
    return;
  }

  if (launcherUpdateInfo?.mapsUpdateAvailable) {
    await window.__loaderInstall();
    await refreshLauncherStatus();
  }
};

async function openWhatsNew(force) {
  const panel = document.getElementById('whatsnew-panel');
  if (!panel) return;
  if (!panel.hidden && !force) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = '<div class="empty-state">Loading...</div>';
  const { invoke } = window.__TAURI__.core;
  const info = await invoke('launcher_info').catch(() => null);
  const channel = info?.managed && info.channel ? info.channel : await invoke('live_get_channel').then((c) => c.channel).catch(() => 'stable');
  panel.innerHTML = (await loadChangelog(invoke, channel)).html;
}
window.__whatsNewToggle = () => openWhatsNew(false);

export async function init() {
  const { listen } = window.__TAURI__.event;
  window.addEventListener('open-whatsnew', () => openWhatsNew(true));
  if (window.__openWhatsNew) {
    window.__openWhatsNew = false;
    openWhatsNew(true);
  }
  listen('loader-progress', (event) => setProgress(event.payload));
  listen('launcher-update-ready', () => refreshManaged());
  listen('launcher-update-progress', (event) => {
    const progress = document.getElementById('launcher-update-progress');
    progress.hidden = false;
    progress.textContent = event.payload;
  });
  refreshStatus();
  refreshLauncherStatus();
  renderAppearance();
  initTexture();
  initWaveform();
  initCustomCss();
}
