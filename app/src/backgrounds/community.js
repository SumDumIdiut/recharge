// Community tab data + markup (kept free of DOM so it can be tested under node).
import { escapeHtml } from '../ui.js';
import { isImageAdded, isPlaylistAdded } from './media.js';

export const HUB_BASE = 'https://codecade.co.za/recharge';
export const UNSUPPORTED_PLAYLISTS = "The hub doesn't support playlists yet.";
export const UNSUPPORTED_IMAGES = "The hub doesn't support single images yet.";

export const playlistGalleryUrl = (row, file) => `${HUB_BASE}/api/playlists/${encodeURIComponent(row.id)}/gallery/${encodeURIComponent(file)}`;
export const imageThumbUrl = (row) =>
  row.gallery?.length
    ? `${HUB_BASE}/api/backgrounds/${encodeURIComponent(row.id)}/gallery/${encodeURIComponent(row.gallery[0])}`
    : `${HUB_BASE}/api/backgrounds/${encodeURIComponent(row.id)}/file`;

async function loadSection(invoke, cmd, unsupportedMsg, what) {
  try {
    const rows = await invoke(cmd);
    return { state: 'ok', rows: Array.isArray(rows) ? rows : [] };
  } catch (err) {
    if (String(err).includes('UNSUPPORTED')) return { state: 'unsupported', message: unsupportedMsg, rows: [] };
    return { state: 'error', message: `Couldn't load community ${what}: ${err}`, rows: [] };
  }
}

// Each section fails on its own: a hub without /api/backgrounds must not break playlists.
export async function loadCommunity(invoke) {
  const [images, playlists, config, library] = await Promise.all([
    loadSection(invoke, 'fetch_hub_backgrounds_cmd', UNSUPPORTED_IMAGES, 'images'),
    loadSection(invoke, 'fetch_hub_playlists_cmd', UNSUPPORTED_PLAYLISTS, 'playlists'),
    invoke('get_backgrounds_config').catch(() => ({})),
    invoke('list_background_images').catch(() => []),
  ]);
  const myPlaylists = new Set((config?.playlists || []).map((p) => p.public_id).filter(Boolean));
  const myImages = new Set(Object.values(config?.image_public || {}));
  const imageAdded = (row) => isImageAdded(row, config, library);
  const playlistAdded = (row) => isPlaylistAdded(row, config || {});
  return { images, playlists, myPlaylists, myImages, imageAdded, playlistAdded, config, library };
}

const yours = '<span class="bg-yours">yours</span>';
const addedBadge = '<span class="badge-added">Added</span>';

export function imageCardsHtml(section, mine, isAdded = () => false) {
  if (section.state !== 'ok') return `<div class="empty-state">${escapeHtml(section.message)}</div>`;
  if (!section.rows.length) return '<div class="empty-state">No community images yet - make one of yours public!</div>';
  return section.rows
    .map(
      (r) => {
      const added = isAdded(r);
      return `
    <div class="browse-card" data-id="${escapeHtml(r.id)}">
      <div class="browse-card-media"><div class="browse-card-thumb" style="background-image:url('${imageThumbUrl(r)}')"></div>${added ? addedBadge : ''}</div>
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(r.name)}</div>
        <div class="browse-card-meta">by ${escapeHtml(r.author || '?')}</div>
      </div>
      <div class="browse-card-actions">
        <span class="browse-card-meta">${mine.has(r.id) ? yours : ''}</span>
        <div class="browse-card-actions-right">${added ? '<button class="btn" data-act="add-image" disabled>Added</button>' : '<button class="btn btn-primary" data-act="add-image">Add</button>'}</div>
      </div>
    </div>`;
      }
    )
    .join('');
}

export function playlistCardsHtml(section, mine, isAdded = () => false) {
  if (section.state !== 'ok') return `<div class="empty-state">${escapeHtml(section.message)}</div>`;
  if (!section.rows.length) return '<div class="empty-state">No community playlists yet - make one of yours public!</div>';
  return section.rows
    .map((r) => {
      const n = (r.gallery || []).length;
      const added = isAdded(r);
      return `
    <div class="browse-card" data-id="${escapeHtml(r.id)}">
      <div class="browse-card-media"><div class="browse-card-thumb"${n ? ` style="background-image:url('${playlistGalleryUrl(r, r.gallery[0])}')"` : ''}></div>${added ? addedBadge : ''}</div>
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(r.name)}</div>
        <div class="browse-card-meta">by ${escapeHtml(r.author || '?')} - ${n} picture${n === 1 ? '' : 's'}</div>
      </div>
      <div class="browse-card-actions">
        <span class="browse-card-meta">${mine.has(r.id) ? yours : ''}</span>
      </div>
    </div>`;
    })
    .join('');
}
