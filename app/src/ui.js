export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function thumb(src, badge) {
  const img = src
    ? `<img class="browse-card-thumb" src="${escapeHtml(src)}" alt="" />`
    : `<div class="browse-card-thumb browse-card-thumb-empty"></div>`;
  return `<div class="browse-card-media">${img}${badge || ''}</div>`;
}

export function openModal(id) {
  document.getElementById(id).hidden = false;
}

export function closeModal(id) {
  document.getElementById(id).hidden = true;
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
