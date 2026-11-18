/** Emoji catalog: built-in unicode sets plus the server-backed shared custom set. */

export interface CustomEmoji { shortcode: string; url: string }

/*
 * CUSTOM IGTAP EMOJI — old file-drop recipe (superseded by in-app upload).
 * Dropping art into the sibling emojis/ folder and listing it in CUSTOM_EMOJIS below still works as a fallback,
 * but the primary path is now: upload an image in the emoji picker; the social server stores it and serves it to everyone.
 */
export const CUSTOM_EMOJIS: CustomEmoji[] = [];
export const customByShort: Map<string, CustomEmoji> = new Map();

const listeners = new Set<() => void>();

/** Rebuild the live lookup from the server catalog; notifies pickers/messages to repaint. */
export function setCustomEmojis(list: CustomEmoji[]): void {
  CUSTOM_EMOJIS.length = 0;
  CUSTOM_EMOJIS.push(...list);
  customByShort.clear();
  for (const e of CUSTOM_EMOJIS) customByShort.set(e.shortcode, e);
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
