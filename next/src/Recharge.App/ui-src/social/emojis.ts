/** Emoji catalog: built-in unicode sets plus the server-backed shared custom set. */

export interface CustomEmoji { shortcode: string; url: string }

/*
 * CUSTOM IGTAP EMOJI — old file-drop recipe (superseded by in-app upload).
 * Dropping art into the sibling emojis/ folder and listing it in CUSTOM_EMOJIS below still works as a fallback,
 * but the primary path is now: upload an image in the emoji picker; the social server stores it and serves it to everyone.
 */
// The full registry: every emoji that exists, so any :shortcode: renders for everyone.
export const CUSTOM_EMOJIS: CustomEmoji[] = [];
export const customByShort: Map<string, CustomEmoji> = new Map();
// The caller's arsenal: the subset their picker offers (own uploads + emoji unlocked by joining servers).
export const ARSENAL: CustomEmoji[] = [];

const listeners = new Set<() => void>();

/** Rebuild the render registry from the server catalog; notifies pickers/messages to repaint. */
export function setCustomEmojis(list: CustomEmoji[]): void {
  CUSTOM_EMOJIS.length = 0;
  CUSTOM_EMOJIS.push(...list);
  customByShort.clear();
  for (const e of CUSTOM_EMOJIS) customByShort.set(e.shortcode, e);
  for (const fn of listeners) fn();
}

/** Replace the caller's arsenal (what the picker shows); notifies pickers to repaint. */
export function setArsenal(list: CustomEmoji[]): void {
  ARSENAL.length = 0;
  ARSENAL.push(...list);
  for (const fn of listeners) fn();
}

/** Subscribe to registry changes; returns an unsubscribe function. */
export function onCustomEmojis(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export interface EmojiCategory { name: string; emojis: string[] }

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { name: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉', '😊', '😍', '🥰', '😎'] },
  { name: 'Gestures', emojis: ['👍', '👎', '👏', '🙌', '🤝', '🙏', '💪', '👋', '🤞', '✌️'] },
  { name: 'Hearts', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💖'] },
  { name: 'Objects', emojis: ['🔥', '✨', '🎉', '🎊', '🎮', '🏆', '⚡', '💎', '🚀', '🎵', '☕', '🍕'] },
];
