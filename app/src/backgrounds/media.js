// Pure helpers for the Backgrounds page (no DOM, tested under node).
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const VIDEO_EXTS = ['mp4', 'webm'];
export const AUDIO_EXTS = ['mp3', 'ogg', 'wav'];
export const LIMITS_MB = { image: 15, video: 90, audio: 20 };

export function mediaKind(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
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
