import { initHomeNews, layoutNews } from '/home-news.js';
import { getWaveSettings, applyRandomBackground } from '/theme.js';
import { renderInstallList } from '/install-list.js';
import { isLoggedIn, getUsername, isAdmin, setSession, refreshSession, sessionExpired, clearExpiredNote, EXPIRED_MESSAGE, getNameColor } from '/auth.js';
import { nameStyle } from '/social/avatar.js';
import { escapeHtml } from '/ui.js';
import { isActive, onActivity } from '/activity.js';
import { nextBeat, BEAT_ANIMATIONS } from '/wave-beat.js';

import { HUB_BASE } from './hub.js';
let loginMode = 'login';

let pollHandle = null; // grace-period timer: re-checks once when the launch grace ends (the Rust poller pushes `game-running` events on changes)
let watchingGame = false;
// is_game_running answers 'running' | 'not-running' | 'unknown' (older builds: a boolean).
const isRunningState = (v) => v === true || v === 'running';
let lastLaunchMode = null;

// Settings > RechargeLoader "Keep the game modded after closing" (default on): skip the automatic switch back to vanilla.
function keepGameModded() {
  try { return localStorage.getItem('keep-game-modded') !== '0'; } catch { return true; }
}
const LAUNCH_GRACE_MS = { direct: 5000, steam: 60000 };
let launchGraceMs = LAUNCH_GRACE_MS.direct;
let seenRunning = false;
let launchStartedAt = 0;

const BEAT_SHAPES = ['single', 'double', 'sharp'];

let waveGeneration = 0;
let waveTeardown = () => {};

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

  waveTeardown();
  waveTeardown = () => {};
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

  // The scroll is one linear Web Animation (no script per frame); beats are timed from its clock, so a hidden Home costs nothing.
  const speed = settings.speed;
  const scroll = polyline.animate(
    [{ transform: 'translateX(0px)' }, { transform: `translateX(${-totalWidth}px)` }],
    { duration: (totalWidth / speed) * 1000, iterations: Infinity, easing: 'linear' }
  );
  let width = banner.clientWidth || containerWidth;
  let beatTimer = null;
  let beatAnim = null;
  let inView = true;

  const offsetNow = () => (((scroll.currentTime || 0) / 1000) * speed) % totalWidth;
  const stopBeats = () => { clearTimeout(beatTimer); beatTimer = null; };
  const scheduleBeat = () => {
    stopBeats();
    if (myGeneration !== waveGeneration || scroll.playState !== 'running') return;
    const next = nextBeat(units, totalWidth, width - 30, speed, offsetNow());
    if (!next) return;
    beatTimer = setTimeout(() => {
      if (beatAnim) beatAnim.cancel();
      const def = BEAT_ANIMATIONS[next.shape];
      beatAnim = polyline.animate(def.keyframes, { duration: def.duration, easing: 'ease-out' });
      scheduleBeat();
    }, Math.max(0, next.delayMs));
  };
  const sync = () => {
    if (myGeneration !== waveGeneration) return;
    if (inView && isActive()) { if (scroll.playState !== 'running') scroll.play(); scheduleBeat(); }
    else { scroll.pause(); stopBeats(); }
  };

  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    inView = entries[entries.length - 1].isIntersecting;
    sync();
  }) : null;
  io?.observe(banner);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const w = banner.clientWidth;
    if (w && w !== width) { width = w; if (scroll.playState === 'running') scheduleBeat(); }
  }) : null;
  ro?.observe(banner);
  const off = onActivity(sync);
  waveTeardown = () => { scroll.cancel(); beatAnim?.cancel(); stopBeats(); io?.disconnect(); ro?.disconnect(); off(); };
  sync();
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
  // Only the Vanilla / Modded launch tiles lock while the game runs; the Forum tile shares their look but stays usable.
  document.querySelectorAll('.home-launch-row .home-tile').forEach((el) => (el.disabled = status != null));
  document.getElementById('home-play-status').textContent =
    status === 'launching' ? 'Launching…' : status === 'running' ? 'Running' : '';
}

let polling = false;

async function pollRunning() {
  if (polling) return; // a slow check must not overlap the next tick, or the exit handling runs twice
  polling = true;
  try {
    await checkRunning();
  } catch (err) {
    logLine(`couldn't check whether the game is running: ${escapeForHtml(String(err))}`);
  } finally {
    polling = false;
  }
}

async function checkRunning() {
  const { invoke } = window.__TAURI__.core;
  const running = isRunningState(await invoke('is_game_running'));
  if (running) {
    seenRunning = true;
    setPlayStatus('running');
    return;
  }
  if (!seenRunning && Date.now() - launchStartedAt < launchGraceMs) {
    return;
  }
  clearTimeout(pollHandle);
  pollHandle = null;
  watchingGame = false;
  setPlayStatus(null);
  logLine(seenRunning ? 'game process exited' : "game never started (Steam didn't launch it in time)");
  if (lastLaunchMode === 'modded') {
    lastLaunchMode = null;
    if (keepGameModded()) {
      logLine('keeping the game modded (Settings)');
      return;
    }
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
    watchingGame = true;
    clearTimeout(pollHandle);
    pollHandle = setTimeout(pollRunning, launchGraceMs + 500);
  } catch (err) {
    document.getElementById('home-play-status').textContent = String(err);
    logLine(`launch failed: ${String(err)}`);
    setPlayStatus(null);
  }
};

let accountSynced = false;

window.__updateAccountBadge = () => { updateAccountBadge(); };
export function updateAccountBadge() {
  const badge = document.getElementById('home-account-badge');
  if (!badge) return;
  const loggedIn = isLoggedIn();
  const admin = loggedIn && isAdmin();
  // The account's name in its own colour (gradients too), like everywhere else the name appears.
  const st = loggedIn ? nameStyle(getNameColor()) : '';
  badge.innerHTML = loggedIn ? `<span class="home-badge-name"${st ? ` style="${st}"` : ''}>${escapeHtml(getUsername() || '')}</span>` : 'Log In';
  badge.classList.toggle('is-logged-in', loggedIn);
  badge.classList.toggle('is-admin', admin);
}

function setLoginMode(mode) {
  loginMode = mode;
  document.getElementById('login-title').textContent = mode === 'login' ? 'Log In' : 'Register';
  document.getElementById('login-submit').textContent = mode === 'login' ? 'Log In' : 'Register';
  document.getElementById('login-toggle-mode').textContent =
    mode === 'login' ? 'Need an account? Register' : 'Already have an account? Log In';
  document.getElementById('login-error').hidden = true;
}

function openLoginModal() {
  setLoginMode('login');
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  if (sessionExpired()) {
    const err = document.getElementById('login-error');
    err.textContent = EXPIRED_MESSAGE;
    err.hidden = false;
    clearExpiredNote();
  }
  document.getElementById('login-overlay').hidden = false;
}

function closeLoginModal() {
  document.getElementById('login-overlay').hidden = true;
}

async function submitLoginForm() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  if (!username || !password) {
    errorEl.textContent = 'Username and password are required.';
    errorEl.hidden = false;
    return;
  }

  const btn = document.getElementById('login-submit');
  btn.disabled = true;
  try {
    const res = await fetch(`${HUB_BASE}/api/${loginMode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'something went wrong');
    setSession(body.token, body.username);
    closeLoginModal();
    updateAccountBadge();
    refreshSession().then(updateAccountBadge);
  } catch (err) {
    errorEl.textContent = String(err.message || err);
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

window.__homeAccountBadgeClick = function () {
  if (isLoggedIn()) {
    window.navigate('account');
  } else {
    openLoginModal();
  }
};

// Only the full game can be modded, not the demo or playtest build: grey out the Modded launch tile and hide mod entry points.
function applyVariantUi(active) {
  const unmoddable = !!active && active.variant !== 'Full Game';
  document.getElementById('home-modded-tile').disabled = unmoddable;
  const note = document.getElementById('home-demo-note');
  note.style.display = unmoddable ? '' : 'none';
  if (unmoddable) note.textContent = `The ${active.variant.toLowerCase()} build only supports vanilla - mods aren't available on it.`;
  // Library news is only shown next to the full game.
  const news = document.querySelector('.home-log-panel');
  if (news) {
    news.style.display = active?.variant === 'Full Game' ? '' : 'none';
    layoutNews();
  }
  for (const id of ['home-mods-row', 'home-maps-row', 'home-skins-row', 'home-amplifier-row']) {
    document.getElementById(id).style.display = unmoddable ? 'none' : '';
  }
}

export async function refreshInstallStatus(opts = {}) {
  updateAccountBadge();
  if (!accountSynced) {
    accountSynced = true;
    refreshSession().then(updateAccountBadge);
  }
  return renderInstallList(document.getElementById('home-install-list'), {
    emptyHtml: `<div class="home-install-label">IGTAP not found</div><div class="home-install-sub">Set the path in Settings.</div>`,
    onError: (err) => { if (opts.log !== false) logLine(`install detection failed: ${String(err)}`); },
    onEmpty: () => { if (opts.log !== false) logLine('no installation detected'); applyVariantUi(null); },
    onSelect: (install) => logLine(`switched active install to <b>IGTAP (${install.variant})</b>`),
    onSelectError: (err) => logLine(`couldn't switch install: ${String(err)}`),
    onRendered: (installs, active) => {
      applyVariantUi(active);
      if (opts.log === false) return;
      logLine(active
        ? `installation detected: <b>IGTAP (${active.variant})</b>`
        : `${installs.length} install${installs.length === 1 ? '' : 's'} found`);
    },
  });
}

// With several installs (full game + demo) start on the first detected without asking; all stay in the Installation list.
async function autoSelectInstall() {
  const { invoke } = window.__TAURI__.core;
  const saved = await invoke('get_saved_game_path').catch(() => null);
  if (saved) return;

  const installs = await invoke('detect_all_igtap_installs').catch(() => []);
  if (installs.length < 2) return;
  await invoke('set_game_path', { path: installs[0].path }).catch(() => {});
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

  // Don't nag: a build that can't install packages itself gets a log line, and a version the user said "Later" to stays quiet until a newer one.
  if (info.appUpdateAvailable && !info.mapsUpdateAvailable) {
    if (!info.downloadUrl) {
      logLine(`update available: <b>v${info.latestVersion}</b> (this install can't update itself)`);
      return;
    }
    let postponed = null;
    try { postponed = localStorage.getItem('postponed-update'); } catch { /* storage unavailable */ }
    if (postponed === info.latestVersion) {
      logLine(`update <b>v${info.latestVersion}</b> is available (postponed)`);
      return;
    }
  }

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

    laterBtn.onclick = () => {
      try { localStorage.setItem('postponed-update', info.latestVersion); } catch { /* storage unavailable */ }
      overlay.hidden = true;
    };
    const install = async () => {
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
        progress.textContent = `${String(err)} - press Update Now to retry.`;
      }
    };
    nowBtn.onclick = install;
    // New releases carry backend changes that can't be applied live, so the app installs them itself.
    if (info.downloadUrl) install();
  } else if (info.mapsUpdateAvailable) {
    logLine(`Navigator mod update available: <b>v${info.bundledMapsVersion}</b> (game has v${info.deployedMapsVersion})`);
    body.innerHTML = `<p>The Navigator mod needs redeploying to your game: bundled <b>v${info.bundledMapsVersion}</b>, game currently has <b>v${info.deployedMapsVersion}</b>.</p>`;
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
        progress.textContent = String(err).replace('IGTAP_RUNNING:', '').trim();
      } finally {
        nowBtn.disabled = false;
        laterBtn.disabled = false;
        overlay.hidden = true;
      }
    };
  }
}

// Bump when ModApi/Runtime change in a way already-deployed loaders must pick up.
const LOADER_EPOCH = '2026-09-26b';

async function redeployLoader() {
  const { invoke } = window.__TAURI__.core;
  const { event } = window.__TAURI__;
  logLine('loader in your game is out of date - updating it and your mods…');
  const unlisten = await event.listen('loader-progress', (e) => logLine(escapeForHtml(String(e.payload))));
  try {
    await invoke('install_or_update_loader');
    logLine('loader: <b>updated</b>');
    try { localStorage.setItem('loader-epoch', LOADER_EPOCH); } catch { /* storage unavailable */ }
  } catch (err) {
    if (String(err).includes('IGTAP_RUNNING:')) {
      // The game has the assemblies mapped: skip quietly and try again once it is closed.
      logLine('loader update postponed - IGTAP is running');
      scheduleLoaderRetry();
    } else {
      logLine(`loader update failed: ${escapeForHtml(String(err))}`);
    }
  } finally {
    unlisten();
  }
}

let loaderRetryTimer = null;
function scheduleLoaderRetry() {
  if (loaderRetryTimer) return;
  loaderRetryTimer = setTimeout(async () => {
    loaderRetryTimer = null;
    let running = true;
    try { running = isRunningState(await window.__TAURI__.core.invoke('is_game_running')); } catch { /* retry later */ }
    if (running) scheduleLoaderRetry();
    else redeployLoader();
  }, 30000);
}

function escapeForHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function initHome() {
  const { invoke } = window.__TAURI__.core;

  document.getElementById('login-toggle-mode').addEventListener('click', () => setLoginMode(loginMode === 'login' ? 'register' : 'login'));
  document.getElementById('login-submit').addEventListener('click', submitLoginForm);
  document.getElementById('login-cancel').addEventListener('click', closeLoginModal);

  logLine('recharge started');
  applyRandomBackground();

  await autoSelectInstall();
  // Independent of the checks below, so it runs alongside them; its log line still comes after theirs.
  const modsScan = invoke('list_installed_mods');
  modsScan.catch(() => {});
  const install = await refreshInstallStatus();

  let loaderInstalled = false;
  let loaderOutdated = false;
  try {
    const loader = await invoke('loader_status');
    loaderInstalled = loader.installed;
    // Older app builds don't report staleness, so they redeploy once per epoch.
    loaderOutdated = loader.outdated ?? (localStorage.getItem('loader-epoch') !== LOADER_EPOCH);
    logLine(loader.installed ? `loader: <b>installed</b> (v${loader.version})` : 'loader: not installed');
  } catch (err) {
    logLine(`loader status check failed: ${String(err)}`);
  }

  if (!install) {
    showOnboarding(
      `<p>Recharge couldn't find your IGTAP install automatically.</p>
       <p>Head to Settings to check the detected path, or verify IGTAP is installed via Steam.</p>`
    );
  } else if (!loaderInstalled && install.variant === 'Full Game') {
    // Only the full game is set up for mods (the demo can't take them, the playtest build isn't for the loader).
    showOnboarding(
      `<p>Almost there - <b>RechargeLoader</b> isn't installed yet, and it's what lets mods actually run in-game.</p>
       <p>Go to Settings and click <b>Install / Update</b> under RechargeLoader to finish setup.</p>`
    );
  }
  checkForLauncherUpdate();

  try {
    const mods = await modsScan;
    const enabled = mods.filter((m) => m.enabled).length;
    logLine(`${mods.length} mod${mods.length === 1 ? '' : 's'} found, ${enabled} enabled`);
  } catch (err) {
    logLine(`mod scan failed: ${String(err)}`);
  }

  // The Rust side polls the process every 2 s and emits `game-running` when it changes; this replaces the old 2 s interval.
  window.__TAURI__.event?.listen('game-running', () => { if (watchingGame) pollRunning(); });
  if (isRunningState(await invoke('is_game_running'))) {
    seenRunning = true;
    setPlayStatus('running');
    watchingGame = true;
    logLine('game process already running');
  } else {
    logLine('no active game process');
    if (keepGameModded()) {
      logLine('keeping the game modded (Settings)');
    } else try {
      await invoke('restore_vanilla_build');
    } catch { /* no install detected yet, or nothing to restore - fine */ }
    // Mods are built against the loader's ModApi; a game with an older one shows half-built mod menus, so update it quietly.
    if (loaderInstalled && loaderOutdated && install?.variant === 'Full Game') redeployLoader();
  }

  initHomeNews();
  startWaveform();
  alignLeftColumn();
}

// The Forum tile ends a little above the bottom of the menu panel (Credits): the left column is sized to reach it. Only while the
// columns sit side by side; when the window is narrow and they stack, the column keeps its natural height.
function alignLeftColumn() {
  const col = document.querySelector('.home-left-col'), rows = document.querySelector('.home-menu-rows');
  if (!col || !rows || col.dataset.aligned) return;
  col.dataset.aligned = '1';
  const fit = () => {
    col.style.height = '';
    const c = col.getBoundingClientRect(), r = rows.getBoundingClientRect();
    if (!c.height || !r.height || Math.abs(c.top - rows.closest('.home-menu-col').getBoundingClientRect().top) > 2) return;
    // A little above the menu panel's bottom edge (not level with it), so it doesn't crowd the bottom of the page.
    const h = r.bottom - 72 - c.top;
    if (h > c.height) col.style.height = h + 'px';
  };
  new ResizeObserver(fit).observe(rows);
  window.addEventListener('resize', fit);
  fit();
}
