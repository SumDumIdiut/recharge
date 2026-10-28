// Halloweencharge 2026 theme music: /assets/halloween-theme.mp3 on a seamless loop while the Halloween theme is the effective one.
// ONE shared <audio> for the whole session (WebKit remembers a user gesture per element); it is created on entering the theme and
// released on leaving. Follows bgmedia's playback policy (paused while hidden/minimised/unfocused or while the game runs, unless
// "keep playing") through onPlayback, and the volume of the shared bgAudio pref. Not gated on the playlist "enabled" pref:
// it has its own on/off, 'rechargeHalloweenMusic' ('1'/'0', default on).
import { isHalloween, onThemeChange } from './halloween.js';
import { getAudioPrefs, saveAudioPrefs, onPlayback, mlog } from './bgmedia.js';
import { releaseMedia } from './releasemedia.js';

export const MUSIC_URL = '/assets/halloween-theme.mp3';
const MUSIC_KEY = 'rechargeHalloweenMusic';

export function getMusicOn() {
  try { return localStorage.getItem(MUSIC_KEY) !== '0'; } catch (e) { return true; }
}
export function getMusicVolume() { return getAudioPrefs().volume; }
// The slider shares the playlist volume (bgAudio.volume); saveAudioPrefs re-applies playback, which reaches us through onPlayback.
export function setMusicVolume(v) { saveAudioPrefs({ ...getAudioPrefs(), volume: Math.min(1, Math.max(0, v)) }); }
export function setMusicOn(on) {
  try { localStorage.setItem(MUSIC_KEY, on ? '1' : '0'); } catch (e) {}
  sync();
}

// WebKitGTK's GStreamer can't stream from the app's custom-protocol URL (NotSupportedError, code 4), so the file is fetched
// into a blob once and the element plays that (the same trick the background previews use). One blob URL for the session.
let blobUrl = null;
let blobLoading = null;
function loadBlob() {
  if (blobUrl || blobLoading) return blobLoading;
  blobLoading = fetch(MUSIC_URL).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
    .then((b) => { blobUrl = URL.createObjectURL(b); })
    .catch((e) => { mlog(`halloween music load failed: ${e?.message || e}`); })
    .finally(() => { blobLoading = null; sync(); });
  return blobLoading;
}

let audio = null;
let background = false;
let keepPlaying = false;
let retryArmed = false;

function wanted() {
  return isHalloween() && getMusicOn() && (!background || keepPlaying);
}

function armRetry() {
  if (retryArmed || typeof document === 'undefined') return;
  retryArmed = true;
  const retry = () => {
    retryArmed = false;
    document.removeEventListener('pointerdown', retry, true);
    document.removeEventListener('keydown', retry, true);
    sync();
  };
  document.addEventListener('pointerdown', retry, true);
  document.addEventListener('keydown', retry, true);
}

function sync() {
  if (!isHalloween() || !getMusicOn()) {
    // Off or left the theme: pause now; the element is released only when the theme is left.
    if (audio && !isHalloween()) { releaseMedia(audio); audio = null; }
    else audio?.pause?.();
    return;
  }
  if (!audio) {
    const a = document.createElement('audio');
    a.loop = true;
    a.preload = 'auto';
    a.addEventListener?.('error', () => mlog(`halloween music ERROR code=${a.error?.code}`));
    audio = a;
  }
  if (!audio.src) {
    if (!blobUrl) { loadBlob(); return; } // sync() runs again when the blob is ready
    audio.src = blobUrl;
  }
  audio.volume = getAudioPrefs().volume;
  if (!wanted()) { audio.pause?.(); return; }
  const a = audio;
  if (a.paused === false) return; // already playing
  const p = a.play?.();
  mlog(`halloween music play() volume=${a.volume} loop=${a.loop}`);
  p?.catch?.((err) => { if (audio === a) armRetry(); mlog(`halloween music play() rejected ${err?.name || err}`); });
}

let started = false;
export function startHalloweenMusic() {
  if (started) return;
  started = true;
  onPlayback((s) => { background = s.background; keepPlaying = s.keepPlaying; sync(); });
  onThemeChange(() => sync());
  sync();
}

export function _musicElement() { return audio; }
