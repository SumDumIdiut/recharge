// Pure helpers for the Backgrounds page (no DOM, tested under node).
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const VIDEO_EXTS = ['mp4', 'webm'];
export const AUDIO_EXTS = ['mp3', 'ogg', 'wav'];
export const LIMITS_MB = { image: 15, video: 90, audio: 20 };

// --- poster sidecars: "<video file name>.poster.jpg|png" next to a video. Pictures OF a video, never library items. ---
export const POSTER_RE = /\.poster\.(jpe?g|png)$/i;
export const isPosterName = (name) => POSTER_RE.test(String(name || ''));
export const posterNameFor = (video) => `${video}.poster.jpg`;
// The video a poster file belongs to ("clip.mp4.poster.jpg" -> "clip.mp4"), or null.
export const posterOwner = (name) => (isPosterName(name) ? String(name).replace(POSTER_RE, '') : null);
// A listing without the sidecars.
export const withoutPosters = (names) => (Array.isArray(names) ? names : []).filter((n) => !isPosterName(n));
// A video was renamed / deleted: where its poster goes (null = nothing to do or remove).
export function posterRename(oldName, newName, has) {
  const from = posterNameFor(oldName);
  if (!has(from)) return null;
  return newName ? { from, to: posterNameFor(newName) } : { from, to: null };
}
export const POSTER_WIDTH = 1280;
export const POSTER_QUALITY = 0.82;
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;

export function mediaKind(name) {
  if (isPosterName(name)) return null;
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
}

const IMG_NAME = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
export const fileKind = (name) => (isPosterName(name) ? null : IMG_NAME.test(String(name || '')) ? 'image' : mediaKind(name));

// "34 pictures, 2 videos, 1 sound" (zero kinds left out; "empty" when nothing is playable). Same text on hub cards and local playlists.
export function countsText(files) {
  const c = { image: 0, video: 0, audio: 0 };
  for (const f of Array.isArray(files) ? files : []) { const k = fileKind(f); if (k) c[k]++; }
  const part = (n, one, many) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
  const parts = [...part(c.image, 'picture', 'pictures'), ...part(c.video, 'video', 'videos'), ...part(c.audio, 'sound', 'sounds')];
  return parts.length ? parts.join(' \u00b7 ') : 'empty';
}

// What a thumbnail shows when a playlist has no picture: 'video' (play icon), 'audio' (note) or null.
export function placeholderKind(files) {
  const ks = (Array.isArray(files) ? files : []).map(fileKind);
  if (ks.includes('image')) return null;
  return ks.includes('video') ? 'video' : ks.includes('audio') ? 'audio' : null;
}

export function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Click on an image card: what happens?
//  'none'     - normal mode: a click does nothing (playlists are made in the Playlists tab)
//  'login'    - share mode but not logged in
//  'publish'  - share mode, not shared yet: upload it as public
//  'unpublish'- share mode, shared: make it private
export function cardAction({ shareMode, shared, loggedIn }) {
  if (!shareMode) return 'none';
  if (!loggedIn) return 'login';
  return shared ? 'unpublish' : 'publish';
}

export const SHARE_HINT = 'Click an image to share it - click a shared one to make it private';

export function activeButtonLabel(playlistId, activeId) {
  return playlistId === activeId ? 'Deactivate' : 'Activate';
}

// What set_active_playlist gets when the button is clicked.
export function activeTarget(playlistId, activeId) {
  return playlistId === activeId ? null : playlistId;
}

// The file-name stem a hub image gets when imported (mirrors background_file_name in backgrounds.rs, without the -2 suffix).
export function importedStem(name) {
  const t = String(name || '')
    .split('')
    .map((c) => (/[\p{L}\p{N}\-_ ]/u.test(c) ? c : '_'))
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60);
  return (t || 'background').toLowerCase();
}

const stemOf = (file) => String(file).replace(/\.[^.]+$/, '').replace(/-\d+$/, '').toLowerCase();

// Community image already in the library: by recorded hub id, else by file name.
export function isImageAdded(row, config, images) {
  const hubIds = new Set(Object.values(config?.image_hub || {}));
  if (hubIds.has(row.id)) return true;
  const want = importedStem(row.name);
  return (images || []).some((f) => stemOf(f) === want);
}

// Community playlist already added: by recorded hub id, else by the "name (by author)" label.
export function isPlaylistAdded(row, config) {
  const lists = config?.playlists || [];
  if (lists.some((p) => p.hub_id && p.hub_id === row.id)) return true;
  const label = (row.author || '').trim() ? `${row.name} (by ${row.author})` : row.name;
  return lists.some((p) => p.name === label);
}

// Sound choices of a playlist: auto / off / the video's own / each audio file in the library.
export function soundOptions(images) {
  return [
    ['auto', 'Sound: automatic'],
    ['off', 'Sound: off'],
    ['own', "Sound: the video's own"],
    ...(images || []).filter((f) => mediaKind(f) === 'audio').map((f) => [f, `Sound: ${f}`]),
  ];
}

// Cache key of a stored thumbnail: file name + modification time + size, so a replaced file gets a new one.
export const THUMB_VERSION = 1;
export const THUMB_WIDTH = 480;
export function thumbKey(file, lastModified, size) {
  return `${file}|${lastModified || ''}|${Number(size) || 0}|v${THUMB_VERSION}`;
}
// Keys of the same file are "<file>|..." - used to drop the stale ones when a file changed.
export const thumbPrefix = (file) => `${file}|`;
// Target size of a thumbnail: THUMB_WIDTH wide (never upscaled), aspect kept.
export function thumbSize(w, h, max = THUMB_WIDTH) {
  const width = Math.max(1, Math.min(max, Math.round(w) || max));
  return { width, height: Math.max(1, Math.round(width * ((Number(h) || 1) / (Number(w) || 1)))) };
}

// --- "may not play": codecs the web engine often lacks (AV1 / HEVC / VP9 depend on the installed decoders) ---
const CODEC_TYPES = {
  av01: 'video/mp4; codecs="av01.0.05M.08"',
  hvc1: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  hev1: 'video/mp4; codecs="hev1.1.6.L93.B0"',
  vp09: 'video/mp4; codecs="vp09.00.10.08"',
};
export const codecLabel = (fourcc) => ({ av01: 'AV1', hvc1: 'HEVC', hev1: 'HEVC', vp09: 'VP9', avc1: 'H.264' }[fourcc] || fourcc || '');
// canPlay: (mimeType) => '' | 'maybe' | 'probably' (a <video>.canPlayType); frameReason: why grabbing a frame failed, if it did.
export function mayNotPlay({ codec, frameReason, canPlay }) {
  if (codec && CODEC_TYPES[codec] && typeof canPlay === 'function' && !canPlay(CODEC_TYPES[codec])) return true;
  return /decode|no data|no video/.test(String(frameReason || ''));
}
export const MAY_NOT_PLAY_TEXT = "may not play on this computer";

// Where a video tile's picture comes from, best first: a grabbed frame, the cover embedded in the file, nothing (plain play tile).
export function pictureSource({ frame, cover }) {
  if (frame) return 'frame';
  if (cover) return 'cover';
  return 'none';
}

export const PLAY_OVERLAY = '<span class="bg-play" aria-hidden="true"></span>';

// "Adding... 40%" (just "Adding..." until the size is known)
export const addingText = (percent, total) => (total > 0 && Number.isFinite(percent) ? `Adding... ${Math.max(0, Math.min(100, Math.round(percent)))}%` : 'Adding...');
// The message of a failed invoke (a string, an Error or { message }), never "[object Object]".
export function errText(err) {
  if (!err) return 'something went wrong';
  if (typeof err === 'string') return err;
  return err.message || err.error || JSON.stringify(err);
}
