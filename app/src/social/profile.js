// Profile card: the popup that opens from any name / avatar, and the same card as the live preview in the decoration editor.
import { escapeHtml } from '../ui.js';
import { avatarHtml, hubUrl, safeColor, userOf, nameTextHtml } from './avatar.js';
import { linkHtml, safeUrl, openExternal } from './text.js';
import { profiles } from './api.js';

const KIND_LABEL = { mod: 'Mod', map: 'Map', skin: 'Skin', playlist: 'Playlist', background: 'Background' };

// p: a hub profile (or a draft with the same field names). opts.uploads shows the uploads list.
export function profileCardHtml(p, { uploads = false, preview = false } = {}) {
  const u = userOf(p);
  const accent = safeColor(p.accent_color, '#41f88d');
  const bannerImg = hubUrl(p.banner_url) || (preview && p._bannerPreview) || '';
  const bannerCol = safeColor(p.banner_color, '');
  const banner = bannerImg
    ? `<div class="pc-banner" style="background-image:url('${escapeHtml(bannerImg)}')"></div>`
    : `<div class="pc-banner" style="${bannerCol ? `background:${bannerCol}` : 'background:var(--field)'}"></div>`;
  const links = (Array.isArray(p.links) ? p.links : []).filter((l) => safeUrl(l)).slice(0, 3);
  const counts = [['posts', p.post_count], ['replies', p.reply_count], ['comments', p.comment_count]]
    .filter(([, n]) => n != null)
    .map(([k, n]) => `<span><b>${escapeHtml(n)}</b> ${k}</span>`).join('');
  const ups = uploads ? (Array.isArray(p.uploads) ? p.uploads : []) : [];
  return `<div class="profile-card" style="--pc-accent:${accent}">
    ${banner}
    <div class="pc-body">
      <div class="pc-avatar">${avatarHtml(u, 72, { clickable: false })}</div>
      <div class="pc-name"><span class="pc-name-text">${nameTextHtml(p)}</span></div>
      <div class="pc-sub">
        ${p.pronouns ? `<span class="pc-pron">${escapeHtml(p.pronouns)}</span>` : ''}
      </div>
      ${p.bio ? `<div class="pc-bio">${escapeHtml(p.bio)}</div>` : ''}
      ${links.length ? `<div class="pc-links">${links.map((l) => linkHtml(l)).join('')}</div>` : ''}
      ${counts ? `<div class="pc-counts">${counts}</div>` : ''}
      ${uploads ? `<div class="pc-uploads-title">Uploads</div><div class="pc-uploads">${ups.length
        ? ups.map((x) => `<div class="pc-up"><span class="tag">${escapeHtml(KIND_LABEL[x.kind] || x.kind)}</span> ${escapeHtml(x.name)}${x.version ? ` <span class="pc-up-v">v${escapeHtml(x.version)}</span>` : ''}</div>`).join('')
        : '<div class="pc-none">Nothing uploaded yet.</div>'}</div>` : ''}
    </div>
  </div>`;
}

let open = null; // { overlay, onKey } so only one card exists and its listener is always removed

export function closeProfile() {
  if (!open) return;
  open.overlay.remove();
  document.removeEventListener('keydown', open.onKey, true);
  open = null;
}

export async function openProfile(username) {
  if (!username) return;
  closeProfile();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal profile-modal" role="dialog" aria-modal="true" aria-label="Profile"><div class="pc-loading">Loading...</div><div class="modal-actions"><button class="btn" data-act="close" type="button">Close</button></div></div>`;
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeProfile(); } };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeProfile(); });
  overlay.querySelector('[data-act=close]').addEventListener('click', closeProfile);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  open = { overlay, onKey };
  try {
    const p = await profiles.get(username);
    if (open?.overlay !== overlay) return;
    overlay.querySelector('.pc-loading').outerHTML = profileCardHtml(p, { uploads: true });
  } catch (e) {
    if (open?.overlay === overlay) overlay.querySelector('.pc-loading').textContent = e.status === 404 ? 'No such user.' : e.message;
  }
}

let wired = false;
// One delegated listener for the whole app: names/avatars open the profile card, links go through the Tauri opener.
// The click listener runs in the capture phase and stops the click there, so a name inside a card (or news item)
// opens the profile without also firing that card's own inline onclick.
export function initSocial() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (e) => {
    const link = e.target.closest?.('a[data-ext-url]');
    if (link) { e.preventDefault(); openExternal(link.dataset.extUrl); return; }
    const who = e.target.closest?.('[data-user]');
    if (who && !who.closest('.profile-card')) { e.preventDefault(); e.stopPropagation(); openProfile(who.dataset.user); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const who = e.target.closest?.('[data-user]');
    if (who) { e.preventDefault(); openProfile(who.dataset.user); }
  });
}
