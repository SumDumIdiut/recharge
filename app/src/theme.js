export const PRESETS = [
  {
    id: 'dark',
    name: 'Dark',
    bg: '#141414',
    panel: '#1c1c1c',
    text: '#f9ffe4',
    accent: '#41f88d',
    accent2: '#c63ed8',
  },
  {
    id: 'light',
    name: 'Light',
    bg: '#f4f2ea',
    panel: '#ffffff',
    text: '#171812',
    accent: '#1f9d5c',
    accent2: '#9c2aad',
  },
];

export const ATTRS = [
  { key: 'bg', label: 'Background' },
  { key: 'panel', label: 'Panel' },
  { key: 'text', label: 'Text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent2', label: 'Accent 2' },
];

const STORAGE_KEY = 'rechargeColors';
const TEXTURE_KEY = 'rechargeBgTexture';
const CUSTOM_CSS_KEY = 'rechargeCustomCss';
const WAVE_KEY = 'rechargeWaveSettings';

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function isDark(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

export function getColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.bg) return saved;
  } catch (e) {}
  return { ...PRESETS[0] };
}

export function applyColors(colors) {
  const root = document.documentElement.style;
  root.setProperty('--bg', colors.bg);
  root.setProperty('--panel', colors.panel);
  root.setProperty('--text', colors.text);
  root.setProperty('--text-dim', rgba(colors.text, 0.55));
  root.setProperty('--line', rgba(colors.text, 0.14));
  root.setProperty('--line-hi', rgba(colors.text, 0.4));
  root.setProperty('--grid-line', rgba(colors.text, 0.035));
  root.setProperty('--green', colors.accent);
  root.setProperty('--green-dim', rgba(colors.accent, 0.6));
  root.setProperty('--magenta', colors.accent2);
  root.setProperty('--magenta-dim', rgba(colors.accent2, 0.6));
  document.documentElement.style.colorScheme = isDark(colors.bg) ? 'dark' : 'light';
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(colors)); } catch (e) {}
}

export function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
  applyColors({ ...preset });
}

export function getBgTexture() {
  try { return localStorage.getItem(TEXTURE_KEY) || ''; } catch (e) { return ''; }
}

export function applyBgTexture(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(TEXTURE_KEY, dataUrl);
    else localStorage.removeItem(TEXTURE_KEY);
  } catch (e) {
    throw e;
  }
  document.documentElement.style.setProperty('--bg-image', dataUrl ? `url("${dataUrl}")` : 'none');
}

const BG_LAST_KEY = 'rechargeBgLastChange';
const BG_CUR_KEY = 'rechargeBgCurrent';
const FADE_MS = 1000;

let bgClock = () => Date.now(); // overridable for tests
let bgBusy = false;

function bgLoad(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function bgStore(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

// Crossfades a fixed layer (under the UI) in over the old picture, then commits it as the texture.
function crossfadeTexture(dataUrl) {
  if (!dataUrl || document.hidden || !document.body) {
    applyBgTexture(dataUrl);
    return Promise.resolve();
  }
  const layer = document.createElement('div');
  layer.style.cssText =
    'position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:0;background-size:cover;background-position:center;background-repeat:no-repeat;' +
    `transition:opacity ${FADE_MS}ms ease;background-image:url("${dataUrl}")`;
  document.body.appendChild(layer);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { layer.style.opacity = '1'; }));
    setTimeout(() => {
      try { applyBgTexture(dataUrl); } catch (e) {}
      layer.remove();
      resolve();
    }, FADE_MS + 60);
  });
}

// mode 'launch': change if the active playlist is every-launch or due; 'tick': only timed playlists that are due; 'force': always.
export async function changeBackground(mode = 'launch') {
  if (bgBusy) return false;
  bgBusy = true;
  try {
    const { invoke } = window.__TAURI__.core;
    const config = await invoke('get_backgrounds_config');
    const playlist = (config.playlists || []).find((p) => p.id === config.active_playlist);
    if (!playlist) return false;
    const interval = playlist.interval || 0;
    const last = Number(bgLoad(BG_LAST_KEY)) || 0;
    const due = interval > 0 && bgClock() - last >= interval * 1000;
    if (mode === 'tick' ? !due : mode === 'launch' && interval > 0 && !due) return false;
    const picked = await invoke('pick_background', { exclude: bgLoad(BG_CUR_KEY) });
    if (!picked || !picked.data_url) return false;
    bgStore(BG_LAST_KEY, String(bgClock()));
    bgStore(BG_CUR_KEY, picked.file);
    await crossfadeTexture(picked.data_url);
    return true;
  } catch (e) {
    return false;
  } finally {
    bgBusy = false;
  }
}

// Picks a fresh image from the active background playlist, if any - a no-op when there isn't one.
export function applyRandomBackground() {
  return changeBackground('launch');
}

// App-wide: checks now and every `periodMs` whether a timed playlist is due. Safe to call twice.
let bgTimer = null;
export function startBackgroundTimer({ periodMs = 15000, now } = {}) {
  if (now) bgClock = now;
  if (bgTimer) clearInterval(bgTimer);
  bgTimer = setInterval(() => changeBackground('tick'), periodMs);
  return () => { clearInterval(bgTimer); bgTimer = null; };
}

// Call after the active playlist changed (force) or its interval did (re-check if due).
export function recheckBackground(force = false) {
  return changeBackground(force ? 'force' : 'tick');
}

const CUSTOM_CSS_ELEMENT_ID = 'recharge-custom-css';

export function getCustomCss() {
  try { return localStorage.getItem(CUSTOM_CSS_KEY) || ''; } catch (e) { return ''; }
}

export function applyCustomCss(css) {
  try {
    if (css) localStorage.setItem(CUSTOM_CSS_KEY, css);
    else localStorage.removeItem(CUSTOM_CSS_KEY);
  } catch (e) {
    throw e;
  }
  let el = document.getElementById(CUSTOM_CSS_ELEMENT_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CUSTOM_CSS_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = css || '';
}

export const WAVE_DEFAULTS = { enabled: true, speed: 90, amplitude: 20, density: 300 };

export function getWaveSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(WAVE_KEY));
    if (saved) return { ...WAVE_DEFAULTS, ...saved };
  } catch (e) {}
  return { ...WAVE_DEFAULTS };
}

export function saveWaveSettings(settings) {
  try { localStorage.setItem(WAVE_KEY, JSON.stringify(settings)); } catch (e) {}
}
