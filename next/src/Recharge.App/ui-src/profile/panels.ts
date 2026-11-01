/** The editor's option panels (one per category). Each builds rows from the draft through the editor context. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { button } from '../components/button.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { describeError } from '../bridge.js';
import { FRAME_PICKER, libraryKind, type Profile } from '../community/format.js';
import { forgetImage, hubForm, hubImage, hubJson } from '../community/api.js';
import { KIND_LABEL, type Kind } from '../lib/library.js';
import { loadKind } from '../lib/hub.js';
import { validateImages, LIM as HUB_LIM } from '../community/format.js';
import { exportStyle, importStyle, MAX_CODE } from './codec.js';
import {
  colorRow, group, iconButton, multiRow, plainColorRow, row, segmentedRow, selectRow, sliderRow, sortable, stopsRow, textRow, toggleRow,
  type Ctx,
} from './controls.js';
import { applyPreset, dominantColors, paletteStyle, PRESETS, randomStyle, type Preset } from './presets.js';
import {
  ANIMS, BANNER_MODES, BGS, CARDS, CORNERS, EFFECTS, FONTS, FRIENDS_VIS, GLOWS, HEIGHTS, KINDS, LIMITS, ORNAMENTS, PATTERNS, PRESENCE_VIS,
  PROFILE_VIS, SHAPES, SPACINGS, STAT_IDS, STAT_STYLES, STATUS_STYLES, WEIGHTS, defaultExt, frameColorCount, httpsUrl, move, sanitize,
  type Ext,
} from './schema.js';
import { applySiteIcon, avatarNode, linkInfo } from './render.js';
import { EXCLUSIVE_ANIMS, EXCLUSIVE_FRAMES, SIGNATURE_PRESETS, ownsStyle } from './exclusive.js';
import { currentUser } from '../account/session.js';

export interface Env {
  ctx: Ctx;
  hub(): Profile;
  /** Replace the whole draft (preset, import) as one undo step. */
  replace(next: Ext): void;
  /** The hub's pictures changed (uploaded or removed): repaint the preview. */
  picturesChanged(): void;
}

export interface Category {
  id: string;
  label: string;
  icon: string;
  build(env: Env): HTMLElement[];
}

const SINGULAR: Record<string, string> = { maps: 'map', mods: 'mod', skins: 'skin', backgrounds: 'background', playlists: 'playlist', games: 'game' };

/* ---------------- pictures ---------------- */

function pictureRow(env: Env, kind: 'avatar' | 'banner', label: string, maxBytes: number): HTMLElement {
  const box = h('div', { className: 'pe-inline' });
  const input = h('input', { attrs: { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' } });
  input.hidden = true;
  const message = h('span', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const path = (): string | null => (kind === 'avatar' ? env.hub().author.avatar_url : env.hub().bannerUrl);
  const set = (value: string | null): void => {
    forgetImage(path());
    if (kind === 'avatar') env.hub().author.avatar_url = value; else env.hub().bannerUrl = value;
    env.picturesChanged();
  };
  const show = (text: string | null): void => { message.hidden = !text; message.textContent = text ?? ''; };
  const pick = button('Upload ' + label, { kind: 'secondary', icon: 'image', onClick: () => input.click() });
  const remove = button('Remove', { kind: 'ghost', onClick: () => {
    remove.disabled = true;
    hubJson('DELETE', '/api/me/' + kind).then(() => { set(null); toast(label + ' removed.', 'success'); env.ctx.rebuild(); }, (e) => show(describeError(e))).finally(() => { remove.disabled = false; });
  } });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const problem = validateImages([file], 1, maxBytes);
    if (problem) { show(problem); return; }
    show(null);
    pick.disabled = true;
    hubForm<{ avatar_url?: string; banner_url?: string }>('POST', '/api/me/' + kind, {}, [{ field: 'image', file }])
      .then((reply) => {
        const p = (kind === 'avatar' ? reply.avatar_url : reply.banner_url) || null;
        set(p ? p.replace(/^https?:\/\/[^/]+(?:\/[^/]+)?(?=\/api\/)/, '') : null);
        if (kind === 'banner') env.ctx.change((e) => { e.banner.mode = 'image'; });
        toast(label + ' updated.', 'success');
        env.ctx.rebuild();
      }, (e) => show(describeError(e)))
      .finally(() => { pick.disabled = false; });
  });
  box.append(pick, remove, input, h('span', { className: 'dim', text: 'up to ' + Math.round(maxBytes / 1048576) + ' MB' }), message);
  return row(label + ' picture', 'Uploads straight to your Recharge account.', box, 'photo upload image');
}

/* ---------------- presets ---------------- */

function swatch(preset: Preset, active: boolean, onPick: () => void): HTMLElement {
  const b = h('button', { className: 'pe-preset' + (active ? ' is-on' : ''), title: preset.label, attrs: { type: 'button', 'aria-pressed': active ? 'true' : 'false' } });
  const art = h('span', { className: 'pe-preset-art' });
  art.style.setProperty('--s1', preset.swatch[0]);
  art.style.setProperty('--s2', preset.swatch[1]);
  art.style.setProperty('--s3', preset.swatch[2]);
  // Just the swatch: the name stays as the tooltip and the accessible label.
  b.setAttribute('aria-label', preset.label);
  b.append(art);
  b.addEventListener('click', onPick);
  return b;
}

async function avatarColors(path: string | null): Promise<string[] | null> {
  if (!path) return null;
  const url = await hubImage(path);
  if (!url) return null;
  const image = new Image();
  image.src = url;
  try { await image.decode(); } catch { return null; }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(image, 0, 0, 48, 48);
  return dominantColors(g.getImageData(0, 0, 48, 48).data, 3);
}

function presetsPanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const actions = h('div', { className: 'pe-inline' });
  actions.append(
    button('Random look', { kind: 'secondary', icon: 'refresh', onClick: () => env.replace(applyPreset(ctx.get(), randomStyle())) }),
    button('Match my avatar', { kind: 'secondary', icon: 'image', onClick: () => {
      avatarColors(env.hub().author.avatar_url).then((colors) => {
        if (!colors || colors.length === 0) { toast(env.hub().author.avatar_url ? 'Could not read colours from your avatar.' : 'Upload an avatar first.', 'error'); return; }
        env.replace(applyPreset(ctx.get(), paletteStyle(colors)));
        toast('Matched ' + colors.length + ' colours from your avatar.', 'success');
      });
    } })
  );
  const grid = h('div', { className: 'pe-presets' });
  // Your own signature presets first (only their owner sees them), then the shared ones.
  const mine = SIGNATURE_PRESETS.filter((x) => ownsStyle(x.owner, currentUser()?.username)).map((x) => x.preset as Preset);
  for (const preset of [...mine, ...PRESETS]) grid.appendChild(swatch(preset, ctx.get().theme.preset === preset.id, () => env.replace(applyPreset(ctx.get(), preset))));
  return [
    group('Quick looks', row('Generate', 'Applies colours, effects, frame, banner and card in one go. Your words are never touched.', actions, 'random match avatar palette')),
    group('Theme presets (' + PRESETS.length + ')', row('Pick a preset', 'You can change anything afterwards.', grid, PRESETS.map((p) => p.label).join(' '))),
  ];
}

/* ---------------- name ---------------- */

function namePanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const n = (): Ext['name'] => ctx.get().name;
  const rows: HTMLElement[] = [
    segmentedRow(ctx, 'Colour', 'Default keeps your hub colour.', [{ value: 'default', label: 'Default' }, { value: 'solid', label: 'One colour' }, { value: 'gradient', label: 'Gradient' }], () => n().mode, (e, v) => { e.name.mode = v; if (v === 'gradient' && e.name.colors.length < 2) e.name.colors = [e.name.colors[0] ?? '#41f88d', '#c63ed8']; }, 'name solid gradient colour color', true),
  ];
  if (n().mode === 'solid') rows.push(plainColorRow(ctx, 'Name colour', '', () => n().colors[0], (e, v) => { e.name.colors[0] = v; }, 'name:c0', 'color'));
  if (n().mode === 'gradient') {
    rows.push(stopsRow(ctx, 'Gradient colours', 'Up to 4 stops.', () => n().colors, (e, v) => { e.name.colors = v; }, 2, LIMITS.nameStops, 'name:stops', 'stops'));
    rows.push(sliderRow(ctx, 'Gradient angle', '', 0, 360, 5, '°', () => n().angle, (e, v) => { e.name.angle = v; }, 'name:angle', 'direction'));
  }
  const effects = group('Effects', 
    multiRow(ctx, 'Effects', 'Mix as many as you like. Animated ones stop for people who ask their system for reduced motion.', EFFECTS, () => n().effects, (e, v) => { e.name.effects = v; }, 'shimmer glow outline pixel shadow rainbow pulse animation'),
    colorRow(ctx, 'Effect colour', 'The glow, outline and shadow colour.', () => n().effectColor, (e, v) => { e.name.effectColor = v; }, '#ffffff', 'name:fx', 'glow outline shadow'));
  const type = group('Type',
    selectRow(ctx, 'Font', 'VT323 is the app font; the rest are system fonts, so they look slightly different per computer.', FONTS, () => n().font, (e, v) => { e.name.font = v; }, 'typeface'),
    segmentedRow(ctx, 'Weight', '', WEIGHTS, () => n().weight, (e, v) => { e.name.weight = v; }, 'bold'),
    segmentedRow(ctx, 'Letter spacing', '', SPACINGS, () => n().spacing, (e, v) => { e.name.spacing = v; }, 'tracking kerning'));
  return [group('Name colour', ...rows), effects, type];
}

/* ---------------- avatar ---------------- */

/** The frames as tiles: each is your avatar (shape, colours, picture) wearing that frame, so you see it before you pick. */
function frameGrid(env: Env, set: (e: Ext, v: string) => void): HTMLElement {
  const { ctx } = env;
  const me = currentUser()?.username;
  // Your own signature frames first (only their owner gets them), then the shared frames.
  const own = Object.entries(EXCLUSIVE_FRAMES).filter(([, x]) => ownsStyle(x.owner, me)).map(([id, x]) => ({ id, label: x.label, colors: 0 }));
  const frames = [...own, ...FRAME_PICKER];
  const current = (): string => (frames.some((f) => f.id === ctx.get().avatar.frame) ? ctx.get().avatar.frame : 'none');
  const grid = h('div', { className: 'pe-frames', attrs: { role: 'radiogroup', 'aria-label': 'Frame' } });
  const author = env.hub().author;
  for (const f of frames) {
    const b = h('button', { className: 'pe-frame' + (f.id === current() ? ' is-on' : ''), title: f.label,
      attrs: { type: 'button', role: 'radio', 'aria-checked': f.id === current() ? 'true' : 'false', 'aria-label': f.label } });
    const style = { ...ctx.get().avatar, frame: f.id };
    b.appendChild(avatarNode({
      username: author.username, frame: f.id, frameColors: style.frameColors, nameColor: author.name_color,
      avatarPath: author.avatar_url, size: 52, style, load: hubImage,
    }));
    b.appendChild(h('span', { className: 'pe-frame-name', text: f.label }));
    b.addEventListener('click', () => { ctx.change((e) => set(e, f.id)); ctx.rebuild(); });
    grid.appendChild(b);
  }
  return row('Frame', FRAME_PICKER.length + ' frame styles. Each tile shows your avatar wearing it.', grid, 'ring border ' + FRAME_PICKER.map((f) => f.label).join(' '));
}

function avatarPanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const a = (): Ext['avatar'] => ctx.get().avatar;
  const frameRows: HTMLElement[] = [
    frameGrid(env, (e, v) => {
      e.avatar.frame = v;
      const need = frameColorCount(v);
      const fallback = [e.theme.accent ?? e.name.colors[0] ?? '#41f88d', e.name.colors[1] ?? '#c63ed8'];
      while (e.avatar.frameColors.length < need) e.avatar.frameColors.push(fallback[e.avatar.frameColors.length]);
    }),
  ];
  const count = frameColorCount(a().frame);
  for (let i = 0; i < count; i++) frameRows.push(plainColorRow(ctx, 'Frame colour ' + (i + 1), '', () => a().frameColors[i] ?? '#41f88d', (e, v) => { e.avatar.frameColors[i] = v; }, 'frame:' + i, 'ring color'));
  return [
    group('Picture', pictureRow(env, 'avatar', 'Avatar', HUB_LIM.avatar),
      sliderRow(ctx, 'Zoom', 'Crop: zoom in on your picture.', 100, 300, 5, '%', () => a().zoom, (e, v) => { e.avatar.zoom = v; }, 'av:zoom', 'crop scale'),
      sliderRow(ctx, 'Position across', '', 0, 100, 1, '%', () => a().x, (e, v) => { e.avatar.x = v; }, 'av:x', 'crop horizontal'),
      sliderRow(ctx, 'Position down', '', 0, 100, 1, '%', () => a().y, (e, v) => { e.avatar.y = v; }, 'av:y', 'crop vertical')),
    group('Shape and frame',
      segmentedRow(ctx, 'Shape', '', SHAPES, () => a().shape, (e, v) => { e.avatar.shape = v; }, 'hex hexagon diamond circle square'),
      ...frameRows,
      segmentedRow(ctx, 'Glow', 'Neon makes a bright halo in the frame colour.', GLOWS, () => a().glow, (e, v) => { e.avatar.glow = v; }, 'neon shadow')),
    group('Extras',
      selectRow(ctx, 'Ornament', 'Drawn above or around the frame on larger avatars.', ORNAMENTS, () => a().ornament, (e, v) => { e.avatar.ornament = v; }, 'crown halo ears horns sparkles antenna wreath flames star'),
      colorRow(ctx, 'Ornament colour', '', () => a().ornamentColor, (e, v) => { e.avatar.ornamentColor = v; }, '#e8c14b', 'av:orn', 'crown'),
      selectRow(ctx, 'Status marker', 'How your online status looks next to your avatar. Only friends who may see your presence get it.', STATUS_STYLES, () => a().status, (e, v) => { e.avatar.status = v; }, 'online dot presence')),
  ];
}

/* ---------------- banner ---------------- */

function bannerPanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const b = (): Ext['banner'] => ctx.get().banner;
  const base: HTMLElement[] = [
    segmentedRow(ctx, 'Fill', 'A picture needs one uploaded below.', BANNER_MODES, () => b().mode, (e, v) => { e.banner.mode = v; if (v === 'gradient' && e.banner.colors.length < 2) e.banner.colors = [e.banner.colors[0], '#c63ed8']; }, 'solid gradient picture image', true),
  ];
  if (b().mode === 'color') base.push(plainColorRow(ctx, 'Banner colour', '', () => b().colors[0], (e, v) => { e.banner.colors[0] = v; }, 'ban:c0', 'color'));
  if (b().mode === 'gradient') {
    base.push(stopsRow(ctx, 'Gradient colours', 'Up to 3 stops.', () => b().colors, (e, v) => { e.banner.colors = v; }, 2, LIMITS.bannerStops, 'ban:stops', 'stops'));
    base.push(sliderRow(ctx, 'Gradient angle', '', 0, 360, 5, '°', () => b().angle, (e, v) => { e.banner.angle = v; }, 'ban:angle', 'direction'));
  }
  if (b().mode === 'image') {
    base.push(sliderRow(ctx, 'Picture zoom', '', 100, 300, 5, '%', () => b().imgZoom, (e, v) => { e.banner.imgZoom = v; }, 'ban:zoom', 'crop scale'));
    base.push(sliderRow(ctx, 'Picture position across', '', 0, 100, 1, '%', () => b().imgX, (e, v) => { e.banner.imgX = v; }, 'ban:x', 'crop horizontal'));
    base.push(sliderRow(ctx, 'Picture position down', '', 0, 100, 1, '%', () => b().imgY, (e, v) => { e.banner.imgY = v; }, 'ban:y', 'crop vertical'));
  }
  return [
    group('Banner', pictureRow(env, 'banner', 'Banner', HUB_LIM.image), ...base,
      segmentedRow(ctx, 'Height', '', HEIGHTS, () => b().height, (e, v) => { e.banner.height = v; }, 'size tall slim')),
    group('Overlays',
      selectRow(ctx, 'Pattern', '', PATTERNS, () => b().pattern, (e, v) => { e.banner.pattern = v; }, 'grid dots scanlines stars hex'),
      selectRow(ctx, 'Animation', 'Stops for people who ask their system for reduced motion.', ANIMS.filter((x) => !EXCLUSIVE_ANIMS[x.value] || ownsStyle(EXCLUSIVE_ANIMS[x.value].owner, currentUser()?.username)), () => b().anim, (e, v) => { e.banner.anim = v; }, 'drifting stars aurora scanline sweep motion'),
      sliderRow(ctx, 'Dim', 'Darken the banner so names stay readable.', 0, 80, 5, '%', () => b().dim, (e, v) => { e.banner.dim = v; }, 'ban:dim', 'darken'),
      colorRow(ctx, 'Tint', 'Washes a colour over the banner.', () => b().tint, (e, v) => { e.banner.tint = v; }, '#c63ed8', 'ban:tint', 'colour overlay')),
  ];
}

/* ---------------- theme ---------------- */

function themePanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const t = (): Ext['theme'] => ctx.get().theme;
  const bgRows: HTMLElement[] = [selectRow(ctx, 'Page background', 'Fills the space behind your whole profile page.', BGS, () => t().bg, (e, v) => { e.theme.bg = v; }, 'backdrop wallpaper')];
  if (t().bg !== 'none') bgRows.push(stopsRow(ctx, 'Background colours', t().bg === 'color' ? 'The first colour is used.' : '', () => t().bgColors, (e, v) => { e.theme.bgColors = v; }, 1, 2, 'th:bg', 'color'));
  return [
    group('Colours', colorRow(ctx, 'Accent colour', 'Used for links, numbers and headings. Automatic keeps the app green.', () => t().accent, (e, v) => { e.theme.accent = v; }, '#c63ed8', 'th:accent', 'highlight')),
    group('Cards', segmentedRow(ctx, 'Card style', '', CARDS, () => t().card, (e, v) => { e.theme.card = v; }, 'glass solid gradient pattern panel'),
      segmentedRow(ctx, 'Corners', '', CORNERS, () => t().corner, (e, v) => { e.theme.corner = v; }, 'sharp soft round pixel radius')),
    group('Background', ...bgRows),
  ];
}

/* ---------------- content ---------------- */

const EMOJI = ['\u{1F680}', '\u{1F3AE}', '\u{1F6A7}', '\u{1F3C3}', '\u{1F4A4}', '\u{1F389}', '\u{1F525}', '\u{2728}', '\u{1F9E0}', '\u{1F3A8}', '\u{1F41B}', '\u{1F3B5}'];
const EXPIRY: Array<[string, string, number]> = [['keep', 'Keep current', -1], ['never', 'Never', 0], ['1h', 'In 1 hour', 3600], ['4h', 'In 4 hours', 14400], ['1d', 'In 1 day', 86400], ['3d', 'In 3 days', 259200], ['7d', 'In 7 days', 604800], ['30d', 'In 30 days', 2592000]];

function expiryText(expires: number): string {
  if (!expires) return 'No expiry';
  const left = expires - Math.floor(Date.now() / 1000);
  if (left <= 0) return 'Expired';
  if (left < 3600) return 'Ends in ' + Math.ceil(left / 60) + ' min';
  if (left < 86400) return 'Ends in ' + Math.round(left / 3600) + ' h';
  return 'Ends in ' + Math.round(left / 86400) + ' days';
}

function linksEditor(env: Env): HTMLElement {
  const { ctx } = env;
  const list = h('div', { className: 'pe-list' });
  const rows = ctx.get().content.links.map((l) => ({ ...l }));
  const commit = (): void => {
    const valid = rows.filter((r) => httpsUrl(r.url.trim())).map((r) => ({ url: r.url.trim(), label: r.label.trim().slice(0, LIMITS.linkLabel) }));
    ctx.change((e) => { e.content.links = valid; }, 'links');
  };
  const paint = (): void => {
    list.replaceChildren();
    rows.forEach((r, i) => {
      const line = h('div', { className: 'pe-item', attrs: { draggable: 'true' }, dataset: { i: String(i) } });
      const info = linkInfo(r.url);
      const mark = h('span', { className: 'plink-ic', text: httpsUrl(r.url.trim()) ? info.mark : '?' });
      mark.style.setProperty('--ic', httpsUrl(r.url.trim()) ? info.color : '#888888');
      if (httpsUrl(r.url.trim())) applySiteIcon(mark, r.url.trim());
      const url = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'https://...', 'aria-label': 'Link address', spellcheck: 'false' } });
      url.value = r.url;
      const label = h('input', { className: 'input pe-short', attrs: { type: 'text', placeholder: info.label, 'aria-label': 'Link label', maxlength: String(LIMITS.linkLabel) } });
      label.value = r.label;
      const bad = h('span', { className: 'form-error', text: 'needs https://', hidden: !r.url.trim() || !!httpsUrl(r.url.trim()) });
      url.addEventListener('input', () => {
        r.url = url.value;
        const ok = !!httpsUrl(r.url.trim());
        bad.hidden = ok || !r.url.trim();
        mark.classList.remove('has-logo');
        mark.textContent = ok ? linkInfo(r.url.trim()).mark : '?';
        mark.style.setProperty('--ic', ok ? linkInfo(r.url.trim()).color : '#888888');
        if (ok) applySiteIcon(mark, r.url.trim());
        label.placeholder = ok ? linkInfo(r.url.trim()).label : '';
        commit();
      });
      label.addEventListener('input', () => { r.label = label.value; commit(); });
      line.append(h('span', { className: 'pe-grip', text: '⠇', title: 'Drag to reorder' }), mark, url, label, bad,
        iconButton('chevron-down', 'Move up', () => { move(rows, i, i - 1).forEach((x, k) => { rows[k] = x; }); commit(); paint(); }, i === 0, 'is-up'),
        iconButton('chevron-down', 'Move down', () => { move(rows, i, i + 1).forEach((x, k) => { rows[k] = x; }); commit(); paint(); }, i === rows.length - 1),
        iconButton('x', 'Remove link', () => { rows.splice(i, 1); commit(); paint(); }));
      list.appendChild(line);
    });
    if (rows.length < LIMITS.links) {
      list.appendChild(button('Add a link', { kind: 'secondary', icon: 'plus', onClick: () => { rows.push({ url: '', label: '' }); paint(); } }));
    }
  };
  sortable(list, (from, to) => { move(rows, from, to).forEach((x, k) => { rows[k] = x; }); commit(); paint(); });
  paint();
  return row('Links', 'Up to ' + LIMITS.links + ', https only. YouTube, Discord, Patreon, GitHub, Twitch and more get their own icon.', list, 'youtube discord patreon github twitch website url');
}

function contentPanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const c = (): Ext['content'] => ctx.get().content;
  const emojiBox = h('div', { className: 'pe-emoji' });
  const emojiInput = h('input', { className: 'input pe-emoji-input', attrs: { type: 'text', 'aria-label': 'Status emoji', placeholder: '\u{1F642}', maxlength: String(LIMITS.emoji), spellcheck: 'false' } });
  emojiInput.value = c().status.emoji;
  emojiInput.addEventListener('input', () => ctx.change((e) => { e.content.status.emoji = sanitize({ content: { status: { emoji: emojiInput.value } } }).content.status.emoji; }, 'emoji'));
  emojiBox.appendChild(emojiInput);
  for (const em of EMOJI) {
    const b = h('button', { className: 'pe-emoji-btn', text: em, attrs: { type: 'button', 'aria-label': 'Use ' + em } });
    b.addEventListener('click', () => { emojiInput.value = em; ctx.change((e) => { e.content.status.emoji = em; }); });
    emojiBox.appendChild(b);
  }
  const expirySelect = h('select', { className: 'select', attrs: { 'aria-label': 'Status expiry' } });
  for (const [value, label] of EXPIRY) expirySelect.appendChild(h('option', { text: label, attrs: { value } }));
  expirySelect.value = 'keep';
  const expiryNote = h('span', { className: 'dim', text: expiryText(c().status.expires) });
  expirySelect.addEventListener('change', () => {
    const found = EXPIRY.find((x) => x[0] === expirySelect.value);
    if (!found || found[2] < 0) return;
    const at = found[2] === 0 ? 0 : Math.floor(Date.now() / 1000) + found[2];
    ctx.change((e) => { e.content.status.expires = at; });
    expiryNote.textContent = expiryText(at);
  });
  return [
    group('Status line',
      row('Emoji', 'Shown next to your status on your profile.', emojiBox, 'emoticon'),
      textRow(ctx, 'Status', 'A short line about what you are up to.', () => c().status.text, (e, v) => { e.content.status.text = v; }, LIMITS.statusText, 'status', { placeholder: 'Building a new map' }),
      row('Clears', 'The status disappears by itself after this.', h('div', { className: 'pe-inline' }, expirySelect, expiryNote), 'expiry expire')),
    group('About you',
      textRow(ctx, 'Bio', 'Use **bold**, *italic*, [text](https://link) and line breaks. Anything else shows as typed.', () => c().bio, (e, v) => { e.content.bio = v; }, LIMITS.bio, 'bio', { multiline: true, placeholder: 'Tell people about yourself', keywords: 'about description markdown' }),
      textRow(ctx, 'Pronouns', '', () => c().pronouns, (e, v) => { e.content.pronouns = v; }, LIMITS.pronouns, 'pronouns', { placeholder: 'for example she/her' })),
    group('Links', linksEditor(env)),
  ];
}

/* ---------------- showcase ---------------- */

interface Pick { kind: string; id: string; name: string }

function pickerModal(env: Env, title: string, onPick: (p: Pick) => void): void {
  const body = h('div', { className: 'pe-picker' });
  const tabsRow = h('div', { className: 'pe-seg' });
  const search = h('input', { className: 'input', attrs: { type: 'search', placeholder: 'Search', 'aria-label': 'Search' } });
  const list = h('div', { className: 'pe-picklist' });
  const kinds = h('select', { className: 'select', attrs: { 'aria-label': 'Library kind' } });
  for (const k of ['maps', 'mods', 'skins']) kinds.appendChild(h('option', { text: KIND_LABEL[k as Kind], attrs: { value: k } }));
  let source: 'mine' | 'library' = 'mine';
  let library: Array<{ kind: string; id: string; name: string; author: string }> = [];
  const choose = (p: Pick): void => { onPick(p); overlay.querySelector<HTMLElement>('.icon-btn')?.click(); };
  const paint = (): void => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const items: Array<{ kind: string; id: string; name: string; sub: string }> = source === 'mine'
      ? env.hub().uploads.map((u) => ({ kind: u.kind, id: u.id, name: u.name, sub: KIND_LABEL[(libraryKind(u.kind) ?? 'maps') as Kind] ?? u.kind }))
      : library.map((x) => ({ kind: x.kind, id: x.id, name: x.name, sub: x.author }));
    const shown = items.filter((x) => !q || x.name.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q)).slice(0, 80);
    if (shown.length === 0) list.appendChild(h('p', { className: 'dim', text: source === 'mine' ? 'Nothing published yet.' : 'Nothing found.' }));
    for (const it of shown) {
      const b = h('button', { className: 'pe-pick', attrs: { type: 'button' } }, h('span', { className: 'pe-pick-name', text: it.name }), h('span', { className: 'dim', text: it.sub }));
      b.addEventListener('click', () => choose({ kind: it.kind, id: it.id, name: it.name }));
      list.appendChild(b);
    }
  };
  const loadLibrary = (): void => {
    list.replaceChildren(h('p', { className: 'dim', text: 'Loading...' }));
    loadKind(kinds.value as Kind).then((items) => {
      library = items.filter((i) => !i.local).map((i) => ({ kind: SINGULAR[kinds.value] ?? 'map', id: i.id, name: i.name, author: i.author }));
      paint();
    }, (e) => list.replaceChildren(h('p', { className: 'form-error', text: describeError(e) })));
  };
  for (const [value, label] of [['mine', 'My uploads'], ['library', 'Library']] as const) {
    const b = h('button', { className: 'pe-seg-btn' + (value === source ? ' is-on' : ''), text: label, attrs: { type: 'button' } });
    b.addEventListener('click', () => {
      source = value;
      for (const x of Array.from(tabsRow.children)) x.classList.toggle('is-on', x === b);
      kinds.hidden = value === 'mine';
      if (value === 'library') loadLibrary(); else paint();
    });
    tabsRow.appendChild(b);
  }
  kinds.hidden = true;
  kinds.addEventListener('change', loadLibrary);
  search.addEventListener('input', paint);
  body.append(h('div', { className: 'pe-inline' }, tabsRow, kinds), search, list);
  paint();
  const overlay = modal({ title, body, actions: [{ label: 'Cancel' }] });
}

function showcaseList(env: Env): HTMLElement {
  const { ctx } = env;
  const list = h('div', { className: 'pe-list' });
  const items = (): Ext['content']['showcase'] => ctx.get().content.showcase;
  const apply = (next: Ext['content']['showcase']): void => { ctx.change((e) => { e.content.showcase = next; }); ctx.rebuild(); };
  items().forEach((it, i) => {
    const line = h('div', { className: 'pe-item', attrs: { draggable: 'true' }, dataset: { i: String(i) } });
    line.append(h('span', { className: 'pe-grip', text: '⠇', title: 'Drag to reorder' }),
      h('span', { className: 'badge badge-kind', text: KINDS.find((k) => k.value === it.kind)?.label ?? it.kind }),
      h('span', { className: 'pe-item-name', text: it.name || it.id }),
      iconButton('chevron-down', 'Move up', () => apply(move(items(), i, i - 1)), i === 0, 'is-up'),
      iconButton('chevron-down', 'Move down', () => apply(move(items(), i, i + 1)), i === items().length - 1),
      iconButton('x', 'Remove', () => apply(items().filter((_, k) => k !== i))));
    list.appendChild(line);
  });
  sortable(list, (from, to) => apply(move(items(), from, to)));
  if (items().length < LIMITS.showcase) {
    list.appendChild(button('Add a favourite', { kind: 'secondary', icon: 'plus', onClick: () => pickerModal(env, 'Add to your showcase', (p) => {
      if (items().some((x) => x.kind === p.kind && x.id === p.id)) { toast('That one is already in your showcase.', 'info'); return; }
      apply([...items(), { kind: p.kind, id: p.id, name: p.name.slice(0, LIMITS.itemName) }]);
    }) }));
  } else {
    list.appendChild(h('p', { className: 'dim', text: 'That is the most you can show (' + LIMITS.showcase + ').' }));
  }
  return list;
}

function showcasePanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const f = ctx.get().content.featured;
  const featured = h('div', { className: 'pe-list' });
  if (f) {
    featured.appendChild(h('div', { className: 'pe-item' }, h('span', { className: 'badge badge-kind', text: KINDS.find((k) => k.value === f.kind)?.label ?? f.kind }), h('span', { className: 'pe-item-name', text: f.name || f.id }),
      iconButton('x', 'Remove featured item', () => { ctx.change((e) => { e.content.featured = null; }); ctx.rebuild(); })));
  }
  featured.appendChild(button(f ? 'Change featured' : 'Choose a featured item', { kind: 'secondary', icon: 'sparkles', onClick: () => pickerModal(env, 'Feature one of your favourites', (p) => {
    ctx.change((e) => { e.content.featured = { kind: p.kind, id: p.id, name: p.name.slice(0, LIMITS.itemName), note: e.content.featured?.note ?? '' }; });
    ctx.rebuild();
  }) }));
  const rows: HTMLElement[] = [row('Featured', 'A big highlight block above your showcase.', featured, 'highlight map mod skin')];
  if (f) rows.push(textRow(ctx, 'Featured note', 'Why it is special.', () => ctx.get().content.featured?.note ?? '', (e, v) => { if (e.content.featured) e.content.featured.note = v; }, LIMITS.note, 'feat:note', { placeholder: 'My best map so far' }));
  return [
    group('Favourites', row('Showcase', 'Up to ' + LIMITS.showcase + ' favourite maps, mods or skins from your uploads or the Library. Drag to reorder.', showcaseList(env), 'favourite map mod skin')),
    group('Highlight', ...rows),
  ];
}

/* ---------------- layout ---------------- */

function layoutPanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const list = h('div', { className: 'pe-list' });
  const sections = (): Ext['sections'] => ctx.get().sections;
  const label = (id: string): string => (id === 'friends' ? 'Friends' : id.charAt(0).toUpperCase() + id.slice(1));
  const apply = (next: Ext['sections']): void => { ctx.change((e) => { e.sections = next; }); ctx.rebuild(); };
  sections().forEach((s, i) => {
    const line = h('div', { className: 'pe-item' + (s.on ? '' : ' is-off'), attrs: { draggable: 'true' }, dataset: { i: String(i) } });
    const on = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Show ' + label(s.id) } });
    on.checked = s.on;
    on.addEventListener('change', () => apply(sections().map((x, k) => (k === i ? { ...x, on: on.checked } : x))));
    line.append(h('span', { className: 'pe-grip', text: '⠇', title: 'Drag to reorder' }), on, h('span', { className: 'pe-item-name', text: label(s.id) }),
      iconButton('chevron-down', 'Move up', () => apply(move(sections(), i, i - 1)), i === 0, 'is-up'),
      iconButton('chevron-down', 'Move down', () => apply(move(sections(), i, i + 1)), i === sections().length - 1));
    list.appendChild(line);
  });
  sortable(list, (from, to) => apply(move(sections(), from, to)));
  return [
    group('Sections', row('Order and visibility', 'Drag to reorder, untick to hide. Your header always shows.', list, 'about showcase uploads stats links friends activity hide reorder')),
    group('Stats',
      multiRow(ctx, 'Show these counts', '"Maps played" appears once that count is available.', STAT_IDS, () => ctx.get().stats.show, (e, v) => { e.stats.show = v; }, 'uploads threads replies comments friends played'),
      segmentedRow(ctx, 'Stats style', '', STAT_STYLES, () => ctx.get().stats.style, (e, v) => { e.stats.style = v; }, 'chips big numbers minimal')),
  ];
}

/* ---------------- privacy ---------------- */

function privacyPanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const p = (): Ext['privacy'] => ctx.get().privacy;
  return [group('Who can see what',
    selectRow(ctx, 'Your profile', 'Friends only: everybody else still sees your name, picture and colours, but not the rest.', PROFILE_VIS, () => p().profile, (e, v) => { e.privacy.profile = v; }, 'visibility'),
    selectRow(ctx, 'Friends list and count', '', FRIENDS_VIS, () => p().friends, (e, v) => { e.privacy.friends = v; }, 'friends visibility'),
    selectRow(ctx, 'Online status', 'Nobody makes you appear offline to everyone, the same as Invisible in Community, Friends.', PRESENCE_VIS, () => p().presence, (e, v) => { e.privacy.presence = v; }, 'presence invisible offline'))];
}

/* ---------------- share ---------------- */

function sharePanel(env: Env): HTMLElement[] {
  const { ctx } = env;
  const out = h('textarea', { className: 'input textarea pe-code', attrs: { rows: '4', readonly: 'readonly', 'aria-label': 'Your style code' } });
  out.value = exportStyle(ctx.get());
  const copy = button('Copy code', { kind: 'secondary', onClick: () => {
    const done = (): void => toast('Style code copied.', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.value).then(done, () => { out.select(); toast('Select the code and copy it.', 'info'); });
    else { out.select(); toast('Select the code and copy it.', 'info'); }
  } });
  const input = h('textarea', { className: 'input textarea pe-code', attrs: { rows: '4', placeholder: 'RP1.xxxxxxxx', 'aria-label': 'Paste a style code', maxlength: String(MAX_CODE + 100) } });
  const error = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const apply = button('Apply style', { kind: 'primary', onClick: () => {
    try {
      env.replace(importStyle(input.value, ctx.get()));
      toast('Style applied. Save to keep it.', 'success');
    } catch (e) {
      error.hidden = false;
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  } });
  return [
    group('Export', row('Your style code', 'Share it with a friend. It holds colours and effects only, never your words, links, picture or privacy.', h('div', { className: 'pe-text' }, out, copy), 'export share code')),
    group('Import', row('Paste a style code', 'Replaces your colours, effects, frame, banner, card and section order.', h('div', { className: 'pe-text' }, input, error, apply), 'import code')),
  ];
}

export const CATEGORIES: Category[] = [
  { id: 'presets', label: 'Presets', icon: 'sparkles', build: presetsPanel },
  { id: 'name', label: 'Name', icon: 'user', build: namePanel },
  { id: 'avatar', label: 'Avatar', icon: 'image', build: avatarPanel },
  { id: 'banner', label: 'Banner', icon: 'image', build: bannerPanel },
  { id: 'theme', label: 'Theme', icon: 'grid', build: themePanel },
  { id: 'content', label: 'Content', icon: 'forum', build: contentPanel },
  { id: 'showcase', label: 'Showcase', icon: 'package', build: showcasePanel },
  { id: 'layout', label: 'Layout', icon: 'library', build: layoutPanel },
  { id: 'privacy', label: 'Privacy', icon: 'info', build: privacyPanel },
  { id: 'share', label: 'Share', icon: 'download', build: sharePanel },
];

/** What "Reset section" restores for each category (style only, never the other categories). */
export function resetCategory(ext: Ext, id: string): Ext {
  const d = defaultExt();
  const next = JSON.parse(JSON.stringify(ext)) as Ext;
  switch (id) {
    case 'presets': next.name = d.name; next.avatar = { ...d.avatar, zoom: ext.avatar.zoom, x: ext.avatar.x, y: ext.avatar.y }; next.banner = { ...d.banner, mode: ext.banner.mode === 'image' ? 'image' : d.banner.mode }; next.theme = d.theme; break;
    case 'name': next.name = d.name; break;
    case 'avatar': next.avatar = d.avatar; break;
    case 'banner': next.banner = d.banner; break;
    case 'theme': next.theme = { ...d.theme, preset: null }; break;
    case 'content': next.content = { ...d.content, showcase: ext.content.showcase, featured: ext.content.featured }; break;
    case 'showcase': next.content.showcase = []; next.content.featured = null; break;
    case 'layout': next.sections = d.sections; next.stats = d.stats; break;
    case 'privacy': next.privacy = d.privacy; break;
    default: break;
  }
  return sanitize(next);
}

