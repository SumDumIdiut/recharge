/** Avatars with frames, and names in their own colour. */
import { h } from '../dom.js';
import { authorName } from '../components/itemCard.js';
import { go } from '../navigation.js';
import { hubImage } from './api.js';
import { profileRoute, type Author } from './format.js';
import { avatarNode, paintAvatar, type AvatarOptions } from '../profile/render.js';
import { watchStyle } from '../profile/store.js';
import type { AvatarStyle } from '../profile/schema.js';

export { fallbackColor } from '../profile/render.js';

export interface AvatarSource {
  username: string;
  avatar_url: string | null;
  frame: string;
  frame_colors: string[];
  name_color?: string | null;
}

export interface AvatarExtras {
  /** The extended look, when the caller already has it (the profile page); otherwise it is looked up in the shared cache. */
  style?: AvatarStyle | null;
  /** Show a status marker for this presence state. */
  presence?: string | null;
}

/** The picture (or the first letter) inside its frame, at a fixed size so lists never jump. */
export function playerAvatar(user: AvatarSource, size = 36, extras: AvatarExtras = {}): HTMLElement {
  const options = (style: AvatarStyle | null): AvatarOptions => ({
    username: user.username, frame: user.frame, frameColors: user.frame_colors, nameColor: user.name_color ?? null,
    avatarPath: user.avatar_url, size, style, presence: extras.presence ?? null, load: hubImage,
  });
  const root = avatarNode(options(extras.style ?? null));
  if (extras.style === undefined && user.username && user.username !== '[deleted]') {
    watchStyle(user.username, (look) => { if (look) paintAvatar(root, options(look.avatar)); });
  }
  return root;
}

/** A name in its owner's colour that opens the profile. */
export function nameLink(user: Author | { username: string; name_color: string | null }, className = 'author'): HTMLElement {
  const link = h('a', { className: 'user-link', attrs: { href: profileRoute(user.username) }, title: user.username });
  link.appendChild(authorName(user.username, user.name_color, className));
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}

/** Avatar plus name, side by side. */
export function personChip(user: Author, size = 28): HTMLElement {
  const chip = h('span', { className: 'person' });
  chip.appendChild(playerAvatar(user, size));
  chip.appendChild(nameLink(user));
  return chip;
}

/** Make a whole card open a profile on click while keeping inner links working. */
export function openProfileOnClick(node: HTMLElement, username: string): void {
  node.addEventListener('click', () => go(profileRoute(username)));
}
