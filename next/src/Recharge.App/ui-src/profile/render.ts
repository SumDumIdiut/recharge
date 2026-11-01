/**
 * The one renderer for profile looks: name styles, avatars, banners, themes, bios and link chips. Everything is built from
 * descriptors (class names from fixed whitelists plus CSS custom properties holding validated colours and numbers), never from
 * raw CSS or markup. The descriptor functions are pure so they can be tested; the node builders only apply them.
 */
import { h } from '../dom.js';
import { ringFor, validHex } from '../community/format.js';
import {
  ANIMS, BGS, CARDS, CORNERS, EFFECTS, FONTS, GLOWS, HEIGHTS, ORNAMENTS, PATTERNS, SHAPES, SPACINGS, STATUS_STYLES, WEIGHTS,
  httpsUrl, type AvatarStyle, type BannerStyle, type NameStyle, type ThemeStyle,
} from './schema.js';

export interface Desc { classes: string[]; vars: Record<string, string> }

const vals = (list: Array<{ value: string }>): string[] => list.map((x) => x.value);

/* ---------------- whitelists (also used by the tests) ---------------- */

/** Every class a descriptor may produce. */
export const CLASS_WHITELIST: ReadonlySet<string> = new Set<string>([
  'pn', 'pn-clip', 'pn-compact', 'pa', 'pb', 'pt',
  ...vals(FONTS).map((x) => 'pn-font-' + x),
  ...vals(WEIGHTS).map((x) => 'pn-w-' + x),
  ...vals(SPACINGS).map((x) => 'pn-sp-' + x),
  ...vals(EFFECTS).map((x) => 'pn-fx-' + x),
  ...vals(SHAPES).map((x) => 'pa-shape-' + x),
  ...vals(GLOWS).map((x) => 'pa-glow-' + x),
  ...vals(ORNAMENTS).map((x) => 'pa-orn-' + x),
  ...vals(PATTERNS).map((x) => 'pb-pat-' + x),
  ...vals(ANIMS).map((x) => 'pb-anim-' + x),
  ...vals(HEIGHTS).map((x) => 'pb-h-' + x),
  'pb-image', 'pb-tinted', 'pb-dimmed',
  ...vals(CARDS).map((x) => 'pt-card-' + x),
  ...vals(CORNERS).map((x) => 'pt-corner-' + x),
  ...vals(BGS).map((x) => 'pt-bg-' + x),
]);

/** The only custom properties a descriptor may set. */
export const VAR_WHITELIST: ReadonlySet<string> = new Set([
  '--pn-color', '--pn-fill', '--pn-glow', '--pn-edge',
  '--pa-zoom', '--pa-x', '--pa-y', '--pa-glow', '--pa-orn',
  '--pb-bg', '--pb-zoom', '--pb-x', '--pb-y', '--pb-dim', '--pb-tint', '--pb-c1', '--pb-c2',
  '--pt-accent', '--pt-bg1', '--pt-bg2',
]);

/** What a descriptor value may look like: a colour, a number with an optional unit, or a gradient made of those. */
export const VALUE_PATTERN = /^(#[0-9a-f]{6}|-?\d+(\.\d+)?(%|deg)?|(linear-gradient)\(\d{1,3}deg(, #[0-9a-f]{6}){2,4}\))$/;

function color(value: unknown, fallback: string): string { return validHex(value) ?? fallback; }
function gradient(angle: number, stops: string[]): string {
  return 'linear-gradient(' + Math.max(0, Math.min(360, Math.round(angle))) + 'deg, ' + stops.join(', ') + ')';
}

/* ---------------- descriptors ---------------- */

/** Classes and variables for a name. `fallback` is the colour to use when the style has none (the hub's name colour). */
export function nameDesc(n: NameStyle, options: { compact?: boolean; fallback?: string | null } = {}): Desc {
  const compact = !!options.compact;
  const classes = ['pn'];
  const vars: Record<string, string> = {};
  const spacing = compact && n.spacing === 'wider' ? 'wide' : n.spacing;
  classes.push('pn-font-' + n.font, 'pn-w-' + n.weight, 'pn-sp-' + spacing);
  if (compact) classes.push('pn-compact');
  const stops = n.colors.map((x) => color(x, '#41f88d'));
  const effects = n.effects.filter((e) => !(compact && e === 'pulse'));
  const base = n.mode === 'default' ? validHex(options.fallback) ?? null : stops[0];
  if (n.mode === 'gradient' && stops.length >= 2) {
    vars['--pn-fill'] = gradient(n.angle, stops);
    classes.push('pn-clip');
  } else if (n.mode === 'solid') {
    vars['--pn-color'] = stops[0];
    if (effects.includes('shimmer')) { vars['--pn-fill'] = gradient(90, [stops[0], stops[0]]); classes.push('pn-clip'); }
  } else if (base) {
    vars['--pn-color'] = base;
    if (effects.includes('shimmer')) { vars['--pn-fill'] = gradient(90, [base, base]); classes.push('pn-clip'); }
  } else if (effects.includes('shimmer')) {
    vars['--pn-fill'] = gradient(90, ['#41f88d', '#41f88d']);
    classes.push('pn-clip');
  }
  for (const e of effects) classes.push('pn-fx-' + e);
  vars['--pn-glow'] = color(n.effectColor, base ?? stops[0]);
  vars['--pn-edge'] = color(n.effectColor, '#0c1a10');
  return { classes, vars };
}

export function avatarDesc(a: AvatarStyle, options: { size?: number } = {}): Desc {
  const classes = ['pa', 'pa-shape-' + a.shape];
  const ring = ringFor(a.frame, a.frameColors);
  const glowColor = a.frameColors[0] ?? (ring ? ringColor(a.frame) : '#41f88d');
  if (a.glow !== 'none') classes.push('pa-glow-' + a.glow);
  const showOrnament = a.ornament !== 'none' && (options.size ?? 100) >= 40;
  if (showOrnament) classes.push('pa-orn-' + a.ornament);
  return {
    classes,
    vars: {
      '--pa-zoom': String(Math.round(a.zoom) / 100),
      '--pa-x': Math.round(a.x) + '%',
      '--pa-y': Math.round(a.y) + '%',
      '--pa-glow': color(glowColor, '#41f88d'),
      '--pa-orn': color(a.ornamentColor ?? a.frameColors[0], '#e8c14b'),
    },
  };
}

function ringColor(frame: string): string {
  const r = ringFor(frame, []);
  const m = r ? /#[0-9a-fA-F]{6}/.exec(r.background) : null;
  return m ? m[0].toLowerCase() : '#41f88d';
}

export function bannerDesc(b: BannerStyle): Desc {
  const classes = ['pb', 'pb-h-' + b.height, 'pb-pat-' + b.pattern, 'pb-anim-' + b.anim];
  const stops = b.colors.map((x) => color(x, '#1f3a2a'));
  const vars: Record<string, string> = {};
  if (b.mode === 'gradient' && stops.length >= 2) vars['--pb-bg'] = gradient(b.angle, stops);
  else vars['--pb-bg'] = stops[0];
  vars['--pb-c1'] = stops[0];
  vars['--pb-c2'] = stops[1] ?? stops[0];
  if (b.mode === 'image') {
    classes.push('pb-image');
    vars['--pb-zoom'] = String(Math.round(b.imgZoom) / 100);
    vars['--pb-x'] = Math.round(b.imgX) + '%';
    vars['--pb-y'] = Math.round(b.imgY) + '%';
  }
  if (b.dim > 0) { classes.push('pb-dimmed'); vars['--pb-dim'] = String(Math.round(b.dim) / 100); }
  if (b.tint) { classes.push('pb-tinted'); vars['--pb-tint'] = color(b.tint, '#000000'); }
  return { classes, vars };
}

export function themeDesc(t: ThemeStyle, options: { fallbackAccent?: string | null } = {}): Desc {
  const classes = ['pt', 'pt-card-' + t.card, 'pt-corner-' + t.corner, 'pt-bg-' + t.bg];
  const vars: Record<string, string> = {};
  const accent = t.accent ?? validHex(options.fallbackAccent);
  if (accent) vars['--pt-accent'] = accent;
  const bg = t.bgColors.map((x) => color(x, '#101a14'));
  vars['--pt-bg1'] = bg[0];
  vars['--pt-bg2'] = bg[1] ?? bg[0];
  return { classes, vars };
}

export function applyDesc(node: HTMLElement, desc: Desc): void {
  for (const name of desc.classes) if (CLASS_WHITELIST.has(name)) node.classList.add(name);
  for (const [key, value] of Object.entries(desc.vars)) if (VAR_WHITELIST.has(key) && VALUE_PATTERN.test(value)) node.style.setProperty(key, value);
}

/** Take away every class and variable a descriptor may have set (before restyling the same node). */
export function clearDesc(node: HTMLElement): void {
  for (const name of [...node.classList]) if (CLASS_WHITELIST.has(name)) node.classList.remove(name);
  for (const key of VAR_WHITELIST) node.style.removeProperty(key);
}

/* ---------------- names ---------------- */

/** Style an existing element as a name. The legacy hub colour is kept when the extended style has no colour. */
export function styleName(node: HTMLElement, name: NameStyle | null, options: { compact?: boolean; legacy?: { color?: string; background?: string } | null } = {}): void {
  clearDesc(node);
  node.style.removeProperty('color');
  node.style.removeProperty('background');
  node.style.removeProperty('background-clip');
  node.style.removeProperty('-webkit-background-clip');
  const legacy = options.legacy ?? null;
  if (!name) { applyLegacy(node, legacy); return; }
  let fallback: string | null = null;
  if (name.mode === 'default') {
    if (legacy && legacy.background) {
      applyLegacy(node, legacy);
      const desc = nameDesc(name, options);
      applyDesc(node, { classes: desc.classes.filter((x) => x !== 'pn-clip'), vars: desc.vars });
      return;
    }
    fallback = legacy && legacy.color ? legacy.color : null;
  }
  applyDesc(node, nameDesc(name, { compact: options.compact, fallback }));
}

function applyLegacy(node: HTMLElement, legacy: { color?: string; background?: string } | null): void {
  if (!legacy) return;
  if (legacy.color) node.style.color = legacy.color;
  if (legacy.background) {
    node.style.background = legacy.background;
    node.style.setProperty('-webkit-background-clip', 'text');
    node.style.backgroundClip = 'text';
    node.style.color = 'transparent';
  }
}

/* ---------------- avatars ---------------- */

const PALETTE = ['#c63ed8', '#41f88d', '#3ce6e6', '#ff9a3c', '#4d8dff', '#ff7ac8', '#b6ff3c', '#9a5cff'];

/** A stable colour for the initials badge, from the name. */
export function fallbackColor(name: string): string {
  let sum = 0;
  for (const ch of name) sum = (sum * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[sum % PALETTE.length];
}

/** The 200x200 drawing space of an ornament: the avatar fills the middle (50 to 150), the ornament sits around it. */
const SVG_NS = 'http://www.w3.org/2000/svg';

function star(cx: number, cy: number, outer: number, inner: number, points: number): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / points) * i - Math.PI / 2;
    out.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return out.join(' ');
}

type Shape = { tag: string; attrs: Record<string, string> };

function wreath(): Shape[] {
  const shapes: Shape[] = [];
  for (let k = 0; k < 9; k++) {
    for (const side of [-1, 1]) {
      const theta = ((20 + k * 17) * Math.PI) / 180;
      const x = 100 + side * 62 * Math.sin(theta);
      const y = 100 + 62 * Math.cos(theta);
      const rot = Math.round(-side * (20 + k * 17));
      shapes.push({ tag: 'ellipse', attrs: { cx: x.toFixed(1), cy: y.toFixed(1), rx: '10', ry: '4.5', transform: 'rotate(' + rot + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')', fill: 'var(--pa-orn)', stroke: '#0c1a10', 'stroke-width': '1' } });
    }
  }
  return shapes;
}

const SPARKLE = 'M0,-11 L3,-3 L11,0 L3,3 L0,11 L-3,3 L-11,0 L-3,-3 Z';
const FILL = { fill: 'var(--pa-orn)', stroke: '#0c1a10', 'stroke-width': '2', 'stroke-linejoin': 'round' };

export const ORNAMENT_SHAPES: Record<string, Shape[]> = {
  crown: [
    { tag: 'polygon', attrs: { points: '62,54 64,18 83,36 100,8 117,36 136,18 138,54', ...FILL } },
    { tag: 'circle', attrs: { cx: '64', cy: '16', r: '4.5', fill: '#f9ffe4' } },
    { tag: 'circle', attrs: { cx: '100', cy: '7', r: '4.5', fill: '#f9ffe4' } },
    { tag: 'circle', attrs: { cx: '136', cy: '16', r: '4.5', fill: '#f9ffe4' } },
  ],
  halo: [{ tag: 'ellipse', attrs: { cx: '100', cy: '28', rx: '36', ry: '9', fill: 'none', stroke: 'var(--pa-orn)', 'stroke-width': '6' } }],
  ears: [
    { tag: 'polygon', attrs: { points: '54,74 56,16 98,52', ...FILL } },
    { tag: 'polygon', attrs: { points: '146,74 144,16 102,52', ...FILL } },
    { tag: 'polygon', attrs: { points: '64,60 65,32 86,50', fill: '#0c1a10', opacity: '0.35' } },
    { tag: 'polygon', attrs: { points: '136,60 135,32 114,50', fill: '#0c1a10', opacity: '0.35' } },
  ],
  horns: [
    { tag: 'path', attrs: { d: 'M66,62 C40,52 36,20 56,6 C54,28 74,38 84,50 Z', ...FILL } },
    { tag: 'path', attrs: { d: 'M134,62 C160,52 164,20 144,6 C146,28 126,38 116,50 Z', ...FILL } },
  ],
  sparkles: [
    { tag: 'path', attrs: { d: SPARKLE, transform: 'translate(42 48)', ...FILL } },
    { tag: 'path', attrs: { d: SPARKLE, transform: 'translate(164 70) scale(0.8)', ...FILL } },
    { tag: 'path', attrs: { d: SPARKLE, transform: 'translate(152 162) scale(1.1)', ...FILL } },
    { tag: 'path', attrs: { d: SPARKLE, transform: 'translate(46 150) scale(0.7)', ...FILL } },
  ],
  antenna: [
    { tag: 'path', attrs: { d: 'M84,54 L70,20 M116,54 L130,20', fill: 'none', stroke: 'var(--pa-orn)', 'stroke-width': '5', 'stroke-linecap': 'round' } },
    { tag: 'circle', attrs: { cx: '69', cy: '16', r: '7', ...FILL } },
    { tag: 'circle', attrs: { cx: '131', cy: '16', r: '7', ...FILL } },
  ],
  wreath: wreath(),
  flame: [
    { tag: 'path', attrs: { d: 'M100,4 C114,22 124,32 114,54 C108,44 104,44 100,48 C96,44 92,44 86,54 C76,32 86,22 100,4 Z', ...FILL } },
    { tag: 'path', attrs: { d: 'M70,22 C78,32 82,38 76,52 C72,46 68,46 64,50 C60,38 64,30 70,22 Z', ...FILL } },
    { tag: 'path', attrs: { d: 'M130,22 C138,32 142,38 136,52 C132,46 128,46 124,50 C120,38 124,30 130,22 Z', ...FILL } },
  ],
  star: [{ tag: 'polygon', attrs: { points: star(100, 26, 24, 10, 5), ...FILL } }],
};

export function ornamentSvg(id: string): SVGSVGElement | null {
  const shapes = ORNAMENT_SHAPES[id];
  if (!shapes) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('class', 'pa-ornament');
  svg.setAttribute('aria-hidden', 'true');
  for (const shape of shapes) {
    const el = document.createElementNS(SVG_NS, shape.tag);
    for (const [k, v] of Object.entries(shape.attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

export interface AvatarOptions {
  username: string;
  /** The hub's frame and frame colours; the extended style's own win when there is one. */
  frame: string;
  frameColors: string[];
  nameColor?: string | null;
  avatarPath: string | null;
  size?: number;
  style?: AvatarStyle | null;
  /** Presence to draw a status marker for ('online', 'lobby', 'editing', 'game'); nothing for offline or unknown. */
  presence?: string | null;
  load?: (path: string) => Promise<string | null>;
  /** An image that is already loaded (a blob: URL), for the live preview. */
  src?: string | null;
}

function initial(name: string): string {
  const ch = [...String(name || '').trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

/** Rebuilds an avatar's frame, shape and extras in place (used when a profile arrives after the first paint). */
export function avatarNode(o: AvatarOptions): HTMLElement {
  const root = h('span', { className: 'pavatar' });
  paintAvatar(root, o);
  return root;
}

export function paintAvatar(root: HTMLElement, o: AvatarOptions): void {
  const size = o.size ?? 36;
  const style = o.style ?? null;
  const frame = style ? style.frame : o.frame;
  const colors = style ? style.frameColors : o.frameColors;
  const ring = ringFor(frame, colors);
  clearDesc(root);
  root.className = 'pavatar' + (ring ? ' has-ring' : '') + (ring && ring.square && (!style || style.shape === 'circle') ? ' is-square' : '');
  root.replaceChildren();
  root.style.setProperty('--av', size + 'px');
  if (style) applyDesc(root, avatarDesc(style, { size }));
  if (ring) {
    root.style.setProperty('--ring', ring.background);
    root.style.setProperty('--ring-w', Math.max(2, Math.round(size * ring.weight)) + 'px');
    if (ring.gap) root.classList.add('has-gap');
    if (ring.spin) root.classList.add('is-spin');
    root.appendChild(h('span', { className: 'pavatar-ring' }, h('span', { className: 'pavatar-ring-fill' })));
  } else {
    root.style.removeProperty('--ring');
  }
  const face = h('span', { className: 'pavatar-face', attrs: { role: 'img', 'aria-label': o.username } });
  face.style.setProperty('--face', validHex(o.nameColor) || fallbackColor(o.username));
  face.appendChild(h('span', { className: 'pavatar-initial', text: initial(o.username) }));
  root.appendChild(face);
  const attach = (url: string | null): void => {
    if (!url || !root.contains(face)) return;
    const image = h('img', { attrs: { src: url, alt: '', decoding: 'async', draggable: 'false' } });
    image.addEventListener('error', () => image.remove());
    face.appendChild(image);
  };
  if (o.src) attach(o.src);
  else if (o.avatarPath && o.load) void o.load(o.avatarPath).then(attach);
  if (style && style.ornament !== 'none' && size >= 40) {
    const svg = ornamentSvg(style.ornament);
    if (svg) root.appendChild(svg);
  }
  const state = o.presence && o.presence !== 'offline' ? o.presence : null;
  if (state && (!style || style.status !== 'none')) {
    const kind = style ? style.status : 'dot';
    const live = ['online', 'lobby', 'editing', 'game'].includes(state) ? state : 'online';
    root.appendChild(h('span', { className: 'pa-status pa-st-' + kind + ' pa-on-' + live, attrs: { 'aria-hidden': 'true' } }));
  }
}

/* ---------------- banners ---------------- */

export const SAFE_IMAGE = /^(blob:[A-Za-z0-9:/._-]{1,200}|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{1,2000000})$/;

/** A banner: colour or gradient (or a picture, when `imageUrl` is a safe blob/data URL), pattern, animation, dim and tint. */
export function bannerNode(style: BannerStyle, imageUrl: string | null): HTMLElement {
  const root = h('div', { className: 'profile-banner' });
  paintBanner(root, style, imageUrl);
  return root;
}

export function paintBanner(root: HTMLElement, style: BannerStyle, imageUrl: string | null): void {
  clearDesc(root);
  root.className = 'profile-banner';
  root.style.removeProperty('--pb-img');
  root.replaceChildren();
  applyDesc(root, bannerDesc(style));
  root.appendChild(h('div', { className: 'pb-base' }));
  if (style.mode === 'image' && imageUrl && SAFE_IMAGE.test(imageUrl)) {
    root.style.setProperty('--pb-img', 'url("' + imageUrl + '")');
    root.appendChild(h('div', { className: 'pb-img' }));
  }
  root.appendChild(h('div', { className: 'pb-layer pb-pattern' }));
  root.appendChild(h('div', { className: 'pb-layer pb-motion' }));
  root.appendChild(h('div', { className: 'pb-layer pb-shade' }));
}

/* ---------------- bio ---------------- */

export type BioNode =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'b' | 'i'; c: BioNode[] }
  | { t: 'a'; href: string; c: BioNode[] };

const TOKEN_SOURCE = /\[([^\]\n]{1,100})\]\((https:\/\/[^\s)]{1,192})\)|\*\*([^\n]+?)\*\*|\*([^*\n]+?)\*|(https:\/\/[^\s<>"'`\\{}|^]{4,192})/;

function parseInline(text: string, depth: number): BioNode[] {
  const out: BioNode[] = [];
  let last = 0;
  // A fresh regex per call: the inner calls for bold and italic must not disturb this scan's position.
  const token = new RegExp(TOKEN_SOURCE.source, 'g');
  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const href = httpsUrl(m[2]);
      if (href) out.push({ t: 'a', href, c: [{ t: 'text', v: m[1] }] });
      else out.push({ t: 'text', v: m[0] });
    } else if (m[3] !== undefined) {
      out.push({ t: 'b', c: depth < 2 ? parseInline(m[3], depth + 1) : [{ t: 'text', v: m[3] }] });
    } else if (m[4] !== undefined) {
      out.push({ t: 'i', c: depth < 2 ? parseInline(m[4], depth + 1) : [{ t: 'text', v: m[4] }] });
    } else if (m[5] !== undefined) {
      // A bare link: trailing punctuation belongs to the sentence.
      const trail = /[.,;:!?)\]]+$/.exec(m[5]);
      const raw = trail ? m[5].slice(0, m[5].length - trail[0].length) : m[5];
      const href = httpsUrl(raw);
      if (href) { out.push({ t: 'a', href, c: [{ t: 'text', v: raw }] }); if (trail) out.push({ t: 'text', v: trail[0] }); }
      else out.push({ t: 'text', v: m[5] });
    }
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/** The safe formatting: **bold**, *italic*, [text](https://link), bare https links and line breaks. Everything else stays literal text. */
export function parseBio(text: string): BioNode[] {
  const out: BioNode[] = [];
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'br' });
    out.push(...parseInline(line, 0));
  });
  return out;
}

/** The bio as plain text (what the hub stores): markers dropped, links as "text (url)". */
export function bioPlainText(text: string): string {
  const flat = (nodes: BioNode[]): string => nodes.map((n) => {
    if (n.t === 'text') return n.v;
    if (n.t === 'br') return '\n';
    if (n.t === 'a') {
      const label = flat(n.c);
      return label === n.href ? label : label + ' (' + n.href + ')';
    }
    return flat(n.c);
  }).join('');
  return flat(parseBio(text));
}

export function bioNodes(text: string, open: (href: string) => void): Node[] {
  const build = (nodes: BioNode[]): Node[] => nodes.map((n): Node => {
    switch (n.t) {
      case 'text': return document.createTextNode(n.v);
      case 'br': return document.createElement('br');
      case 'a': {
        const a = h('a', { className: 'bio-link', attrs: { href: n.href, rel: 'noopener noreferrer' }, title: n.href }, ...build(n.c));
        a.addEventListener('click', (event) => { event.preventDefault(); open(n.href); });
        return a;
      }
      case 'b': return h('strong', {}, ...build(n.c));
      default: return h('em', {}, ...build(n.c));
    }
  });
  return build(parseBio(text));
}

/* ---------------- links ---------------- */

export interface LinkInfo { id: string; label: string; mark: string; color: string }

const SITES: Array<[string[], LinkInfo]> = [
  [['youtube.com', 'youtu.be'], { id: 'youtube', label: 'YouTube', mark: 'YT', color: '#ff3b3b' }],
  [['discord.gg', 'discord.com', 'discordapp.com'], { id: 'discord', label: 'Discord', mark: 'DC', color: '#6a74ff' }],
  [['patreon.com'], { id: 'patreon', label: 'Patreon', mark: 'PA', color: '#ff7a59' }],
  [['github.com'], { id: 'github', label: 'GitHub', mark: 'GH', color: '#b8bcc4' }],
  [['twitch.tv'], { id: 'twitch', label: 'Twitch', mark: 'TV', color: '#a970ff' }],
  [['twitter.com', 'x.com'], { id: 'x', label: 'X', mark: 'X', color: '#e6e6e6' }],
  [['ko-fi.com'], { id: 'kofi', label: 'Ko-fi', mark: 'KF', color: '#4fc3f7' }],
  [['steamcommunity.com', 'steampowered.com'], { id: 'steam', label: 'Steam', mark: 'ST', color: '#66c0f4' }],
  [['reddit.com'], { id: 'reddit', label: 'Reddit', mark: 'RD', color: '#ff6a33' }],
  [['bsky.app'], { id: 'bluesky', label: 'Bluesky', mark: 'BS', color: '#4d9dff' }],
  [['itch.io'], { id: 'itch', label: 'itch.io', mark: 'IT', color: '#ff5d6c' }],
  [['tiktok.com'], { id: 'tiktok', label: 'TikTok', mark: 'TT', color: '#3ce6e6' }],
  [['instagram.com'], { id: 'instagram', label: 'Instagram', mark: 'IG', color: '#ff6fb5' }],
  [['speedrun.com'], { id: 'speedrun', label: 'speedrun.com', mark: 'SR', color: '#ffe14d' }],
];

/** The service a link points at (matched on the exact host or a subdomain, never on a substring), or a generic link. */
export function linkInfo(url: string): LinkInfo {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* generic */ }
  for (const [hosts, info] of SITES) {
    if (hosts.some((d) => host === d || host.endsWith('.' + d))) return info;
  }
  return { id: 'web', label: host.replace(/^www\./, '') || 'Link', mark: 'WW', color: '#41f88d' };
}

// The linked site's own icon, fetched by the app (site.icon) and kept as one blob URL per host.
const siteIcons = new Map<string, Promise<string | null>>();
export function siteIconUrl(url: string): Promise<string | null> {
  let host = '';
  try { const u = new URL(url); if (u.protocol !== 'https:') return Promise.resolve(null); host = u.hostname.toLowerCase(); } catch { return Promise.resolve(null); }
  let pending = siteIcons.get(host);
  if (!pending) {
    const bridge = (window as unknown as { recharge?: { call(cmd: string, args: unknown): Promise<{ mime?: string; data?: string | null }> } }).recharge;
    pending = !bridge ? Promise.resolve(null) : bridge.call('site.icon', { url: 'https://' + host + '/' }).then((r) => {
      if (!r || !r.data || !r.mime) return null;
      const raw = atob(r.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: r.mime }));
    }, () => null);
    siteIcons.set(host, pending);
  }
  return pending;
}

/** Swaps a link's lettered mark for the site's own icon once (and if) it loads. */
export function applySiteIcon(mark: HTMLElement, url: string): void {
  void siteIconUrl(url).then((src) => {
    if (!src) return;
    const img = h('img', { className: 'plink-logo', attrs: { alt: '', src, decoding: 'async' } });
    img.addEventListener('load', () => { mark.replaceChildren(img); mark.classList.add('has-logo'); }, { once: true });
  });
}

export function linkChip(link: { url: string; label: string }, open: (href: string) => void): HTMLElement {
  const info = linkInfo(link.url);
  const a = h('a', { className: 'plink', attrs: { href: link.url, rel: 'noopener noreferrer' }, title: link.url });
  const ic = h('span', { className: 'plink-ic', text: info.mark });
  ic.style.setProperty('--ic', info.color);
  applySiteIcon(ic, link.url);
  a.append(ic, h('span', { className: 'plink-text', text: link.label || info.label }));
  a.addEventListener('click', (event) => { event.preventDefault(); open(link.url); });
  return a;
}
