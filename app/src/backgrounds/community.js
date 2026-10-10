// Community tab data + markup (kept free of DOM so it can be tested under node).
import { escapeHtml, galleryImages } from '../ui.js';
import { releaseMedia } from '../releasemedia.js';
import { isImageAdded, isPlaylistAdded, mediaKind, countsText, placeholderKind } from './media.js';

export const HUB_BASE = 'https://codecade.co.za/recharge';
export const UNSUPPORTED_PLAYLISTS = "The hub doesn't support playlists yet.";
export const UNSUPPORTED_IMAGES = "The hub doesn't support single images yet.";

export const playlistGalleryUrl = (row, file) => `${HUB_BASE}/api/playlists/${encodeURIComponent(row.id)}/gallery/${encodeURIComponent(file)}`;
export const imageThumbUrl = (row) =>
  galleryImages(row.gallery).length
    ? `${HUB_BASE}/api/backgrounds/${encodeURIComponent(row.id)}/gallery/${encodeURIComponent(galleryImages(row.gallery)[0])}`
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

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
// No picture to show: a play icon (videos) or a note (sounds) - never the video itself as an image.
export function placeholderThumb(gallery) {
  const k = placeholderKind(gallery);
  if (!k) return '<div class="browse-card-thumb"></div>';
  return `<div class="browse-card-thumb bg-thumb-ph bg-thumb-${k}">${k === 'video' ? PLAY : NOTE}</div>`;
}

export function playlistCardsHtml(section, mine, isAdded = () => false) {
  if (section.state !== 'ok') return `<div class="empty-state">${escapeHtml(section.message)}</div>`;
  if (!section.rows.length) return '<div class="empty-state">No community playlists yet - make one of yours public!</div>';
  return section.rows
    .map((r) => {
      const pics = galleryImages(r.gallery);
      const n = pics.length;
      const thumb = n
        ? `<div class="browse-card-thumb" style="background-image:url('${playlistGalleryUrl(r, pics[0])}')"></div>`
        : placeholderThumb(r.gallery);
      const added = isAdded(r);
      return `
    <div class="browse-card" data-id="${escapeHtml(r.id)}">
      <div class="browse-card-media">${thumb}${added ? addedBadge : ''}</div>
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(r.name)}</div>
        <div class="browse-card-meta">by ${escapeHtml(r.author || '?')} - ${escapeHtml(countsText(r.gallery))}</div>
      </div>
      <div class="browse-card-actions">
        <span class="browse-card-meta">${mine.has(r.id) ? yours : ''}</span>
      </div>
    </div>`;
    })
    .join('');
}

// ---- Preview box (a playlist's gallery before downloading) ----
// Pictures are <img>; videos are real muted looping <video playsinline> elements (never an <img> / background-image:
// WebKitGTK would decode the video into a huge GPU pool); sounds are a note tile with a play button.
export const MAX_PREVIEW_VIDEOS = 12;
const NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>';

export const galleryMedia = (gallery) =>
  (Array.isArray(gallery) ? gallery : []).map((file) => ({ file, kind: mediaKind(file) })).filter((m) => m.kind);

export function previewTilesHtml(row, urlFn = playlistGalleryUrl) {
  let videos = 0;
  return galleryMedia(row.gallery)
    .map(({ file, kind }) => {
      const url = escapeHtml(urlFn(row, file));
      if (kind === 'image') return `<img loading="lazy" decoding="async" src="${url}" alt="">`;
      if (kind === 'video') {
        // the src is attached by startPreview (only while the box is open, and only for the first few)
        return `<div class="bg-prev-tile bg-prev-video"><video muted loop playsinline preload="metadata" data-src="${url}"${videos++ >= MAX_PREVIEW_VIDEOS ? ' data-skip' : ''}></video></div>`;
      }
      return `<div class="bg-prev-tile bg-prev-audio"><button type="button" class="bg-prev-play" data-audio="${url}" aria-label="Play ${escapeHtml(file)}">${NOTE}<span class="bg-prev-play-icon">&#9654;</span></button><span class="bg-prev-name">${escapeHtml(file)}</span></div>`;
    })
    .join('');
}

// The preview never streams a hub file straight into a <video>/<audio>: WebKitGTK blocks the page for as long as the
// transfer lasts when such an element is torn down (a 21 MB mp4 froze the app for seconds on CLOSE). Each file is fetched
// into a blob (abortable, so closing mid-download costs nothing) and only then handed to the element.
export const MAX_PREVIEW_BYTES = 60 * 1024 * 1024;

async function fetchBlobUrl(url, signal, env) {
  const res = await env.fetchFn(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers?.get?.('content-length')) || 0;
  if (len > MAX_PREVIEW_BYTES) throw new Error('too large to preview');
  const blob = await res.blob();
  if (signal.aborted) throw new Error('aborted');
  return env.createUrl(blob);
}

// Starts the videos of the filled preview grid (one download at a time) and wires the sound buttons. release() lets go
// of EVERYTHING (downloads aborted, videos paused + detached, the sound stopped); call it whenever the box closes or is refilled.
export function startPreview(grid, makeAudio = () => new Audio(), env = {}) {
  env = {
    fetchFn: (...a) => fetch(...a),
    createUrl: (b) => URL.createObjectURL(b),
    revokeUrl: (u) => URL.revokeObjectURL(u),
    ...env,
  };
  const ac = new AbortController();
  const blobUrls = [];
  const keep = (u) => { blobUrls.push(u); return u; };
  let released = false;
  let audio = null;
  let audioAc = null;
  let playing = null;
  const stopAudio = () => {
    audioAc?.abort();
    audioAc = null;
    if (audio) releaseMedia(audio);
    audio = null;
    if (playing) playing.classList?.remove('is-playing');
    playing = null;
  };
  const videos = [...grid.querySelectorAll('video[data-src]')].filter((v) => !v.hasAttribute('data-skip'));
  (async () => {
    for (const v of videos) {
      if (released) return;
      v.parentNode?.classList?.add('is-loading');
      try {
        const u = keep(await fetchBlobUrl(v.dataset.src, ac.signal, env));
        if (released) return;
        v.muted = true;
        v.loop = true;
        v.src = u;
        v.play?.()?.catch?.(() => {});
        v.parentNode?.classList?.remove('is-loading');
      } catch (e) {
        if (released) return;
        v.parentNode?.classList?.remove('is-loading');
        v.parentNode?.classList?.add('is-failed');
      }
    }
  })();
  grid.querySelectorAll('[data-audio]').forEach((btn) => {
    btn.onclick = async () => {
      const same = playing === btn;
      stopAudio();
      if (same) return;
      playing = btn;
      btn.classList?.add('is-playing');
      const mine = (audioAc = new AbortController());
      try {
        const u = keep(await fetchBlobUrl(btn.dataset.audio, mine.signal, env));
        if (released || mine.signal.aborted) return;
        audio = makeAudio();
        audio.src = u;
        audio.loop = true;
        audio.play?.()?.catch?.(() => { if (!released) stopAudio(); });
      } catch (e) {
        if (!released && playing === btn) stopAudio();
      }
    };
  });
  return {
    release() {
      released = true;
      ac.abort();
      stopAudio();
      for (const v of videos) releaseMedia(v);
      grid.innerHTML = '';
      for (const u of blobUrls.splice(0)) { try { env.revokeUrl(u); } catch (e) {} }
    },
  };
}
