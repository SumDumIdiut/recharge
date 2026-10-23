// Profile card: the popup that opens from any name / avatar, and the same card as the live preview in the decoration editor.
import { escapeHtml } from '../ui.js';
import { avatarHtml, hubUrl, safeColor, userOf, titlesHtml, nameTextHtml } from './avatar.js';
import { linkHtml, safeUrl, openExternal } from './text.js';
import { profiles } from './api.js';
import { isAdmin } from '../auth.js';

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
        ${titlesHtml(p, 'pc-title')}
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
    if (isAdmin()) mountBadgeGiver(overlay, p);
  } catch (e) {
    if (open?.overlay === overlay) overlay.querySelector('.pc-loading').textContent = e.status === 404 ? 'No such user.' : e.message;
  }
}

// Admins hand out badges from the card: pick any, then Save (leaving one out removes it).
// This replaces the old title chips; the hub checks the admin rights again.
// The row sits at the bottom of the card body (inside its padding, full width); re-rendering the card puts it back with the result message.
let badgeCatalog = null; // GET /api/badges, fetched once and kept
export function badgeChipsHtml(available, selected = []) {
  const have = new Set(selected);
  const list = (available && available.length ? available : []).map((b) =>
    `<button type="button" class="title-chip${have.has(b.id) ? ' on' : ''}" data-badge="${escapeHtml(b.id)}" title="${escapeHtml(b.description || b.name)}" aria-pressed="${have.has(b.id)}">${escapeHtml(b.name)}</button>`).join('');
  return `<div class="title-chips">${list || '<span class="pc-give-msg">No badges loaded.</span>'}</div>`;
}
// The chips' current picks, in list order.
export const pickedBadges = (host) => [...host.querySelectorAll('.title-chip.on')].map((b) => b.dataset.badge);

async function mountBadgeGiver(overlay, p, message = '') {
  if (!badgeCatalog) { try { badgeCatalog = await profiles.badges(); } catch { badgeCatalog = []; } }
  const have = (Array.isArray(p.badges) ? p.badges : []).map((b) => b.id);
  const row = document.createElement('div');
  row.className = 'pc-give-title';
  row.innerHTML = `<div class="pc-give-label">Badges</div>${badgeChipsHtml(badgeCatalog, have)}
    <div class="pc-give-line"><button class="btn" type="button" data-act="give">Save badges</button><span class="pc-give-msg">${escapeHtml(message)}</span></div>`;
  overlay.querySelector('.pc-body').appendChild(row);
  const btn = row.querySelector('[data-act=give]'), msg = row.querySelector('.pc-give-msg');
  row.addEventListener('click', (e) => {
    const chip = e.target.closest('.title-chip');
    if (chip) { chip.classList.toggle('on'); chip.setAttribute('aria-pressed', chip.classList.contains('on')); }
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await profiles.giveBadges(p.username, pickedBadges(row));
      p.badges = r.badges || [];
      overlay.querySelector('.profile-card').outerHTML = profileCardHtml(p, { uploads: true });
      mountBadgeGiver(overlay, p, p.badges.length ? `Saved: ${p.badges.map((b) => b.name).join(', ')}.` : 'Badges cleared.');
    } catch (e) { msg.textContent = e.message; btn.disabled = false; }
  });
  // The moderator role is granted here too: only admins can, and the hub re-checks.
  if (p.moderator !== undefined) {
    const modRow = document.createElement('div');
    modRow.className = 'pc-give-title';
    const isMod = !!p.moderator;
    modRow.innerHTML = `<div class="pc-give-label">Moderator</div>
      <div class="pc-give-line"><button class="btn" type="button" data-act="mod">${isMod ? 'Revoke moderator' : 'Make moderator'}</button></div>`;
    overlay.querySelector('.pc-body').appendChild(modRow);
    modRow.querySelector('[data-act=mod]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const r = await profiles.setModerator(p.username, !isMod);
        p.moderator = !!r.moderator;
        // The hub hands the Moderator badge over with the role and takes it back on a revoke,
        // so the card is re-rendered to show the badges as they now stand.
        if (Array.isArray(r.badges)) p.badges = r.badges;
        overlay.querySelector('.profile-card').outerHTML = profileCardHtml(p, { uploads: true });
        mountBadgeGiver(overlay, p, p.moderator
          ? (p.badges || []).some((x) => x.id === 'moderator') ? 'Moderator badge granted.' : 'Made moderator.'
          : 'Moderator revoked.');
        window.__updateAccountBadge?.();
      } catch (err) { b.disabled = false; msg.textContent = err.message; }
    });
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
