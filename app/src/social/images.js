// Attached-image strip for the composers: choose, paste from the clipboard, preview, remove. Object URLs are revoked on removal and destroy().
import { escapeHtml } from '../ui.js';
import { IMAGE_TYPES, validateImages } from './validate.js';

export function createImageStrip(host, { max = 4, pasteTarget = null, onChange = () => {}, onError = () => {} } = {}) {
  let items = []; // { file, url }
  host.classList.add('img-strip');
  host.innerHTML = `<div class="img-strip-items"></div>
    <label class="btn img-strip-add">Attach image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden /></label>
    <span class="img-strip-hint">or paste (Ctrl+V)</span>`;
  const itemsEl = host.querySelector('.img-strip-items');
  const input = host.querySelector('input[type=file]');
  const addLabel = host.querySelector('.img-strip-add');

  const paint = () => {
    itemsEl.innerHTML = items.map((it, i) => `<div class="img-strip-item"><img src="${escapeHtml(it.url)}" alt="" /><button type="button" class="img-strip-x" data-i="${i}" title="Remove" aria-label="Remove image">&times;</button></div>`).join('');
    addLabel.style.display = items.length >= max ? 'none' : '';
    onChange(items.map((i) => i.file));
  };
  function add(files) {
    const incoming = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!incoming.length && files.length) { onError('Images must be PNG, JPEG, GIF or WebP.'); return; }
    for (const f of incoming) {
      if (items.length >= max) { onError(`At most ${max} image${max === 1 ? '' : 's'}.`); break; }
      const bad = validateImages([f], max);
      if (bad) { onError(bad); continue; }
      items.push({ file: f, url: URL.createObjectURL(f) });
      onError('');
    }
    paint();
  }
  const onPick = () => { add(input.files); input.value = ''; };
  const onRemove = (e) => {
    const b = e.target.closest('.img-strip-x');
    if (!b) return;
    const [gone] = items.splice(Number(b.dataset.i), 1);
    if (gone) URL.revokeObjectURL(gone.url);
    onError('');
    paint();
  };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };
  input.addEventListener('change', onPick);
  itemsEl.addEventListener('click', onRemove);
  pasteTarget?.addEventListener('paste', onPaste);
  paint();
  return {
    get files() { return items.map((i) => i.file); },
    add,
    clear() { for (const it of items) URL.revokeObjectURL(it.url); items = []; paint(); },
    destroy() {
      for (const it of items) URL.revokeObjectURL(it.url);
      items = [];
      input.removeEventListener('change', onPick);
      itemsEl.removeEventListener('click', onRemove);
      pasteTarget?.removeEventListener('paste', onPaste);
      host.innerHTML = '';
    },
  };
}

// Click-to-enlarge: one overlay, closed by click / Escape; the listener is removed on close.
export function openLightbox(src) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay lightbox';
  ov.innerHTML = `<img src="${escapeHtml(src)}" alt="" />`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
}
