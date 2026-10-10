// Pure logic of the playlist editor (no DOM, tested under node).
import { mediaKind, isPosterName, LIMITS_MB } from './media.js';

export const MAX_FOLDER_FILES = 500;

export function newDraft() {
  return { id: null, name: '', interval: 0, sound: 'auto', items: [], publicId: null };
}

export function draftFromPlaylist(p) {
  return {
    id: p.id,
    name: p.name || '',
    interval: p.interval || 0,
    sound: p.sound || 'auto',
    items: [...(p.images || [])],
    publicId: p.public_id || null,
  };
}

export const baseName = (path) => String(path || '').split(/[\\/]/).pop();

// Adds library file names, skipping ones already in the playlist. Returns the number really added.
export function addItems(draft, files) {
  let added = 0;
  for (const f of files) {
    if (!f || isPosterName(f) || draft.items.includes(f)) continue;
    draft.items.push(f);
    added++;
  }
  return added;
}

export function removeItem(draft, index) {
  if (index < 0 || index >= draft.items.length) return;
  const [gone] = draft.items.splice(index, 1);
  if (draft.sound === gone) draft.sound = 'auto';
}

// Moves the item at `from` so it ends up at index `to` (clamped).
export function moveItem(draft, from, to) {
  const n = draft.items.length;
  if (from < 0 || from >= n) return false;
  to = Math.max(0, Math.min(n - 1, to));
  if (to === from) return false;
  const [it] = draft.items.splice(from, 1);
  draft.items.splice(to, 0, it);
  return true;
}

// Sound choices: automatic / off / the video's own / each song that is in this playlist.
export function editorSoundOptions(draft) {
  return [
    ['auto', 'Sound: automatic'],
    ['off', 'Sound: off'],
    ['own', "Sound: the video's own"],
    ...draft.items.filter((f) => mediaKind(f) === 'audio').map((f) => [f, `Sound: ${f}`]),
  ];
}

export function validateDraft(draft) {
  if (!draft.name.trim()) return 'Give the playlist a name.';
  return null;
}

// What gets sent to the backend on Save.
export function savePayload(draft) {
  const sound = draft.sound === 'auto' || draft.sound === 'off' || draft.sound === 'own' || draft.items.includes(draft.sound) ? draft.sound : 'auto';
  return { id: draft.id, name: draft.name.trim(), images: draft.items.filter((f) => !isPosterName(f)), interval: Number(draft.interval) || 0, sound };
}

// Import results -> { added: [library names], skipped: [{ name, reason }] }
export function summarizeImport(results) {
  const added = [];
  const skipped = [];
  for (const r of results) {
    if (r.file_name) added.push(r.file_name);
    else skipped.push({ name: baseName(r.source), reason: r.error || 'could not be added' });
  }
  return { added, skipped };
}

export function progressText(done, total) {
  return `Adding ${Math.min(done + 1, total)} of ${total}...`;
}

export function skippedText(skipped, extra = {}) {
  const lines = [];
  if (skipped.length) {
    const shown = skipped.slice(0, 8).map((s) => `${s.name} (${s.reason})`);
    lines.push(`Skipped ${skipped.length}: ${shown.join(', ')}${skipped.length > 8 ? `, and ${skipped.length - 8} more` : ''}`);
  }
  if (extra.unsupported) lines.push(`${extra.unsupported} file${extra.unsupported === 1 ? '' : 's'} in the folder had an unsupported type`);
  if (extra.truncated) lines.push(`Only the first ${MAX_FOLDER_FILES} files of the folder were used`);
  return lines;
}

export const LIMITS_TEXT = `Limits: pictures ${LIMITS_MB.image} MB, videos ${LIMITS_MB.video} MB, sounds ${LIMITS_MB.audio} MB.`;

// Dialog results come back as a string, an array, or { path } objects.
export function pathsFrom(chosen) {
  if (!chosen) return [];
  const list = Array.isArray(chosen) ? chosen : [chosen];
  return list.map((c) => (typeof c === 'string' ? c : c && c.path)).filter(Boolean);
}
