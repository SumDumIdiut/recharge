import { setWindowBackground } from './activity.js';
// Video + audio backgrounds: a fixed muted looping <video> behind the UI, optional sound (the video's own or an audio file).
// Pauses the picture when backgrounded (minimised/hidden/unfocused/game running); sound follows the "keep playing" pref. Sound is off unless the user switches it on.
import { releaseMedia, manualLoop } from './releasemedia.js';

const PREFS_KEY = 'rechargeBgAudio';
const FADE_MS = 1000;

export const AUDIO_DEFAULTS = { enabled: false, volume: 0.4, keepPlaying: false };

export function getAudioPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (saved && typeof saved === 'object') {
      const volume = Number(saved.volume);
      return { enabled: saved.enabled === true, keepPlaying: saved.keepPlaying === true, volume: volume >= 0 && volume <= 1 ? volume : AUDIO_DEFAULTS.volume };
    }
  } catch (e) {}
  return { ...AUDIO_DEFAULTS };
}

export function saveAudioPrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  applyPlayback();
}

// What should be running right now? Pure, so it can be tested.
// sound: null | 'own' | an audio file name.
// Background = the document is hidden, the window is minimised / not visible / not focused, or the game runs.
// keepPlaying keeps the SOUND going in every background case; the picture is paused (and hidden) whenever backgrounded,
// except a video whose own sound is the chosen sound: that element must keep playing for its audio (CPU trade-off).
export function backgroundReason({ hidden, minimised, invisible, unfocused, gameRunning }) {
  if (gameRunning) return 'game';
  if (minimised) return 'minimised';
  if (invisible || hidden) return 'hidden';
  if (unfocused) return 'unfocused';
  return null;
}

export function playbackPlan({ hidden, minimised, invisible, unfocused, gameRunning, prefs, sound, hasVideo }) {
  const background = !!backgroundReason({ hidden, minimised, invisible, unfocused, gameRunning });
  const audioAllowed = !!sound && prefs.enabled && (!background || prefs.keepPlaying);
  const ownSound = sound === 'own' && audioAllowed;
  const picture = hasVideo && !background;
  return {
    background,
    // The video's own sound is carried by the video element itself, so it keeps playing (hidden) while it is the sound.
    video: hasVideo && (picture || ownSound),
    videoHidden: hasVideo && !picture,
    videoMuted: !ownSound,
    audio: audioAllowed && sound !== 'own',
    volume: prefs.volume,
  };
}

// Diagnostics go to <app data>/media.log through the backend (and the console). Throttled: the same line at most every 2 s, 80 lines a minute.
const logSeen = new Map();
let logWindow = { start: 0, n: 0 };
export function mlog(line) {
  try {
    const text = String(line).replace(/(https?:\/\/[^\/\s]+\/)[^\/\s]+\//g, '$1<token>/');
    const now = Date.now();
    if (now - (logSeen.get(text) || 0) < 2000) return;
    logSeen.set(text, now);
    if (logSeen.size > 200) logSeen.clear();
    if (now - logWindow.start > 60000) logWindow = { start: now, n: 0 };
    if (++logWindow.n > 80) return;
    console.log('[bgmedia]', text);
    window.__TAURI__?.core?.invoke?.('media_log', { line: text })?.catch?.(() => {});
  } catch (e) {}
}

function elState(el) {
  return el ? `readyState=${el.readyState} networkState=${el.networkState} muted=${el.muted} volume=${el.volume} paused=${el.paused} err=${el.error?.code ?? 'none'}` : 'no element';
}

const state = { base: null, video: null, audio: null, audioFile: null, sound: null, gameRunning: false, win: { minimised: false, invisible: false, unfocused: false }, lastReason: null };

export async function mediaBase(invoke) {
  if (!state.base) state.base = await invoke('background_media_base');
  return state.base;
}

export function mediaUrl(base, file) {
  return `${base}${encodeURIComponent(file)}`;
}

export function currentVideo() { return state.video; }
export function currentSound() { return state.sound; }

const AUDIO_RE = /\.(mp3|ogg|wav)$/i;
// Client-side twin of the backend's sound choice, for restoring the current item without rotating:
// playlist.sound is 'auto' | 'off' | 'own' | file name; 'own' only fits a video.
export function soundFor(playlistSound, images, isVideo) {
  const s = playlistSound || 'auto';
  if (s === 'off') return null;
  if (s === 'own') return isVideo ? 'own' : null;
  if (s === 'auto') return (images || []).find((f) => AUDIO_RE.test(f)) || null;
  return images?.includes(s) || AUDIO_RE.test(s) ? s : null;
}

// play() with the failure logged. WebKit refuses sound without a user gesture (NotAllowedError):
// try again on the next click/key, e.g. the one that switches the speaker on.
let gestureRetry = false;
function tryPlay(el, what) {
  const p = el.play?.();
  mlog(`${what} play() called: ${elState(el)}`);
  p?.then?.(() => mlog(`${what} play() resolved: ${elState(el)}`), () => {});
  p?.catch?.((err) => {
    mlog(`${what} play() REJECTED ${err?.name || err}: ${err?.message || ''} ${elState(el)}`);
    console.warn(`[bgmedia] ${what} play() failed:`, err?.name || err, err?.message || '');
    if (err?.name === 'NotAllowedError' && !gestureRetry && typeof document !== 'undefined') {
      gestureRetry = true;
      const retry = () => {
        gestureRetry = false;
        document.removeEventListener('pointerdown', retry, true);
        document.removeEventListener('keydown', retry, true);
        applyPlayback();
      };
      document.addEventListener('pointerdown', retry, true);
      document.addEventListener('keydown', retry, true);
    }
  });
}

// Other sound users (the Halloween theme music) follow the same background policy: they get { background, keepPlaying, volume } on every applyPlayback.
const playbackListeners = new Set();
export function onPlayback(fn) { playbackListeners.add(fn); return () => playbackListeners.delete(fn); }

export function applyPlayback() {
  setWindowBackground(!!(state.win.minimised || state.win.invisible));
  const hidden = typeof document !== 'undefined' && !!document.hidden;
  const prefs = getAudioPrefs();
  const plan = playbackPlan({
    hidden,
    ...state.win,
    gameRunning: state.gameRunning,
    prefs,
    sound: state.sound,
    hasVideo: !!state.video,
  });
  const reason = backgroundReason({ hidden, ...state.win, gameRunning: state.gameRunning });
  if (reason !== state.lastReason) {
    state.lastReason = reason;
    mlog(`background ${reason ? `ON (${reason})` : 'OFF (foreground)'} keepPlaying=${prefs.keepPlaying}`);
  }
  mlog(`applyPlayback sound=${state.sound} enabled=${prefs.enabled} volume=${plan.volume} plan=${JSON.stringify({ video: plan.video, videoMuted: plan.videoMuted, audio: plan.audio })} reason=${reason} game=${state.gameRunning}`);
  for (const fn of [...playbackListeners]) { try { fn({ background: plan.background, keepPlaying: prefs.keepPlaying, volume: prefs.volume }); } catch (e) {} }
  const v = state.video;
  if (v) {
    v.muted = plan.videoMuted;
    v.volume = plan.volume;
    if (v.style) v.style.visibility = plan.videoHidden ? 'hidden' : '';
    if (plan.video) tryPlay(v, 'video'); else v.pause?.();
  }
  const a = state.audio;
  if (a) {
    a.volume = plan.volume;
    if (plan.audio && state.audioFile) tryPlay(a, 'audio'); else a.pause?.();
  }
}

export function setGameRunning(running) {
  if (state.gameRunning === !!running) return;
  state.gameRunning = !!running;
  applyPlayback();
}

// sound: null | 'own' | audio file name (library). Keeps playing if it's the same file.
export function setSound(sound, base) {
  state.sound = sound || null;
  mlog(`setSound ${state.sound}`);
  if (state.sound && state.sound !== 'own' && base) {
    if (state.audioFile !== state.sound) {
      // One element for good: WebKit remembers a user gesture per element, so a fresh one per track would be blocked again.
      const a = state.audio || document.createElement('audio');
      if (!state.audio) {
        manualLoop(a);
        a.preload = 'auto';
        a.addEventListener('error', () => {
          mlog(`audio ERROR code=${a.error?.code} msg=${a.error?.message || ''} src=${a.src} ${elState(a)}`);
          console.warn('[bgmedia] audio failed to load:', a.error?.code, a.error?.message || '', a.src);
        });
        for (const ev of ['loadedmetadata', 'canplay', 'playing', 'stalled', 'abort', 'emptied']) a.addEventListener(ev, () => mlog(`audio ${ev}: ${elState(a)}`));
      }
      a.src = mediaUrl(base, state.sound);
      mlog(`audio src ${a.src}`);
      state.audio = a;
      state.audioFile = state.sound;
    }
  } else {
    stopAudio();
  }
  applyPlayback();
}

function stopAudio() {
  if (state.audio) { if (!releaseMedia(state.audio)) state.audio = null; } // still loading: its release is deferred, so never reuse that element
  state.audioFile = null;
}

// Fully lets go of a <video>: stops the decoder and drops its buffers (remove() alone can leave them to the GC).
function releaseVideo(v) {
  releaseMedia(v);
}

export function clearVideo() {
  if (state.video) releaseVideo(state.video);
  state.video = null;
}

// Fades a new video layer in over whatever is shown; resolves with the <video> once it plays (or null if it can't).
export function showVideo(url) {
  return new Promise((resolve) => {
    if (!document.body) return resolve(null);
    const video = document.createElement('video');
    video.className = 'bg-video-layer';
    video.muted = true;
    manualLoop(video); // never the loop attribute: see releasemedia.js
    video.autoplay = true;
    video.playsInline = true;
    // no crossOrigin: nothing reads this layer's pixels, and a CORS fetch fails from the live page origin
    video.preload = 'auto';
    video.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none;opacity:0;' +
      `transition:opacity ${FADE_MS}ms ease;`;
    let done = false;
    const fail = () => { if (done) return; done = true; releaseVideo(video); resolve(null); };
    video.addEventListener('error', () => { mlog(`video ERROR code=${video.error?.code} msg=${video.error?.message || ''} src=${url}`); fail(); });
    video.addEventListener('playing', () => mlog(`video playing: ${elState(video)}`));
    video.addEventListener('loadeddata', () => {
      if (done) return;
      done = true;
      const old = state.video;
      state.video = video;
      applyPlayback();
      requestAnimationFrame(() => requestAnimationFrame(() => { video.style.opacity = '1'; }));
      if (old) setTimeout(() => releaseVideo(old), FADE_MS + 60);
      resolve(video);
    });
    video.src = url;
    document.body.appendChild(video);
    setTimeout(fail, 20000);
  });
}

// Window state from Tauri: document.hidden / visibilitychange never fire on minimise or a workspace switch in the webview.
// win: a Tauri window (onFocusChanged, onResized, isMinimized, isVisible, isFocused). Focus flaps are debounced.
export function watchWindow(win, { debounceMs = 300, pollMs = 2000 } = {}) {
  let timer = null;
  const commit = (next) => {
    const w = state.win;
    if (w.minimised === next.minimised && w.invisible === next.invisible && w.unfocused === next.unfocused) return;
    state.win = next;
    applyPlayback();
  };
  const read = async () => {
    try {
      const [minimised, visible, focused] = await Promise.all([win.isMinimized?.(), win.isVisible?.(), win.isFocused?.()]);
      const next = { minimised: !!minimised, invisible: visible === false, unfocused: focused === false };
      clearTimeout(timer);
      timer = setTimeout(() => commit(next), debounceMs);
    } catch (e) {}
  };
  try { win.onFocusChanged?.(({ payload }) => {
    const next = { ...state.win, unfocused: !payload };
    clearTimeout(timer);
    timer = setTimeout(() => { commit(next); read(); }, debounceMs);
  })?.catch?.(() => {}); } catch (e) {}
  try { win.onResized?.(read)?.catch?.(() => {}); } catch (e) {}
  try { win.onMoved?.(read)?.catch?.(() => {}); } catch (e) {}
  const poll = pollMs ? setInterval(read, pollMs) : null;
  poll?.unref?.();
  read();
  return () => { clearTimeout(timer); if (poll) clearInterval(poll); };
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', applyPlayback);
}
if (typeof window !== 'undefined') {
  try { const w = window.__TAURI__?.window?.getCurrentWindow?.(); if (w) watchWindow(w); } catch (e) {}
}
