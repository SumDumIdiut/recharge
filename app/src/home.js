import { getWaveSettings } from '/theme.js';
import { renderInstallList } from '/install-list.js';

let pollHandle = null;
let lastLaunchMode = null;
const LAUNCH_GRACE_MS = { direct: 5000, steam: 60000 };
let launchGraceMs = LAUNCH_GRACE_MS.direct;
let seenRunning = false;
let launchStartedAt = 0;

const BEAT_SHAPES = ['single', 'double', 'sharp'];

let waveGeneration = 0;

function shapePoints(shape, x0, width, height, baseY) {
  const h = height;
  const rel =
    shape === 'single'
      ? [
          [0, 0], [0.55, 0], [0.6, -0.35], [0.65, 0.65], [0.7, 0], [1, 0],
        ]
      : shape === 'double'
      ? [
          [0, 0], [0.3, 0], [0.35, -0.3], [0.4, 0.65], [0.45, 0],
          [0.55, 0], [0.6, -0.25], [0.65, 0.6], [0.7, 0], [1, 0],
        ]
      : [
          [0, 0], [0.15, 0], [0.18, -0.7], [0.22, 0.45], [0.26, 0], [1, 0],
        ];
  return rel.map(([fx, fy]) => [x0 + fx * width, baseY + fy * h]);
}

function peakFraction(shape) {
  return shape === 'sharp' ? 0.2 : shape === 'double' ? 0.62 : 0.65;
}

function buildWaveform(minTotalWidth, amplitude, density) {
  const units = [];
  let x = 0;
  while (x < minTotalWidth) {
    const width = density * (0.75 + Math.random() * 0.5);
    const height = amplitude * (0.6 + Math.random() * 0.8);
    const shape = BEAT_SHAPES[Math.floor(Math.random() * BEAT_SHAPES.length)];
    units.push({ x0: x, width, height, shape, peakX: x + width * peakFraction(shape) });
    x += width;
  }
  return { units, totalWidth: x };
}

export function startWaveform() {
  const svg = document.querySelector('.wave-trace');
  const polyline = svg?.querySelector('polyline');
  const banner = document.getElementById('wave-banner');
  if (!svg || !polyline || !banner) return;

  const myGeneration = ++waveGeneration;
  const settings = getWaveSettings();
  banner.style.display = settings.enabled ? '' : 'none';
  if (!settings.enabled) return;

  const containerWidth = banner.clientWidth || 900;
  const { units, totalWidth } = buildWaveform(Math.max(containerWidth * 3, 6000), settings.amplitude, settings.density);

  const maxPeakDeviation = settings.amplitude * 1.4 * 0.7;
  const svgHeight = Math.max(44, Math.ceil(maxPeakDeviation * 2 + 8));
  const baseY = svgHeight / 2;
  banner.style.height = svgHeight + 'px';

  const allPoints = [];
  for (const u of units) allPoints.push(...shapePoints(u.shape, u.x0, u.width, u.height, baseY));
  for (const u of units) allPoints.push(...shapePoints(u.shape, u.x0 + totalWidth, u.width, u.height, baseY));

  svg.setAttribute('width', String(totalWidth * 2));
  svg.setAttribute('height', String(svgHeight));
  svg.setAttribute('viewBox', `0 0 ${totalWidth * 2} ${svgHeight}`);
  polyline.setAttribute('points', allPoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));

  const lastScreenX = new Map(units.map((u) => [u, null]));
  const start = performance.now();

  function frame(now) {
    if (myGeneration !== waveGeneration) return; // a newer startWaveform() call superseded this loop
    const elapsed = (now - start) / 1000;
    const offset = (elapsed * settings.speed) % totalWidth;
    polyline.style.transform = `translateX(${-offset}px)`;

    const tx = (banner.clientWidth || containerWidth) - 30;
    for (const u of units) {
      const screenX = u.peakX - offset;
      const prev = lastScreenX.get(u);
      if (prev != null && prev - screenX < 20 && prev > tx && screenX <= tx) {
        polyline.classList.remove('beat-single', 'beat-double', 'beat-sharp');
        void polyline.offsetWidth;
        polyline.classList.add('beat-' + u.shape);
      }
      lastScreenX.set(u, screenX);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function logLine(html) {
  const log = document.getElementById('home-log');
  if (!log) return;
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement('div');
  line.className = 'home-log-line';
  line.innerHTML = `<span class="home-log-ts">${ts}</span>${html}`;
  log.prepend(line);
}

function setPlayStatus(status) {
  document.querySelectorAll('.home-tile').forEach((el) => (el.disabled = status != null));
  document.getElementById('home-play-status').textContent =
    status === 'launching' ? 'Launching…' : status === 'running' ? 'Running' : '';
}

async function pollRunning() {
  const { invoke } = window.__TAURI__.core;
  const running = await invoke('is_game_running');
  if (running) {
    seenRunning = true;
    setPlayStatus('running');
    return;
  }
  if (!seenRunning && Date.now() - launchStartedAt < launchGraceMs) {
    return;
  }
  clearInterval(pollHandle);
  pollHandle = null;
  setPlayStatus(null);
  logLine(seenRunning ? 'game process exited' : "game never started (Steam didn't launch it in time)");
  if (lastLaunchMode === 'modded') {
    lastLaunchMode = null;
    try {
      await invoke('restore_vanilla_build');
      logLine('switched back to <b>vanilla</b>');
    } catch (err) {
      logLine(`couldn't switch back to vanilla: ${String(err)}`);
    }
  }
}

window.__homeLaunch = async function (mode) {
  const { invoke } = window.__TAURI__.core;
  setPlayStatus('launching');
  logLine(`launching <b>${mode.toUpperCase()}</b>…`);
  try {
    const via = await invoke('launch_game', { modded: mode === 'modded' });
    lastLaunchMode = mode;
    launchGraceMs = LAUNCH_GRACE_MS[via] ?? LAUNCH_GRACE_MS.steam;
    seenRunning = false;
    launchStartedAt = Date.now();
    logLine(`process started (${mode})`);
    setPlayStatus('running');
    if (!pollHandle) pollHandle = setInterval(pollRunning, 2000);
  } catch (err) {
    document.getElementById('home-play-status').textContent = String(err);
    logLine(`launch failed: ${String(err)}`);
    setPlayStatus(null);
  }
};

export async function refreshInstallStatus(opts = {}) {
  return renderInstallList(document.getElementById('home-install-list'), {
    emptyHtml: `<div class="home-install-label">IGTAP not found</div><div class="home-install-sub">Set the path in Settings.</div>`,
    onError: (err) => { if (opts.log !== false) logLine(`install detection failed: ${String(err)}`); },
    onEmpty: () => { if (opts.log !== false) logLine('no installation detected'); },
    onSelect: (install) => logLine(`switched active install to <b>IGTAP (${install.variant})</b>`),
    onSelectError: (err) => logLine(`couldn't switch install: ${String(err)}`),
    onRendered: (installs, active) => {
      if (opts.log === false) return;
      logLine(active
        ? `installation detected: <b>IGTAP (${active.variant})</b>`
        : `${installs.length} install${installs.length === 1 ? '' : 's'} found`);
    },
  });
}

async function maybePromptInstallChoice() {
  const { invoke } = window.__TAURI__.core;
  const saved = await invoke('get_saved_game_path').catch(() => null);
  if (saved) return;

  const installs = await invoke('detect_all_igtap_installs').catch(() => []);
  if (installs.length < 2) return;

  const overlay = document.getElementById('install-picker-overlay');
  const list = document.getElementById('install-picker-list');
  if (!overlay || !list) return;

  await new Promise((resolve) => {
    list.innerHTML = '';
    for (const install of installs) {
      const row = document.createElement('button');
      row.className = 'install-picker-row';
      row.innerHTML = `<div class="install-picker-variant">IGTAP (${install.variant})</div><div class="install-picker-path">${escapeForHtml(install.path)}</div>`;
      row.onclick = async () => {
        try {
          await invoke('set_game_path', { path: install.path });
        } finally {
          overlay.hidden = true;
          resolve();
        }
      };
      list.appendChild(row);
    }
    overlay.hidden = false;
  });
}

function showOnboarding(html) {
  const overlay = document.getElementById('onboard-overlay');
  const body = document.getElementById('onboard-body');
  if (!overlay || !body) return;
  body.innerHTML = html;
  overlay.hidden = false;
  document.getElementById('onboard-dismiss').onclick = () => { overlay.hidden = true; };
  document.getElementById('onboard-go').onclick = () => {
    overlay.hidden = true;
    window.navigate('settings');
  };
}

async function checkForLauncherUpdate() {
  const { invoke } = window.__TAURI__.core;
  const { event } = window.__TAURI__;
  let info;
  try {
    info = await invoke('check_launcher_update');
  } catch {
    return; // offline, or GitHub unreachable - just try again next launch
  }
  if (!info.updateAvailable) return;

  const overlay = document.getElementById('update-overlay');
  const body = document.getElementById('update-body');
  const progress = document.getElementById('update-progress');
  const laterBtn = document.getElementById('update-later');
  const nowBtn = document.getElementById('update-now');
  progress.hidden = true;
  nowBtn.disabled = false;
  laterBtn.disabled = false;
  overlay.hidden = false;

  if (info.appUpdateAvailable) {
    logLine(`update available: <b>v${info.latestVersion}</b>`);
    body.innerHTML = `<p>Recharge <b>v${info.latestVersion}</b> is available (you're on v${info.currentVersion}).</p>${info.notes ? `<p>${escapeForHtml(info.notes)}</p>` : ''}`;
    nowBtn.textContent = 'Update Now';

    event.listen('launcher-update-progress', (e) => {
      progress.hidden = false;
      progress.textContent = e.payload;
    });

    laterBtn.onclick = () => { overlay.hidden = true; };
    nowBtn.onclick = async () => {
      if (!info.downloadUrl) {
        progress.hidden = false;
        progress.textContent = "This release has no installer attached - can't update in-app.";
        return;
      }
      nowBtn.disabled = true;
      laterBtn.disabled = true;
      progress.hidden = false;
      progress.textContent = 'Starting…';
      try {
        await invoke('install_launcher_update', { url: info.downloadUrl });
      } catch (err) {
        nowBtn.disabled = false;
        laterBtn.disabled = false;
        progress.textContent = String(err);
      }
    };
  } else if (info.mapsUpdateAvailable) {
    logLine(`Maps mod update available: <b>v${info.bundledMapsVersion}</b> (game has v${info.deployedMapsVersion})`);
    body.innerHTML = `<p>The Maps mod needs redeploying to your game: bundled <b>v${info.bundledMapsVersion}</b>, game currently has <b>v${info.deployedMapsVersion}</b>.</p>`;
    nowBtn.textContent = 'Redeploy Now';

    event.listen('loader-progress', (e) => {
      progress.hidden = false;
      progress.textContent = e.payload;
    });

    laterBtn.onclick = () => { overlay.hidden = true; };
    nowBtn.onclick = async () => {
      nowBtn.disabled = true;
      laterBtn.disabled = true;
      progress.hidden = false;
      progress.textContent = 'Starting…';
      try {
        await invoke('install_or_update_loader');
        progress.textContent = 'Done.';
      } catch (err) {
        progress.textContent = String(err);
      } finally {
        nowBtn.disabled = false;
        laterBtn.disabled = false;
        overlay.hidden = true;
      }
    };
  }
}

function escapeForHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function initHome() {
  const { invoke } = window.__TAURI__.core;

  logLine('recharge started');

  await maybePromptInstallChoice();
  const install = await refreshInstallStatus();

  let loaderInstalled = false;
  try {
    const loader = await invoke('loader_status');
    loaderInstalled = loader.installed;
    logLine(loader.installed ? `loader: <b>installed</b> (v${loader.version})` : 'loader: not installed');
  } catch (err) {
    logLine(`loader status check failed: ${String(err)}`);
  }

  if (!install) {
    showOnboarding(
      `<p>Recharge couldn't find your IGTAP install automatically.</p>
       <p>Head to Settings to check the detected path, or verify IGTAP is installed via Steam.</p>`
    );
  } else if (!loaderInstalled) {
    showOnboarding(
      `<p>Almost there - <b>RechargeLoader</b> isn't installed yet, and it's what lets mods actually run in-game.</p>
       <p>Go to Settings and click <b>Install / Update</b> under RechargeLoader to finish setup.</p>`
    );
  } else {
    checkForLauncherUpdate();
  }

  try {
    const mods = await invoke('list_installed_mods');
    const enabled = mods.filter((m) => m.enabled).length;
    logLine(`${mods.length} mod${mods.length === 1 ? '' : 's'} found, ${enabled} enabled`);
  } catch (err) {
    logLine(`mod scan failed: ${String(err)}`);
  }

  if (await invoke('is_game_running')) {
    seenRunning = true;
    setPlayStatus('running');
    pollHandle = setInterval(pollRunning, 2000);
    logLine('game process already running');
  } else {
    logLine('no active game process');
    try {
      await invoke('restore_vanilla_build');
    } catch { /* no install detected yet, or nothing to restore - fine */ }
  }

  startWaveform();
}
