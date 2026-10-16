// Account > Profile: avatar upload (square crop), and the decoration editor with a live preview card.
import { escapeHtml } from '../ui.js';
import { profiles } from '../social/api.js';
import { setNameColor } from '../auth.js';
import { avatarHtml, FRAME_PICKER, frameColorCount, safeColor, normalizeGradient, nameStyle } from '../social/avatar.js';
import { profileCardHtml, titleChipsHtml, pickedTitles } from '../social/profile.js';
import { openCropDialog } from '../social/cropdialog.js';
import { coverSource, renderToBlob } from '../social/crop.js';
import { LIMITS } from '../social/validate.js';
import { safeUrl } from '../social/text.js';

export { TITLES, STAFF_TITLES } from '../social/validate.js';
// Name colours can be gradients too (drawn through the letters); these are ready-made ones, in the hub's strict form.
const NAME_GRADIENTS = [
  ['Recharge', 'linear-gradient(90deg, #41f88d, #4aa8ff)'],
  ['Aurora', 'linear-gradient(90deg, #41f88d, #4aa8ff 50%, #c63ed8)'],
  ['Sunset', 'linear-gradient(90deg, #ff9f43, #ff6b6b 50%, #c63ed8)'],
  ['Gold', 'linear-gradient(90deg, #f9d976, #e0b341 50%, #f39c12)'],
  ['Ice', 'linear-gradient(90deg, #e0f7ff, #4aa8ff)'],
  ['Rainbow', 'linear-gradient(90deg, #ff6b6b, #ff9f43 20%, #f9d976 40%, #41f88d 60%, #4aa8ff 80%, #c63ed8)'],
];
const PALETTE = ['#41f88d', '#c63ed8', '#e0b341', '#4aa8ff', '#ff6b6b', '#f9ffe4', '#ff9f43', '#7a7a7a', '#223344', '#141414'];

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Couldn't read that picture.")); };
    img.src = url;
  });
}

export function mountProfileEditor(host, me) {
  let d = { ...me, links: [...(me.links || [])] };
  let dirty = false, bannerPreview = '', previewTimer = 0;
  const admin = !!me.admin;
  // The colours a shape is drawn with in the picker / preview: yours once picked, else its own starting colours.
  const frameColorsFor = (f) => (f.colors ? [...(d.frame_colors || []), ...f.def].slice(0, f.colors) : []);
  const myTitles = () => (Array.isArray(d.titles) ? d.titles : d.title ? [d.title] : []);

  const swatches = (key) => `<div class="deco-row">${PALETTE.map((c) => `<button type="button" class="swatch${safeColor(d[key]) === c ? ' active' : ''}" style="background:${c}" data-k="${key}" data-c="${c}" aria-label="${c}"></button>`).join('')}
    <input type="color" data-k="${key}" value="${safeColor(d[key], '#41f88d').length === 7 ? safeColor(d[key], '#41f88d') : '#41f88d'}" aria-label="Custom colour" />
    <button type="button" class="link-btn" data-clear="${key}">Clear</button></div>`;

  host.innerHTML = `<div class="deco">
    <div class="deco-form">
      <div class="settings-sublabel">Picture</div>
      <div class="acct-avatar-row"><span id="deco-avatar"></span>
        <label class="btn">Change picture<input id="deco-avatar-file" type="file" accept="image/*" hidden /></label>
        <button class="btn" id="deco-avatar-clear" type="button">Remove</button></div>
      <div class="settings-sublabel">Banner</div>
      <div class="deco-row" id="deco-banner-col"></div>
      <div class="deco-row" style="margin-top:8px"><label class="btn">Banner image<input id="deco-banner-file" type="file" accept="image/*" hidden /></label><button class="btn" id="deco-banner-clear" type="button">Remove image</button></div>
      <div class="settings-sublabel">Accent colour</div><div id="deco-accent"></div>
      <div class="settings-sublabel">Name colour</div><div id="deco-name"></div>
      <div class="settings-sublabel">Frame</div>
      <div class="deco-row" id="deco-frames"></div>
      <div class="deco-fcolors" id="deco-fcolors"></div>
      ${admin
        ? `<div class="form-field" style="margin-top:14px">Titles <div id="deco-titles">${titleChipsHtml(myTitles())}</div></div>`
        : `<div class="form-field" style="margin-top:14px">Titles <div class="deco-title-ro">${myTitles().length ? myTitles().map((t) => escapeHtml(t)).join(', ') : 'None yet'} <span class="deco-note">Titles are given by staff.</span></div></div>`}
      <label class="form-field">Pronouns <input class="form-input" id="deco-pron" maxlength="${LIMITS.pronouns}" /></label>
      <label class="form-field">Bio <textarea class="form-input" id="deco-bio" rows="3" maxlength="${LIMITS.bio}" style="font:inherit"></textarea></label>
      <div class="form-field">Links (http/https, up to ${LIMITS.links})
        ${[0, 1, 2].map((i) => `<input class="form-input deco-link" data-i="${i}" maxlength="200" placeholder="https://..." />`).join('')}</div>
      <div class="deco-actions"><button class="btn btn-primary" id="deco-save" type="button">Save profile</button><span class="img-strip-hint">You can also paste a picture (Ctrl+V).</span><span class="form-error" id="deco-err" role="alert"></span></div>
    </div>
    <div class="deco-preview" id="deco-preview"></div>
  </div>`;
  const $ = (id) => host.querySelector('#' + id);
  const err = (m, ok = false) => { const e = $('deco-err'); e.textContent = m || ''; e.style.color = ok ? 'var(--green)' : ''; };

  const paintAll = () => {
    $('deco-avatar').innerHTML = avatarHtml({ username: d.username, avatar: d.avatar_url, frame: d.frame, accent: d.accent_color }, 72, { clickable: false });
    $('deco-banner-col').innerHTML = swatches('banner_color');
    $('deco-accent').innerHTML = swatches('accent_color');
    $('deco-name').innerHTML = swatches('name_color') + `<div class="deco-row deco-grads">${NAME_GRADIENTS.map(([label, g]) => `<button type="button" class="swatch swatch-grad${d.name_color === g ? ' active' : ''}" style="background:${g}" data-k="name_color" data-c="${g}" title="${label}" aria-label="${label} gradient"></button>`).join('')}
      <input class="form-input deco-grad" id="deco-grad" spellcheck="false" placeholder="linear-gradient(90deg, #41f88d, #c63ed8)" value="${normalizeGradient(d.name_color) ? escapeHtml(d.name_color) : ''}" aria-label="Custom gradient" /></div>`;
    // Each shape is shown in your current colours, so you see what you'd get.
    $('deco-frames').innerHTML = FRAME_PICKER.map((f, i) => `<button type="button" class="frame-pick${(d.frame || 'none') === f.id ? ' active' : ''}" data-frame="${f.id}" aria-label="Frame ${i + 1}">${avatarHtml({ username: d.username, avatar: d.avatar_url, frame: f.id, frame_colors: frameColorsFor(f) }, 40, { clickable: false })}</button>`).join('');
    // The shape you picked takes one or two colours: pick them here.
    const n = frameColorCount(d.frame);
    $('deco-fcolors').innerHTML = Array.from({ length: n }, (_, k) => {
      const cur = (d.frame_colors || [])[k] || '#41f88d';
      return `<div class="deco-row"><span class="deco-fc-label">Colour ${k + 1}</span>${PALETTE.map((c) => `<button type="button" class="swatch${cur === c ? ' active' : ''}" style="background:${c}" data-fc="${k}" data-c="${c}" aria-label="${c}"></button>`).join('')}
        <input type="color" data-fc-input="${k}" value="${cur}" aria-label="Custom colour ${k + 1}" /></div>`;
    }).join('');
    paintPreview();
  };
  const paintPreview = () => { $('deco-preview').innerHTML = profileCardHtml({ ...d, _bannerPreview: bannerPreview }, { preview: true }); };

  $('deco-pron').value = d.pronouns || '';
  $('deco-bio').value = d.bio || '';
  host.querySelectorAll('.deco-link').forEach((el) => { el.value = d.links[Number(el.dataset.i)] || ''; });
  paintAll();

  const setKey = (k, v) => { d[k] = v || null; dirty = true; paintAll(); };
  const onClick = async (e) => {
    const chip = e.target.closest?.('#deco-titles .title-chip');
    if (chip) { chip.classList.toggle('on'); chip.setAttribute('aria-pressed', chip.classList.contains('on')); d.titles = pickedTitles($('deco-titles')); d.title = d.titles[0] || null; dirty = true; paintPreviewOnly(); return; }
    // Frame colour swatches look like the other swatches, so they're checked first.
    const fc = e.target.closest('[data-fc]');
    if (fc) { d.frame_colors = [...(d.frame_colors || [])]; d.frame_colors[Number(fc.dataset.fc)] = fc.dataset.c; dirty = true; return paintAll(); }
    const sw = e.target.closest('.swatch');
    if (sw) return setKey(sw.dataset.k, sw.dataset.c);
    const cl = e.target.closest('[data-clear]');
    if (cl) return setKey(cl.dataset.clear, null);
    const fr = e.target.closest('[data-frame]');
    if (fr) {
      d.frame = fr.dataset.frame;
      const f = FRAME_PICKER.find((x) => x.id === d.frame);
      if (f?.colors) d.frame_colors = frameColorsFor(f);
      dirty = true; return paintAll();
    }
    if (e.target.id === 'deco-save') return save(e.target);
    if (e.target.id === 'deco-avatar-clear') {
      try { await profiles.clearAvatar(); d.avatar_url = null; paintAll(); err('Picture removed.', true); } catch (x) { err(x.message); }
    }
    if (e.target.id === 'deco-banner-clear') {
      try { await profiles.clearBanner(); d.banner_url = null; bannerPreview = ''; paintAll(); err('Banner image removed.', true); } catch (x) { err(x.message); }
    }
  };
  const onInput = (e) => {
    const t = e.target;
    if (t.type === 'color' && t.dataset.fcInput !== undefined) { d.frame_colors = [...(d.frame_colors || [])]; d.frame_colors[Number(t.dataset.fcInput)] = t.value; dirty = true; paintPreviewOnly(); return; }
    if (t.type === 'color') { d[t.dataset.k] = t.value; dirty = true; paintPreviewOnly(); }
    else if (t.id === 'deco-grad') {
      const g = normalizeGradient(t.value);
      t.classList.toggle('is-bad', !!t.value.trim() && !g);
      if (!g) return;
      d.name_color = g; dirty = true; paintPreviewOnly(); return;
    }
    else if (t.id === 'deco-pron') d.pronouns = t.value;
    else if (t.id === 'deco-bio') d.bio = t.value;
    else if (t.classList.contains('deco-link')) d.links[Number(t.dataset.i)] = t.value.trim();
    else return;
    dirty = true;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(paintPreview, 120); // typing never waits on a redraw of the card
  };
  const paintPreviewOnly = () => paintPreview();
  const onPaste = (e) => {
    if (!host.offsetParent) return; // account tab not showing
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    useAvatar(f);
  };
  async function useAvatar(f) {
    err('');
    try {
      const blob = await openCropDialog(f);
      if (!blob) return;
      const r = await profiles.setAvatar(new File([blob], 'avatar.' + (blob.type === 'image/webp' ? 'webp' : 'png'), { type: blob.type }));
      d.avatar_url = r.avatar_url;
      paintAll();
      err('Picture updated.', true);
    } catch (x) { err(x.message); }
  }
  const onChange = async (e) => {
    if (e.target.dataset?.fcInput !== undefined) return paintAll(); // a custom frame colour was settled: redraw the grid in it
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    err('');
    try {
      if (e.target.id === 'deco-avatar-file') {
        const blob = await openCropDialog(f);
        if (!blob) return;
        const r = await profiles.setAvatar(new File([blob], 'avatar.' + (blob.type === 'image/webp' ? 'webp' : 'png'), { type: blob.type }));
        d.avatar_url = r.avatar_url;
        paintAll();
        err('Picture updated.', true);
      } else if (e.target.id === 'deco-banner-file') {
        const { img, url } = await loadImage(f);
        try {
          const blob = await renderToBlob(img, coverSource(img.naturalWidth, img.naturalHeight, 800, 200), 800, 200);
          const r = await profiles.setBanner(new File([blob], 'banner.' + (blob.type === 'image/webp' ? 'webp' : 'png'), { type: blob.type }));
          d.banner_url = r.banner_url;
          paintAll();
          err('Banner image updated.', true);
        } finally { URL.revokeObjectURL(url); }
      }
    } catch (x) { err(x.message); }
  };
  async function save(btn) {
    const links = d.links.map((l) => String(l || '').trim()).filter(Boolean);
    if (links.some((l) => !safeUrl(l))) return err('Links must start with http:// or https://');
    btn.disabled = true;
    try {
      const r = await profiles.save({
        banner_color: d.banner_color || null, accent_color: d.accent_color || null, name_color: d.name_color || null,
        frame: d.frame || 'none', frame_colors: frameColorCount(d.frame) ? (d.frame_colors || []).slice(0, frameColorCount(d.frame)) : null, ...(admin && $('deco-titles') ? { titles: pickedTitles($('deco-titles')) } : {}), bio: d.bio || '', pronouns: d.pronouns || null, links,
      });
      d = { ...d, ...r, links: [...(r.links || [])] };
      setNameColor(r.name_color || '');
      dirty = false;
      paintAll();
      err('Saved.', true);
    } catch (x) { err(x.message); } finally { btn.disabled = false; }
  }
  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  host.addEventListener('change', onChange);
  document.addEventListener('paste', onPaste);
  return { get dirty() { return dirty; }, destroy() { clearTimeout(previewTimer); host.removeEventListener('click', onClick); host.removeEventListener('input', onInput); host.removeEventListener('change', onChange); document.removeEventListener('paste', onPaste); host.innerHTML = ''; } };
}
