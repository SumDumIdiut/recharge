let pollHandle = null;

// ── Procedural waveform: randomized spikes, beat synced to what's on screen ──
const WAVE_BASE_Y = 22;
const WAVE_SPEED = 90; // px/sec
const BEAT_SHAPES = ['single', 'double', 'sharp'];

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

function buildWaveform(minTotalWidth) {
  const units = [];
  let x = 0;
  while (x < minTotalWidth) {
    const width = 220 + Math.random() * 160;
    const height = 12 + Math.random() * 16;
    const shape = BEAT_SHAPES[Math.floor(Math.random() * BEAT_SHAPES.length)];
    units.push({ x0: x, width, height, shape, peakX: x + width * peakFraction(shape) });
    x += width;
  }
  return { units, totalWidth: x };
}

function startWaveform() {
  const svg = document.querySelector('.wave-trace');
  const polyline = svg?.querySelector('polyline');
  const banner = document.getElementById('wave-banner');
  if (!svg || !polyline || !banner) return;

  const containerWidth = banner.clientWidth || 900;
  const { units, totalWidth } = buildWaveform(Math.max(containerWidth * 3, 6000));

  const allPoints = [];
  for (const u of units) allPoints.push(...shapePoints(u.shape, u.x0, u.width, u.height, WAVE_BASE_Y));
  for (const u of units) allPoints.push(...shapePoints(u.shape, u.x0 + totalWidth, u.width, u.height, WAVE_BASE_Y));

  svg.setAttribute('width', String(totalWidth * 2));
  svg.setAttribute('viewBox', `0 0 ${totalWidth * 2} 44`);
  polyline.setAttribute('points', allPoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));

  const lastScreenX = new Map(units.map((u) => [u, null]));
  const start = performance.now();

  function frame(now) {
    const elapsed = (now - start) / 1000;
    const offset = (elapsed * WAVE_SPEED) % totalWidth;
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
  }
}

window.__homeLaunch = async function (mode) {
  const { invoke } = window.__TAURI__.core;
  setPlaying(true);
  logLine(`launching <b>${mode.toUpperCase()}</b>…`);
  try {
    await invoke('launch_game', { modded: mode === 'modded' });
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
  } catch (err) {
    label.textContent = 'IGTAP not found';
    sub.textContent = String(err);
    if (opts.log !== false) logLine(`install detection failed: ${String(err)}`);
  }
}

export async function initHome() {
  const { invoke } = window.__TAURI__.core;

  logLine('recharge started');

  await refreshInstallStatus();

  try {
    const loader = await invoke('loader_status');
    logLine(loader.installed ? `loader: <b>installed</b> (v${loader.version})` : 'loader: not installed');
  } catch (err) {
    logLine(`loader status check failed: ${String(err)}`);
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
  }

  startWaveform();
}
