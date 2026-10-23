// The Players page: everyone with an account, searchable by name, each showing their avatar
// and what they have published. Selecting one opens their profile card, the same one every
// other name opens.
import { escapeHtml, patchCards } from '../ui.js';
import { moderation } from '../social/api.js';
import { avatarHtml, nameHtml, userOf } from '../social/avatar.js';

const DEBOUNCE_MS = 250;

// The order uploads are shown in, and what each is called. Playlists and backgrounds are
// counted together: both are dressing rather than something you play.
const KINDS = [['map', 'Maps'], ['mod', 'Mods'], ['skin', 'Skins'], ['playlist', 'Playlists'], ['background', 'Backgrounds']];

let root = null;
let term = '';
let timer = 0;
let seq = 0;
let all = null; // the directory, cached until a search needs less or more

const fetchUsers = (q) => moderation.users(q);

async function load(force = false) {
  if (all && !force) return all;
  all = await fetchUsers('');
  return all;
}

function rowsHtml(users) {
  return users.map((raw) => {
    // The directory sends the hub's field names (avatar_url, name_color); the renderers want
    // the app's (avatar, nameColor). Without this every avatar fell back to an initial and
    // every name to plain white, even though the hub had a picture and a colour for them.
    const u = userOf(raw);
    const up = raw.uploads || {};
    const counts = KINDS.filter(([k]) => up[k]).map(([k, label]) => `${escapeHtml(up[k])} ${escapeHtml(label)}`);
    return `
    <div class="player-row" data-k="${escapeHtml(u.username)}" data-player="${escapeHtml(u.username)}">
      ${avatarHtml(u, 40)}
      <div class="player-row-main">
        <div class="player-row-name">${nameHtml(u)}</div>
        ${counts.length ? `<div class="player-row-meta">${counts.join(' &middot; ')}</div>` : ''}
      </div>
    </div>`;
  });
}

async function render() {
  if (!root) return;
  const mine = ++seq;
  let data;
  try { data = await load(); } catch (err) {
    if (mine !== seq) return;
    root.innerHTML = `<p class="mod-note">Could not load the player list: ${escapeHtml(String(err?.message || err))}</p>`;
    return;
  }
  if (mine !== seq) return;
  const q = term.trim().toLowerCase();
  const users = q ? data.users.filter((u) => String(u.username).toLowerCase().includes(q)) : data.users;
  let list = root.querySelector('.player-list');
  if (!list) {
    root.innerHTML = '<div class="mod-board"><div class="player-list"></div></div>';
    list = root.querySelector('.player-list');
  }
  patchCards(list, rowsHtml(users), `<div class="empty-state">${term ? 'No player matches that search.' : 'No players yet.'}</div>`);
  // data-user, so the app-wide listener opens the profile card - the same one any other
  // name in the app opens.
  for (const row of root.querySelectorAll('[data-player]')) {
    if (!row.dataset.user) row.dataset.user = row.dataset.player;
  }
}

window.__playersSearch = function (value) {
  term = value;
  clearTimeout(timer);
  timer = setTimeout(render, DEBOUNCE_MS);
};

export async function init() {
  root = document.getElementById('players-root');
  await render();
}

export async function onShow() {
  // Accounts change while the app is open, so refresh rather than show a stale list.
  all = null;
  await render();
}