import {
  PRESETS, ATTRS, getColors, applyColors, applyPreset,
  getBgTexture, applyBgTexture, getCustomCss, applyCustomCss,
} from '/theme.js';

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

  // Applied live as you type, not just on an explicit save - matches every
  // other Appearance control on this page (color pickers apply on input too).
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

// Not a picker - the game path is auto-detected only. This just reveals the
// current folder in the real Windows Explorer so the user can verify it.
window.__settingsBrowse = async function () {
  const { invoke } = window.__TAURI__.core;
  try {
    await invoke('open_game_folder_in_explorer');
  } catch (err) {
    alert(String(err));
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

async function refreshStatus() {
  const { invoke } = window.__TAURI__.core;
  const status = document.getElementById('loader-status');
  const pathInput = document.getElementById('settings-game-path');
  try {
    const path = await invoke('get_game_path');
    if (path) pathInput.value = path;
    const loader = await invoke('loader_status');
    status.textContent = loader.installed ? `Installed (v${loader.version})` : 'Not installed';
  } catch (err) {
    status.textContent = String(err);
  }
}

// Recharge's own version vs. the real GitHub releases feed - distinct from
// RechargeLoader above, which is the mod-framework contract mods build
// against, not the app itself.
async function refreshLauncherStatus() {
  const { invoke } = window.__TAURI__.core;
  const status = document.getElementById('launcher-status');
  const notes = document.getElementById('launcher-notes');
  try {
    const info = await invoke('check_launcher_update');
    if (info.updateAvailable) {
      status.innerHTML = `v${info.currentVersion} <span class="launcher-update-available">&rarr; v${info.latestVersion} available</span> <a href="#" id="launcher-download-link">Download</a>`;
      const link = document.getElementById('launcher-download-link');
      link.onclick = (e) => {
        e.preventDefault();
        window.__TAURI__.opener.openUrl(info.url);
      };
      if (info.notes) {
        notes.textContent = info.notes;
        notes.hidden = false;
      } else {
        notes.hidden = true;
      }
    } else {
      status.textContent = `v${info.currentVersion} (up to date)`;
      notes.hidden = true;
    }
  } catch (err) {
    status.textContent = String(err);
  }
}

export async function init() {
  const { listen } = window.__TAURI__.event;
  listen('loader-progress', (event) => setProgress(event.payload));
  refreshStatus();
  refreshLauncherStatus();
  renderAppearance();
  initTexture();
  initCustomCss();
}
