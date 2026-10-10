export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16"/><circle cx="9" cy="10" r="1.8"/><path d="M3 18l6-5 4 3 3-2 5 4"/></svg>';

export function thumb(src, badge) {
  const img = src
    ? `<img class="browse-card-thumb" src="${escapeHtml(src)}" alt="" />`
    : `<div class="browse-card-thumb browse-card-thumb-empty">${ICON_IMAGE}</div>`;
  return `<div class="browse-card-media">${img}${badge || ''}</div>`;
}

export function openModal(id) {
  document.getElementById(id).hidden = false;
}

export function closeModal(id) {
  document.getElementById(id).hidden = true;
}

// Asks before something irreversible: the confirm button stays disabled until the name is retyped in full (a window.confirm is one stray Enter from deleting an upload).
export function confirmDestructive({ title, body, confirmLabel, name }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <p>${escapeHtml(body)}</p>
          <label class="form-field">Type <strong>${escapeHtml(name)}</strong> to confirm
            <input class="form-input" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(name)}" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel" type="button">Cancel</button>
          <button class="btn btn-danger" data-act="ok" type="button" disabled>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('input');
    const ok = overlay.querySelector('[data-act="ok"]');
    const done = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };

    const check = () => { ok.disabled = input.value.trim() !== name; };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); done(true); }
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);

    input.focus();
    input.select();
  });
}

// Cycles a badge button through install -> installing -> done/failed.
export function setBadgeState(btn, state, installClass = 'badge-install') {
  if (state === 'installing') {
    btn.classList.remove(installClass, 'badge-update');
    btn.classList.add('is-installing');
    btn.innerHTML = ICON_SPINNER;
  } else if (state === 'done') {
    btn.classList.remove('is-installing');
    btn.classList.add('is-done');
    btn.innerHTML = ICON_CHECK;
  } else if (state === 'failed') {
    btn.classList.remove('is-installing', 'is-done');
    btn.classList.add(installClass);
    btn.innerHTML = ICON_DOWNLOAD;
  }
}

export const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
export const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>';
export const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h10l1-13"/></svg>';
export const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
export const ICON_SPINNER = '<svg class="spinner" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="42 14"/></svg>';

// Gallery entries can be videos (a playlist's .mp4). Put one in an <img> or a CSS background and WebKitGTK decodes it
// through GStreamer into a ~11 GB GPU pool, so only these extensions ever reach an image slot.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
export const isImageName = (name) => IMAGE_EXT.test(String(name || ''));
export const galleryImages = (gallery) => (Array.isArray(gallery) ? gallery : []).filter((n) => isImageName(n) && !/\.poster\.(jpe?g|png)$/i.test(n)); // a poster is a picture of a video, not a gallery picture
