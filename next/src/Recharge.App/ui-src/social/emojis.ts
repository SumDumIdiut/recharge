/** Emoji catalog: built-in unicode sets plus the extensible custom-IGTAP list. */

export interface CustomEmoji { shortcode: string; url: string }

/*
 * CUSTOM IGTAP EMOJI — how to add art (client-only)
 * 1. Drop the image into the sibling emojis/ folder, e.g. emojis/igtap_jump.webp.
 * 2. Add one entry to CUSTOM_EMOJIS below:
 *      { shortcode: 'igtap_jump', url: 'social/emojis/igtap_jump.webp' }
 * The URL is a plain path from the app root (ui/), matching social/social.css and
 * amp/art/*.png — build-ui copies assets verbatim, no bundler / import.meta rewriting.
 * Type :igtap_jump: in chat (or click it in the emoji picker) to render the art inline.
 */
export const CUSTOM_EMOJIS: CustomEmoji[] = [];
export const customByShort: Map<string, CustomEmoji> = new Map(CUSTOM_EMOJIS.map((e) => [e.shortcode, e]));

export interface EmojiCategory { name: string; emojis: string[] }

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { name: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉', '😊', '😍', '🥰', '😎'] },
  { name: 'Gestures', emojis: ['👍', '👎', '👏', '🙌', '🤝', '🙏', '💪', '👋', '🤞', '✌️'] },
  { name: 'Hearts', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💖'] },
  { name: 'Objects', emojis: ['🔥', '✨', '🎉', '🎊', '🎮', '🏆', '⚡', '💎', '🚀', '🎵', '☕', '🍕'] },
];
