import { mediaBase, mediaUrl, showVideo, clearVideo, setSound, soundFor, pollGameRunning, currentVideo, currentSound } from './bgmedia.js';

// Old theming storage keys, removed at startup (the colour scheme is now fixed in style.css).
const LEGACY_KEYS = ['rechargeColors', 'rechargeCustomCss'];
const LEGACY_CSS_ELEMENT_ID = 'recharge-custom-css';

export function clearLegacyTheme() {
  try { for (const k of LEGACY_KEYS) localStorage.removeItem(k); } catch (e) {}
  try {
    const el = document.getElementById(LEGACY_CSS_ELEMENT_ID);
    if (el) el.remove();
  } catch (e) {}
  try { document.documentElement.style.colorScheme = ''; } catch (e) {}
}
clearLegacyTheme();

const TEXTURE_KEY = 'rechargeBgTexture';
const WAVE_KEY = 'rechargeWaveSettings';

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

// One steady flag: <html class="has-bg"> while a background playlist is active. Set at startup (from the last shown item)
// and corrected by changeBackground() once the config is known; never touched per item or while media loads.
function setHasBg(on) {
  document.documentElement.classList.toggle('has-bg', !!on);
}

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

// Not due yet (e.g. restarted within the interval): bring back the current item's video and sound without rotating.
async function restoreCurrent(invoke, playlist) {
  const cur = bgLoad(BG_CUR_KEY);
  if (!cur || !(playlist.images || []).includes(cur)) return;
  const isVideo = /\.(mp4|webm)$/i.test(cur);
  const sound = soundFor(playlist.sound, playlist.images, isVideo);
  if (isVideo && !currentVideo()) {
    const base = await mediaBase(invoke);
    const video = await showVideo(mediaUrl(base, cur));
    if (!video) return;
  }
  await syncSound(invoke, playlist);
}

// Swap the sound for the current item in place (sound setting changed): never picks or advances the background.
async function syncSound(invoke, playlist) {
  const cur = bgLoad(BG_CUR_KEY);
  const isVideo = !!cur && /\.(mp4|webm)$/i.test(cur);
  const sound = soundFor(playlist.sound, playlist.images, isVideo);
  if (sound !== (currentSound() || null)) setSound(sound, sound && sound !== 'own' ? await mediaBase(invoke) : null);
}

export async function applySoundSetting() {
  try {
    const { invoke } = window.__TAURI__.core;
    const config = await invoke('get_backgrounds_config');
    const playlist = (config.playlists || []).find((p) => p.id === config.active_playlist);
    if (playlist) await syncSound(invoke, playlist);
  } catch (e) {}
}

// mode 'launch': change if the active playlist is every-launch or due; 'tick': only timed playlists that are due; 'force': always.
export async function changeBackground(mode = 'launch') {
  if (bgBusy) return false;
  bgBusy = true;
  try {
    const { invoke } = window.__TAURI__.core;
    const config = await invoke('get_backgrounds_config');
    const playlist = (config.playlists || []).find((p) => p.id === config.active_playlist);
    if (!playlist) {
      setHasBg(false);
      clearVideo();
      setSound(null);
      return false;
    }
    setHasBg(true);
    const interval = playlist.interval || 0;
    const last = Number(bgLoad(BG_LAST_KEY)) || 0;
    const due = interval > 0 && bgClock() - last >= interval * 1000;
    if (mode === 'tick' ? !due : mode === 'launch' && interval > 0 && !due) {
      await restoreCurrent(invoke, playlist);
      return false;
    }
    const picked = await invoke('pick_background', { exclude: bgLoad(BG_CUR_KEY) });
    if (!picked || (picked.kind !== 'video' && !picked.data_url)) return false;
    if (picked.kind === 'video') {
      const base = await mediaBase(invoke);
      const video = await showVideo(mediaUrl(base, picked.file));
      if (!video) return false;
      bgStore(BG_LAST_KEY, String(bgClock()));
      bgStore(BG_CUR_KEY, picked.file);
      setSound(picked.sound, base);
      return true;
    }
    bgStore(BG_LAST_KEY, String(bgClock()));
    bgStore(BG_CUR_KEY, picked.file);
    await crossfadeTexture(picked.data_url);
    clearVideo();
    setSound(picked.sound, picked.sound && picked.sound !== 'own' ? await mediaBase(invoke) : null);
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
let gameTimer = null;
export function startBackgroundTimer({ periodMs = 15000, now } = {}) {
  if (now) bgClock = now;
  if (bgTimer) clearInterval(bgTimer);
  setHasBg(!!bgLoad(BG_CUR_KEY));
  bgTimer = setInterval(() => changeBackground('tick'), periodMs);
  // Videos and sound stop while the game runs: look every few seconds.
  const poll = () => { const invoke = window.__TAURI__?.core?.invoke; if (invoke) pollGameRunning(invoke); };
  poll();
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = setInterval(poll, 5000);
  return () => { clearInterval(bgTimer); clearInterval(gameTimer); bgTimer = null; gameTimer = null; };
}

// Call after the active playlist changed (force) or its interval did (re-check if due).
export function recheckBackground(force = false) {
  return changeBackground(force ? 'force' : 'tick');
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
