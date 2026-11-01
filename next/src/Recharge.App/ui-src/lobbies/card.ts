import { h } from '../dom.js';
import { icon } from '../icons.js';
import { authorName, kindPlaceholder } from '../components/itemCard.js';
import { imageBlobUrl } from '../lib/hub.js';
import type { LobbyCardData } from './model.js';

/** One live lobby card. Join starts the game and joins the lobby (beta); onJoin does the work and the button shows its progress. */
export function lobbyCard(data: LobbyCardData, onJoin?: (data: LobbyCardData, done: (message: string) => void) => void): HTMLElement {
  const card = h('article', { className: 'lobby-card' + (data.full ? ' is-full' : ''), attrs: { 'aria-label': data.name } });

  const media = h('div', { className: 'lobby-media' });
  media.appendChild(kindPlaceholder('maps', data.mapName ? '' : 'Base game'));
  if (data.hubMap && data.picture) {
    // Gallery images come through the bridge (blob URL): a direct https:// URL from imageUrl() fails
    // under the recharge:// URI scheme.
    const box = h('div', { className: 'media-box card-img' });
    box.style.aspectRatio = '16 / 9';
    const image = h('img', { attrs: { alt: '', decoding: 'async', loading: 'lazy' } });
    imageBlobUrl('maps', data.hubMap.id, data.picture).then((url) => {
      image.onload = () => { media.classList.add('has-img'); };
      image.onerror = () => { /* cover stays */ };
      image.src = url;
    }, () => { /* cover stays */ });
    box.appendChild(image);
    media.appendChild(box);
  }
  const players = h('span', { className: 'lobby-players', title: data.playersLabel + ' players' });
  players.appendChild(icon('users', 16));
  players.appendChild(h('span', { text: data.playersLabel }));
  media.appendChild(players);
  card.appendChild(media);

  const body = h('div', { className: 'lobby-body' });
  body.appendChild(h('div', { className: 'lobby-name', text: data.name, title: data.name }));

  const host = h('div', { className: 'lobby-host' });
  host.appendChild(h('span', { className: 'dim', text: 'Hosted by ' }));
  host.appendChild(authorName(data.hostName, data.hostColor));
  body.appendChild(host);

  const mapLine = h('div', { className: 'lobby-map' });
  mapLine.appendChild(icon('map', 16));
  mapLine.appendChild(h('span', { className: 'lobby-map-name', text: data.mapName || 'Base game', title: data.mapName || 'Base game' }));
  body.appendChild(mapLine);

  const badges = h('div', { className: 'card-badges' });
  if (data.hard) badges.appendChild(h('span', { className: 'badge badge-hard', text: 'Hard mode' }));
  if (data.full) badges.appendChild(h('span', { className: 'badge', text: 'Full' }));
  if (badges.childNodes.length > 0) body.appendChild(badges);

  const actions = h('div', { className: 'lobby-actions' });
  const full = data.joinDisabled;
  const join = h('button', {
    className: 'btn btn-primary',
    title: data.joinTitle,
    attrs: full || !onJoin ? { type: 'button', disabled: 'disabled', 'aria-disabled': 'true' } : { type: 'button' },
  });
  const joinLabel = h('span', { text: 'Join (beta)' });
  join.appendChild(joinLabel);
  if (!full && onJoin) {
    join.addEventListener('click', () => {
      if (join.hasAttribute('disabled')) return;
      join.setAttribute('disabled', 'disabled');
      joinLabel.textContent = 'Starting…';
      onJoin(data, (message) => {
        joinLabel.textContent = message;
        window.setTimeout(() => { joinLabel.textContent = 'Join (beta)'; join.removeAttribute('disabled'); }, 4000);
      });
    });
  }
  // A disabled button gets no hover events in some engines, so the tooltip sits on a wrapper too.
  const joinWrap = h('span', { className: 'lobby-join', title: data.joinTitle });
  joinWrap.appendChild(join);
  actions.appendChild(joinWrap);
  if (data.getMapRoute) {
    actions.appendChild(h('a', { className: 'btn btn-secondary lobby-getmap', text: 'Get map', attrs: { href: data.getMapRoute } }));
  } else if (data.hubMapId && !data.hubMap && !data.hubUnknown) {
    actions.appendChild(h('span', { className: 'lobby-note dim', text: 'Map not on the hub', title: 'This map is not in the hub list' }));
  }
  body.appendChild(actions);
  card.appendChild(body);
  return card;
}
