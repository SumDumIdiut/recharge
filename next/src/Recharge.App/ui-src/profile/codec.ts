/** Profile style codes: export a look as one string, import it back. DOM-free. */
import { sanitize, type Ext } from './schema.js';

const PREFIX = 'RP1.';

function b64encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64decode(code: string): string {
  const pad = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** The look only: name, avatar, banner, theme, section order and stats style. Never your words, links, picture or privacy. */
export function exportStyle(ext: Ext): string {
  const look = { name: ext.name, avatar: ext.avatar, banner: ext.banner, theme: ext.theme, sections: ext.sections, stats: { style: ext.stats.style } };
  return PREFIX + b64encode(JSON.stringify(look));
}

export const MAX_CODE = 6000;

/** Applies a style code over a profile. Anything outside the whitelist is dropped by the same sanitiser the server mirrors. */
export function importStyle(code: string, current: Ext): Ext {
  const text = String(code || '').trim().replace(/\s+/g, '');
  if (!text.startsWith(PREFIX)) throw new Error('That is not a Recharge profile style code.');
  if (text.length > MAX_CODE) throw new Error('That code is too long.');
  let look: unknown;
  try {
    look = JSON.parse(b64decode(text.slice(PREFIX.length)));
  } catch {
    throw new Error('That code is damaged.');
  }
  if (!look || typeof look !== 'object' || Array.isArray(look)) throw new Error('That code is damaged.');
  const l = look as Record<string, unknown>;
  const fresh = sanitize({
    ...current,
    name: l.name ?? current.name,
    avatar: l.avatar ? { ...(l.avatar as object), zoom: current.avatar.zoom, x: current.avatar.x, y: current.avatar.y } : current.avatar,
    banner: l.banner ? { ...(l.banner as object), mode: (l.banner as { mode?: string }).mode === 'image' && current.banner.mode !== 'image' ? 'gradient' : (l.banner as { mode?: string }).mode } : current.banner,
    theme: l.theme ?? current.theme,
    sections: l.sections ?? current.sections,
    stats: { ...current.stats, style: (l.stats as { style?: string } | undefined)?.style ?? current.stats.style },
  });
  return fresh;
}
