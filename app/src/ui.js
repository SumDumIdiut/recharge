export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16"/><circle cx="9" cy="10" r="1.8"/><path d="M3 18l6-5 4 3 3-2 5 4"/></svg>';

export function thumb(src, badge, extra) {
  const img = src
    ? `<img class="browse-card-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`
    : `<div class="browse-card-thumb browse-card-thumb-empty">${ICON_IMAGE}</div>`;
  return `<div class="browse-card-media">${img}${badge || ''}${extra || ''}</div>`;
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

// A two-step delete on the button itself: the first click turns it into a red "Delete?" button for a few seconds (or until
// the pointer leaves it), the second click goes ahead. Returns true on the confirming click.
export function armConfirm(btn, label = 'Delete?') {
  if (!btn) return false;
  if (btn._armed) { btn._armed.reset(); return true; }
  const was = btn.innerHTML, title = btn.title;
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    btn.removeEventListener('mouseleave', leave);
    btn._armed = null;
    btn.classList.remove('is-armed');
    btn.innerHTML = was;
    btn.title = title;
  };
  const leave = () => { clearTimeout(timer); timer = setTimeout(reset, 1200); };
  btn._armed = { reset };
  btn.classList.add('is-armed');
  btn.textContent = label;
  btn.title = 'Click again to delete';
  btn.addEventListener('mouseleave', leave);
  timer = setTimeout(reset, 4000);
  return false;
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

// Keyed list updates. Each card is an html string whose root carries data-k="<key>". reconcile() decides, from the previous and next
// cards, which existing nodes can stay exactly as they are (same key, same html) - pure, so it is testable without a DOM.
// Returns { reuse: [prevIndex | -1 per next card], remove: [prevIndex...] }.
export function cardKey(html, i = 0) {
  const m = /data-k="([^"]*)"/.exec(String(html).slice(0, 400));
  return m ? m[1] : '#' + i;
}
export function reconcile(prev, next) {
  const byKey = new Map();
  prev.forEach((c, i) => { if (!byKey.has(c.key)) byKey.set(c.key, i); });
  const used = new Set();
  const reuse = next.map((c) => {
    const i = byKey.get(c.key);
    if (i === undefined || used.has(i) || prev[i].html !== c.html) return -1;
    used.add(i);
    return i;
  });
  const remove = prev.map((_, i) => i).filter((i) => !used.has(i));
  return { reuse, remove };
}

// Fills `el` with cards (html strings with data-k), touching only what changed: cards whose html is unchanged keep their node
// (and so their decoded pictures and scroll position), the rest are replaced, new ones inserted, gone ones removed.
// With no cards, shows emptyHtml (unchanged text is left alone).
export function patchCards(el, htmls, emptyHtml = '') {
  if (!el) return;
  if (!htmls.length) {
    if (el._cards || el._emptyHtml !== emptyHtml || el.firstElementChild !== el._emptyFirst) {
      el.innerHTML = emptyHtml;
      el._emptyHtml = emptyHtml;
      el._emptyFirst = el.firstElementChild;
    }
    el._cards = null;
    return;
  }
  const seen = new Map();
  const next = htmls.map((html, i) => {
    let key = cardKey(html, i);
    const n = seen.get(key) || 0; seen.set(key, n + 1);
    if (n) key += '~' + n;
    return { key, html };
  });
  const prev = el._cards;
  // Anything else having touched the element's children since last time: start over.
  if (!prev || el.children.length !== prev.length || prev.some((c, i) => el.children[i] !== c.node)) {
    el.innerHTML = htmls.join('');
    if (el.children.length === next.length) {
      next.forEach((c, i) => { c.node = el.children[i]; });
      el._cards = next;
    } else el._cards = null;
    el._emptyHtml = null;
    return;
  }
  const { reuse, remove } = reconcile(prev, next);
  const scratch = document.createElement('div');
  for (const i of remove) prev[i].node.remove();
  next.forEach((c, i) => {
    if (reuse[i] >= 0) c.node = prev[reuse[i]].node;
    else { scratch.innerHTML = c.html; c.node = scratch.firstElementChild; }
  });
  next.forEach((c, i) => { if (el.children[i] !== c.node) el.insertBefore(c.node, el.children[i] || null); });
  el._cards = next;
}
