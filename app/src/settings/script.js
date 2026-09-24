import {
  PRESETS, ATTRS, getColors, applyColors, applyPreset,
  getBgTexture, applyBgTexture, getCustomCss, applyCustomCss,
  getWaveSettings, saveWaveSettings,
} from '/theme.js';
import { startWaveform } from '/home.js';
import { renderInstallList } from '/install-list.js';

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

  function apply() {
    const next = {
      enabled: enabledEl.checked,
      speed: Number(speedEl.value),
      amplitude: Number(amplitudeEl.value),
      density: Number(densityEl.value),
    };
    saveWaveSettings(next);
    slidersEl.style.opacity = next.enabled ? '1' : '0.4';
    startWaveform();
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
  if (!confirm('Remove RechargeLoader and all deployed mods, and restore the original game assembly?')) return;
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

async function refreshLauncherStatus() {
  const { invoke } = window.__TAURI__.core;
  const status = document.getElementById('launcher-status');
  const notes = document.getElementById('launcher-notes');
  const updateBtn = document.getElementById('launcher-update-btn');
  try {
    const info = await invoke('check_launcher_update');
    launcherUpdateInfo = info;
    if (info.appUpdateAvailable) {
      status.innerHTML = `v${info.currentVersion} <span class="launcher-update-available">&rarr; v${info.latestVersion} available</span>`;
      updateBtn.textContent = 'Update Now';
      updateBtn.hidden = false;
      if (info.notes) {
        notes.textContent = info.notes;
        notes.hidden = false;
      } else {
        notes.hidden = true;
      }
    } else if (info.mapsUpdateAvailable) {
      status.textContent = `v${info.currentVersion} (up to date)`;
      notes.textContent = `Navigator mod needs redeploying to your game: bundled v${info.bundledMapsVersion}, game has v${info.deployedMapsVersion}.`;
      notes.hidden = false;
      updateBtn.textContent = 'Redeploy Navigator';
      updateBtn.hidden = false;
    } else {
      status.textContent = `v${info.currentVersion} (up to date)`;
      updateBtn.hidden = true;
      notes.hidden = true;
    }
    const live = await invoke('live_status').catch(() => null);
    if (live?.active && live.sha) status.append(` \u00b7 code ${live.sha.slice(0, 7)}`);
  } catch (err) {
    status.textContent = String(err);
  }
}

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

export async function init() {
  const { listen } = window.__TAURI__.event;
  listen('loader-progress', (event) => setProgress(event.payload));
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
