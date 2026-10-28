import { isActive, onActivity } from './activity.js';
import { isHalloween, onThemeChange } from './halloween.js';
import { mediaBase, mediaUrl, showVideo, clearVideo, setSound, soundFor, setGameRunning, currentVideo, currentSound } from './bgmedia.js';

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

// Shows a texture without persisting it (a media-server URL is only valid for this session; the early-paint copy in localStorage must be a data URL).
function applyLiveTexture(url) {
  try { localStorage.removeItem(TEXTURE_KEY); } catch (e) {}
  document.documentElement.style.setProperty('--bg-image', `url("${url}")`);
}

// Pictures that fit localStorage are kept as a data URL for the early-paint script in index.html (as before); bigger ones are only shown live.
const TEXTURE_PERSIST_MAX = 3 * 1024 * 1024;
async function persistableTexture(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > TEXTURE_PERSIST_MAX) { res.body?.cancel?.(); return null; }
    const blob = await res.blob();
    if (blob.size > TEXTURE_PERSIST_MAX) return null;
    return await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); });
  } catch (e) { return null; }
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

// While the Halloween theme is on its own background replaces the user's: no rotation, video or sound (their settings stay as they are).
// On the way back the normal path decides again (restores the current item, or rotates if due).
onThemeChange((theme) => {
  if (theme === 'halloween') {
    setHasBg(true);
    clearVideo();
    setSound(null);
  } else {
    setHasBg(!!bgLoad(BG_CUR_KEY));
    changeBackground('tick');
  }
});

function bgLoad(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function bgStore(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

// Crossfades a fixed layer (under the UI) in over the old picture, then commits it as the texture.
// `url` is what is shown (a data URL or a media-server URL); `persistUrl` (a data URL, or null) is what is saved for the next start.
function crossfadeTexture(url, persistUrl = url) {
  const commit = () => { if (persistUrl) applyBgTexture(persistUrl); else if (url) applyLiveTexture(url); else applyBgTexture(''); };
  if (!url || document.hidden || !document.body) {
    commit();
    return Promise.resolve();
  }
  const layer = document.createElement('div');
  layer.style.cssText =
    'position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:0;background-size:cover;background-position:center;background-repeat:no-repeat;' +
    `transition:opacity ${FADE_MS}ms ease;background-image:url("${url}")`;
  document.body.appendChild(layer);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { layer.style.opacity = '1'; }));
    setTimeout(() => {
      try { commit(); } catch (e) {}
      layer.remove();
      resolve();
    }, FADE_MS + 60);
  });
}

// Not due yet (e.g. restarted within the interval): bring back the current item's video and sound without rotating.
async function restoreCurrent(invoke, playlist) {
  if (isHalloween()) return;
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
  if (isHalloween()) return;
  try {
    const { invoke } = window.__TAURI__.core;
    const config = await invoke('get_backgrounds_config');
    const playlist = (config.playlists || []).find((p) => p.id === config.active_playlist);
    if (playlist) await syncSound(invoke, playlist);
  } catch (e) {}
}

// mode 'launch': change if the active playlist is every-launch or due; 'tick': only timed playlists that are due; 'force': always.
export async function changeBackground(mode = 'launch') {
  if (isHalloween()) { setHasBg(true); return false; }
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
    // inline:false - images come back as a file name and are loaded from the media server, not base64 over IPC.
    const picked = await invoke('pick_background', { exclude: bgLoad(BG_CUR_KEY), inline: false });
    if (!picked) return false;
    if (picked.kind === 'video') {
      const base = await mediaBase(invoke);
      const video = await showVideo(mediaUrl(base, picked.file));
      if (!video) return false;
      bgStore(BG_LAST_KEY, String(bgClock()));
      bgStore(BG_CUR_KEY, picked.file);
      setSound(picked.sound, base);
      return true;
    }
    let shown = picked.data_url || '';
    let persist = shown || null;
    if (!shown) {
      try {
        shown = mediaUrl(await mediaBase(invoke), picked.file);
        persist = await persistableTexture(shown);
      } catch (e) {
        // media server unreachable: the old way, the whole picture through the backend
        shown = await invoke('read_background_image', { fileName: picked.file });
        persist = shown;
      }
    }
    if (!shown) return false;
    bgStore(BG_LAST_KEY, String(bgClock()));
    bgStore(BG_CUR_KEY, picked.file);
    await crossfadeTexture(shown, persist);
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
let bgActivityOff = null;
let gameUnlisten = null;
export function startBackgroundTimer({ periodMs = 15000, now } = {}) {
  if (now) bgClock = now;
  if (bgTimer) clearInterval(bgTimer);
  setHasBg(isHalloween() || !!bgLoad(BG_CUR_KEY));
  // No ticking while the window is hidden or minimised; one catch-up check when it comes back.
  const arm = () => { clearInterval(bgTimer); bgTimer = setInterval(() => changeBackground('tick'), periodMs); };
  if (bgActivityOff) bgActivityOff();
  if (isActive()) arm(); else bgTimer = null;
  bgActivityOff = onActivity((on) => { if (on) { arm(); changeBackground('tick'); } else { clearInterval(bgTimer); bgTimer = null; } });
  // Videos and sound stop while the game runs: one initial check, then the backend's `game-running` events (it polls once for the whole app).
  const T = window.__TAURI__;
  try { T?.core?.invoke?.('is_game_running').then((s) => setGameRunning(s === true || s === 'running'), () => {}); } catch (e) {}
  if (gameUnlisten) { try { gameUnlisten(); } catch (e) {} gameUnlisten = null; }
  try {
    const p = T?.event?.listen?.('game-running', (e) => setGameRunning(e.payload === 'running'));
    p?.then?.((un) => { gameUnlisten = un; });
  } catch (e) {}
  return () => { clearInterval(bgTimer); bgTimer = null; if (bgActivityOff) { bgActivityOff(); bgActivityOff = null; } if (gameUnlisten) { try { gameUnlisten(); } catch (e) {} gameUnlisten = null; } };
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
