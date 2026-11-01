/** Mapping between the hub's few profile fields and the extended profile. DOM-free. */
import { buildGradient, parseNameColor, type Profile } from '../community/format.js';
import { bioPlainText } from './render.js';
import { EXCLUSIVE_FRAMES } from './exclusive.js';
import { defaultExt, frameColorCount, httpsUrl, knownFrame, sanitize, type Ext } from './schema.js';

/** A profile for somebody who has none yet (or a logged-out look at one): built from what the hub stores. */
export function extFromHub(p: Profile): Ext {
  const d = defaultExt();
  const nameColor = p.author.name_color ? parseNameColor(p.author.name_color) : null;
  const links = p.links.map(httpsUrl).filter((l): l is string => !!l).map((url) => ({ url, label: '' }));
  return sanitize({
    ...d,
    name: nameColor
      ? { ...d.name, mode: nameColor.mode, colors: nameColor.colors.slice(0, 4), angle: nameColor.angle }
      : d.name,
    avatar: { ...d.avatar, frame: knownFrame(p.author.frame), frameColors: p.author.frame_colors.slice(0, 2) },
    banner: { ...d.banner, mode: p.bannerUrl ? 'image' : 'gradient', colors: [p.bannerColor || '#1f3a2a', p.accentColor || '#c63ed8'] },
    theme: { ...d.theme, accent: p.accentColor },
    content: { ...d.content, bio: p.bio, pronouns: p.pronouns || '', links },
  });
}

export interface HubFields {
  name_color: string;
  frame: string;
  frame_colors: string[];
  banner_color: string;
  accent_color: string;
  bio: string;
  pronouns: string | null;
  links: string[];
}

/** What to write to the hub (PUT /api/me/profile) so everything that only knows the hub still looks right. */
export function hubFields(ext: Ext): HubFields {
  const n = ext.name;
  let nameColor = '';
  if (n.mode === 'solid') nameColor = n.colors[0];
  else if (n.mode === 'gradient') nameColor = buildGradient(n.angle, n.colors) ?? n.colors[0];
  const count = frameColorCount(ext.avatar.frame);
  const bio = bioPlainText(ext.content.bio);
  return {
    name_color: nameColor,
    frame: EXCLUSIVE_FRAMES[ext.avatar.frame]?.hubFallback ?? ext.avatar.frame,
    frame_colors: [...ext.avatar.frameColors, '#41f88d', '#c63ed8'].slice(0, count),
    banner_color: ext.banner.colors[0],
    accent_color: ext.theme.accent ?? '',
    bio: [...bio].slice(0, 300).join(''),
    pronouns: ext.content.pronouns || null,
    links: ext.content.links.slice(0, 3).map((l) => l.url),
  };
}
