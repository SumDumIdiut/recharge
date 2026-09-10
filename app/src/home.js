import { getWaveSettings } from '/theme.js';

let pollHandle = null;
let lastLaunchMode = null;

// ── Procedural waveform: randomized spikes, beat synced to what's on screen ──
const BEAT_SHAPES = ['single', 'double', 'sharp'];

// Bumped every time startWaveform() (re)builds the banner, so a stale
// requestAnimationFrame loop from a previous build can tell it's obsolete
// and stop recursing - without this, calling startWaveform() again to pick
// up a settings change would run two competing loops on the same polyline.
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

// amplitude/density come from the user's saved waveform settings - amplitude
// is the average peak height, density is the average distance between beats
// (both jittered the same +/-40%/+/-25% the original hardcoded ranges used,
// just centered on the configured value instead of a fixed constant).
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

  // The banner/SVG height used to be a flat 44px regardless of amplitude -
  // fine at the original fixed height=12-28 range, but the editable slider
  // goes up to 40, and a peak can swing up to ~0.7x the jittered height
  // (itself up to 1.4x the configured amplitude) off the centerline. Left
  // at 44px, a high amplitude setting just got its peaks clipped off top
  // and bottom. Size the banner to the WORST CASE for the current setting
  // instead, so nothing this waveform can draw is ever cut off.
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

function setPlaying(isPlaying) {
  document.querySelectorAll('.home-tile').forEach((el) => (el.disabled = isPlaying));
  document.getElementById('home-play-status').textContent = isPlaying ? 'Launching…' : '';
}

async function pollRunning() {
  const { invoke } = window.__TAURI__.core;
  const running = await invoke('is_game_running');
  if (!running) {
    clearInterval(pollHandle);
    pollHandle = null;
    setPlaying(false);
    logLine('game process exited');
    // The modded swap is a real file on disk, not a launch-time-only trick -
    // it's still deployed for whatever runs the game next, Steam-direct
    // included. Put it back to vanilla the moment the modded session ends so
    // "just running the game through Steam" is never silently modded.
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
}

window.__homeLaunch = async function (mode) {
  const { invoke } = window.__TAURI__.core;
  setPlaying(true);
  logLine(`launching <b>${mode.toUpperCase()}</b>…`);
  try {
    await invoke('launch_game', { modded: mode === 'modded' });
    lastLaunchMode = mode;
    logLine(`process started (${mode})`);
    if (!pollHandle) pollHandle = setInterval(pollRunning, 2000);
  } catch (err) {
    document.getElementById('home-play-status').textContent = String(err);
    logLine(`launch failed: ${String(err)}`);
    setPlaying(false);
  }
};

// Re-run whenever Home becomes visible again (not just at startup) - a path
// picked via Settings > Browse (or auto-detect finally succeeding) otherwise
// never shows up here until the whole app restarts, which looks exactly like
// Browse silently not working.
export async function refreshInstallStatus(opts = {}) {
  const { invoke } = window.__TAURI__.core;
  const label = document.getElementById('home-install-label');
  const sub = document.getElementById('home-install-sub');
  if (!label || !sub) return;

  try {
    const install = await invoke('detect_igtap_install');
    if (install) {
      label.textContent = `IGTAP (${install.variant})`;
      sub.textContent = install.path;
      if (opts.log !== false) logLine(`installation detected: <b>IGTAP (${install.variant})</b>`);
    } else {
      label.textContent = 'IGTAP not found';
      sub.textContent = 'Set the path in Settings.';
      if (opts.log !== false) logLine('no installation detected');
    }
    return install;
  } catch (err) {
    label.textContent = 'IGTAP not found';
    sub.textContent = String(err);
    if (opts.log !== false) logLine(`install detection failed: ${String(err)}`);
    return null;
  }
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

export async function initHome() {
  const { invoke } = window.__TAURI__.core;

  logLine('recharge started');

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
  }

  try {
    const mods = await invoke('list_installed_mods');
    const enabled = mods.filter((m) => m.enabled).length;
    logLine(`${mods.length} mod${mods.length === 1 ? '' : 's'} found, ${enabled} enabled`);
  } catch (err) {
    logLine(`mod scan failed: ${String(err)}`);
  }

  if (await invoke('is_game_running')) {
    setPlaying(true);
    pollHandle = setInterval(pollRunning, 2000);
    logLine('game process already running');
  } else {
    logLine('no active game process');
    // Covers the case where Recharge (or the whole PC) closed mid-modded-
    // session and never got to run pollRunning's own restore-on-exit - the
    // game isn't running right now, so it's safe to force the at-rest state
    // back to vanilla before anything launches it directly from Steam.
    try {
      await invoke('restore_vanilla_build');
    } catch { /* no install detected yet, or nothing to restore - fine */ }
  }

  startWaveform();
}
