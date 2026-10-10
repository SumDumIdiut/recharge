// Community tab data + markup (kept free of DOM so it can be tested under node).
import { escapeHtml, galleryImages } from '../ui.js';
import { releaseMedia, manualLoop } from '../releasemedia.js';
import { isImageAdded, isPlaylistAdded, mediaKind, countsText, placeholderKind, PLAY_OVERLAY, MAY_NOT_PLAY_TEXT } from './media.js';
import { urlReader, blobReader } from './cover.js';

export const HUB_BASE = 'https://codecade.co.za/recharge';
export const UNSUPPORTED_PLAYLISTS = "The hub doesn't support playlists yet.";
export const UNSUPPORTED_IMAGES = "The hub doesn't support single images yet.";

export const playlistGalleryUrl = (row, file) => `${HUB_BASE}/api/playlists/${encodeURIComponent(row.id)}/gallery/${encodeURIComponent(file)}`;
// Only ever a PICTURE url (a video must never be a CSS background / <img>: WebKitGTK decodes it into a huge GPU pool).
export const imageThumbUrl = (row) => {
  const pic = rowPicture(row, 'background');
  if (pic) return pic.url;
  return mediaKind(row.gallery?.[0]) === 'image' || !row.gallery?.length ? `${HUB_BASE}/api/backgrounds/${encodeURIComponent(row.id)}/file` : null;
};

// Poster pictures of a hub row: { "<original video name | 'file'>": "<poster file>" } -> the file list, in key order.
const posterEntries = (row) => (row?.posters && typeof row.posters === 'object' ? Object.entries(row.posters).filter(([, f]) => typeof f === 'string' && f) : []);
export const rowPosterFile = (row, original) => { const e = posterEntries(row).find(([k]) => k === original); return e ? e[1] : null; };
const galleryUrl = (kind, row, file) => `${HUB_BASE}/api/${kind === 'playlist' ? 'playlists' : 'backgrounds'}/${encodeURIComponent(row.id)}/gallery/${encodeURIComponent(file)}`;

// The picture of a hub card / What's new entry, best first: the first IMAGE of the gallery, else the first poster (a plain JPEG
// of a video), else null. -> { url, poster: boolean } | null. (A card with neither falls back to the cover.js path, see hubVideoSource.)
export function rowPicture(row, kind) {
  const pics = galleryImages(row.gallery);
  if (pics.length) return { url: galleryUrl(kind, row, pics[0]), poster: false };
  const first = posterEntries(row)[0];
  if (first) return { url: galleryUrl(kind, row, first[1]), poster: true };
  return null;
}

// The video a card without a picture can borrow its cover from: { url, key } or null (never when the row has a poster).
export function hubVideoSource(row, kind) {
  if (galleryImages(row.gallery).length || posterEntries(row).length) return null;
  const file = (Array.isArray(row.gallery) ? row.gallery : []).find((f) => mediaKind(f) === 'video');
  if (!file) return null;
  const url = kind === 'playlist' ? playlistGalleryUrl(row, file) : `${HUB_BASE}/api/backgrounds/${encodeURIComponent(row.id)}/file`;
  return { url, key: `${kind}:${row.id}:${file}` };
}

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
      <div class="browse-card-media">${cardThumb(r, 'background')}${added ? addedBadge : ''}</div>
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

// The thumb of a card: its picture (a gallery image, or a poster with a play button over it), else the placeholder.
function cardThumb(r, kind) {
  const pic = rowPicture(r, kind);
  if (pic?.poster) return `<div class="browse-card-thumb bg-thumb-ph bg-thumb-video has-cover" style="background-image:url('${escapeHtml(pic.url)}')">${PLAY_OVERLAY}</div>`;
  if (kind === 'background') return imageThumbUrl(r) ? `<div class="browse-card-thumb" style="background-image:url('${imageThumbUrl(r)}')"></div>` : placeholderThumb(r.gallery, hubVideoSource(r, 'background'));
  return pic ? `<div class="browse-card-thumb" style="background-image:url('${pic.url}')"></div>` : placeholderThumb(r.gallery, hubVideoSource(r, 'playlist'));
}

// No picture to show: a play icon (videos) or a note (sounds) - never the video itself as an image.
// A video card also carries where its cover can be read from (data-cover-*; see fillHubCovers) and a play button over the picture.
export function placeholderThumb(gallery, src = null) {
  const k = placeholderKind(gallery);
  if (!k) return '<div class="browse-card-thumb"></div>';
  const attrs = k === 'video' && src ? ` data-cover-url="${escapeHtml(src.url)}" data-cover-key="${escapeHtml(src.key)}"` : '';
  return `<div class="browse-card-thumb bg-thumb-ph bg-thumb-${k}"${attrs}>${k === 'video' ? PLAY_OVERLAY : NOTE}</div>`;
}

// Gives the video cards a picture: the cover embedded in the video, read one card at a time (cheap range requests; if the
// server only sends whole files, at most 60 MB each). Abortable. env.cover(key, reader) -> { url, mayNotPlay } | null.
export function fillHubCovers(root, env) {
  const ac = new AbortController();
  const els = [...root.querySelectorAll('[data-cover-url]')];
  (async () => {
    for (const el of els) {
      if (ac.signal.aborted) return;
      // the spinner shows only when the cheap Range read didn't work and the whole file is being fetched
      const reader = urlReader(el.dataset.coverUrl, env.fetchFn, { signal: ac.signal, onFallback: () => el.classList?.add?.('is-loading') });
      try {
        const r = await env.cover(el.dataset.coverKey, reader);
        if (ac.signal.aborted || !r?.url) continue;
        applyCover(el, r);
      } catch (e) {
        if (!ac.signal.aborted) console.warn(`[cover] no picture for ${el.dataset.coverKey}: ${e?.message || e}`);
      } finally {
        el.classList?.remove?.('is-loading');
      }
    }
  })();
  return { abort: () => ac.abort() };
}

export function applyCover(el, r) {
  el.style.backgroundImage = `url("${r.url}")`; // a small JPEG made from the cover, never the video
  el.classList.add('has-cover');
  if (r.mayNotPlay) { el.classList.add('may-not-play'); el.title = MAY_NOT_PLAY_TEXT; }
}

export function playlistCardsHtml(section, mine, isAdded = () => false) {
  if (section.state !== 'ok') return `<div class="empty-state">${escapeHtml(section.message)}</div>`;
  if (!section.rows.length) return '<div class="empty-state">No community playlists yet - make one of yours public!</div>';
  return section.rows
    .map((r) => {
      const thumb = cardThumb(r, 'playlist');
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
      if (kind === 'image') return `<img decoding="async" data-src="${url}" alt="">`;
      if (kind === 'video') {
        // the src is attached by startPreview (only while the box is open, and only for the first few)
        // a poster of the hub (a JPEG) is the video's picture from the start; no cover reading is needed then
        const pf = rowPosterFile(row, file);
        const poster = pf ? ` poster="${escapeHtml(galleryUrl('playlist', row, pf))}"` : '';
        return `<div class="bg-prev-tile bg-prev-video${pf ? ' has-cover' : ''}">${PLAY_OVERLAY}<video${poster} muted playsinline preload="metadata" data-key="${escapeHtml(`playlist:${row.id}:${file}`)}" data-src="${url}"${videos++ >= MAX_PREVIEW_VIDEOS ? ' data-skip' : ''}></video></div>`;
      }
      return `<div class="bg-prev-tile bg-prev-audio"><button type="button" class="bg-prev-play" data-audio="${url}" aria-label="Play ${escapeHtml(file)}">${NOTE}<span class="bg-prev-play-icon">&#9654;</span></button><span class="bg-prev-name">${escapeHtml(file)}</span></div>`;
    })
    .join('');
}

// The preview never streams a hub file straight into a <video>/<audio>: WebKitGTK blocks the page for as long as the
// transfer lasts when such an element is torn down (a 21 MB mp4 froze the app for seconds on CLOSE). Each file is fetched
// into a blob (abortable, so closing mid-download costs nothing) and only then handed to the element.
export const MAX_PREVIEW_BYTES = 60 * 1024 * 1024;

async function fetchBlob(url, signal, env) {
  const res = await env.fetchFn(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers?.get?.('content-length')) || 0;
  if (len > MAX_PREVIEW_BYTES) throw new Error('too large to preview');
  const blob = await res.blob();
  if (signal.aborted) throw new Error('aborted');
  return blob;
}
const fetchBlobUrl = async (url, signal, env) => env.createUrl(await fetchBlob(url, signal, env));

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
  // Pictures: no loading="lazy" (inside this scrolling overlay it left every tile but the first empty). startPreview gives
  // them their src itself, in page order, a few at a time, and stops when the box is released.
  const images = [...(grid.querySelectorAll('img[data-src]') || [])];
  const IMG_POOL = 4;
  let nextImg = 0;
  const imgWorker = async () => {
    while (!released && nextImg < images.length) {
      const img = images[nextImg++];
      await new Promise((done) => {
        img.addEventListener?.('load', done, { once: true });
        img.addEventListener?.('error', done, { once: true });
        img.src = img.dataset.src;
        if (!img.addEventListener) done();
      });
    }
  };
  for (let i = 0; i < Math.min(IMG_POOL, images.length); i++) imgWorker();
  const videos = [...grid.querySelectorAll('video[data-src]')].filter((v) => !v.hasAttribute('data-skip'));
  // the poster (cover picture) of every video first - small range reads - so the tiles show a picture while the videos download
  const withCover = async (v, reader) => {
    if (!env.cover || v.poster) return;
    try {
      const r = await env.cover(v.dataset.key, reader);
      if (released || !r?.url) return;
      keep(r.url);
      v.poster = r.url;
      v.parentNode?.classList?.add('has-cover');
      if (r.mayNotPlay) v.parentNode?.classList?.add('may-not-play');
    } catch (e) {}
  };
  (async () => {
    for (const v of videos) { if (released) return; await withCover(v, urlReader(v.dataset.src, env.fetchFn, { signal: ac.signal })); }
    for (const v of videos) {
      if (released) return;
      v.parentNode?.classList?.add('is-loading');
      try {
        const blob = await fetchBlob(v.dataset.src, ac.signal, env);
        const u = keep(env.createUrl(blob));
        if (released) return;
        await withCover(v, blobReader(blob));
        v.muted = true;
        manualLoop(v);
        v.src = u;
        v.play?.()?.catch?.(() => {});
        v.addEventListener?.('playing', () => v.parentNode?.classList?.add('is-ready'), { once: true });
        v.addEventListener?.('error', () => { v.parentNode?.classList?.remove('is-ready'); v.parentNode?.classList?.add('is-failed', 'may-not-play'); }, { once: true });
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
        manualLoop(audio);
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
