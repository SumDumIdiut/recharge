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

// Recharge's own version vs. a small local "latest" manifest (content/launcher.json) -
// distinct from RechargeLoader above, which is the mod-framework contract mods
// build against, not the app itself. There's no hosted release feed for this
// project, so this only ever flags an update once someone (the developer)
// bumps that manifest by hand for a real new build - same honest, no-fake-
// server spirit as how mod "installs" are really just a local rebuild.
async function refreshLauncherStatus() {
  const { invoke } = window.__TAURI__.core;
  const status = document.getElementById('launcher-status');
  const notes = document.getElementById('launcher-notes');
  try {
    const info = await invoke('check_launcher_update');
    if (info.updateAvailable) {
      status.innerHTML = `v${info.currentVersion} <span class="launcher-update-available">&rarr; v${info.latestVersion} available</span>`;
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
}
