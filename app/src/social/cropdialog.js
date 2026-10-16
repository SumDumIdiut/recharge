// Square crop / zoom dialog. Resolves with a 256x256 Blob (WebP, or PNG where the engine can't encode WebP), or null when cancelled.
import { AVATAR_SIZE, MIN_ZOOM, MAX_ZOOM, clampOffset, scaleFor, sourceRect, renderToBlob } from './crop.js';

const BOX = 256;

export function openCropDialog(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal crop-modal" role="dialog" aria-modal="true" aria-label="Crop picture">
      <div class="modal-title">Profile picture</div>
      <div class="crop-box"><img alt="" /></div>
      <input class="crop-zoom" type="range" min="${MIN_ZOOM}" max="${MAX_ZOOM}" step="0.01" value="1" aria-label="Zoom" />
      <div class="form-error" role="alert"></div>
      <div class="modal-actions"><button class="btn" data-act="cancel" type="button">Cancel</button><button class="btn btn-primary" data-act="ok" type="button" disabled>Use picture</button></div>
    </div>`;
    const img = overlay.querySelector('img'), box = overlay.querySelector('.crop-box'), zoomEl = overlay.querySelector('.crop-zoom');
    const okBtn = overlay.querySelector('[data-act=ok]'), errEl = overlay.querySelector('.form-error');
    let zoom = 1, ox = 0, oy = 0, drag = null;
    const nat = () => ({ w: img.naturalWidth, h: img.naturalHeight });

    const place = () => {
      const { w, h } = nat();
      if (!w) return;
      const o = clampOffset(w, h, BOX, zoom, ox, oy);
      ox = o.x; oy = o.y;
      const s = scaleFor(w, h, BOX, zoom);
      img.style.transform = `translate(${(BOX - w * s) / 2 + ox}px, ${(BOX - h * s) / 2 + oy}px) scale(${s})`;
    };
    const onDown = (e) => { drag = { x: e.clientX, y: e.clientY, ox, oy }; box.setPointerCapture?.(e.pointerId); };
    const onMove = (e) => { if (!drag) return; ox = drag.ox + e.clientX - drag.x; oy = drag.oy + e.clientY - drag.y; place(); };
    const onUp = () => { drag = null; };
    const onZoom = () => { zoom = Number(zoomEl.value); place(); };
    const onWheel = (e) => { e.preventDefault(); zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom - e.deltaY * 0.002)); zoomEl.value = zoom; place(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };

    function done(result) {
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('wheel', onWheel);
      zoomEl.removeEventListener('input', onZoom);
      document.removeEventListener('keydown', onKey, true);
      img.removeAttribute('src');
      URL.revokeObjectURL(url);
      overlay.remove();
      resolve(result);
    }
    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('wheel', onWheel, { passive: false });
    zoomEl.addEventListener('input', onZoom);
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('[data-act=cancel]').addEventListener('click', () => done(null));
    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      try {
        const { w, h } = nat();
        done(await renderToBlob(img, sourceRect(w, h, BOX, zoom, ox, oy), AVATAR_SIZE, AVATAR_SIZE));
      } catch (e) {
        errEl.textContent = e.message;
        okBtn.disabled = false;
      }
    });
    img.onload = () => { place(); okBtn.disabled = false; };
    img.onerror = () => { errEl.textContent = "Couldn't read that picture."; };
    img.src = url;
    document.body.appendChild(overlay);
  });
}
