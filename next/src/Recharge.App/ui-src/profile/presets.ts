/** Ready-made looks, a random look and the "match my avatar" palette. DOM-free. Presets change style only, never your words. */
import { defaultExt, sanitize, type Ext } from './schema.js';

export interface Preset {
  id: string;
  label: string;
  /** The colours shown on its swatch. */
  swatch: string[];
  /** Style fields to lay over the current profile (name, avatar, banner and theme only). */
  style: Pick<Ext, 'name' | 'avatar' | 'banner' | 'theme'>;
}

interface Row {
  id: string; label: string;
  a: string; b: string; base: string;          // accent, second colour, dark base
  name?: 'solid' | 'gradient'; fx?: string[]; font?: string; weight?: string; spacing?: string;
  frame?: string; shape?: string; orn?: string; glow?: string;
  pattern?: string; anim?: string; bgrad?: boolean; height?: string;
  card?: string; corner?: string; bg?: string;
}

const ROWS: Row[] = [
  { id: 'mint-terminal', label: 'Mint terminal', a: '#41f88d', b: '#3ce6e6', base: '#0f2a1c', name: 'solid', fx: ['glow'], frame: 's-ring', pattern: 'scanlines', anim: 'sweep', card: 'glass', corner: 'soft', bg: 'grid' },
  { id: 'neon-night', label: 'Neon night', a: '#ff4fd8', b: '#4dd8ff', base: '#150a2b', name: 'gradient', fx: ['glow'], frame: 's-spin-gradient', glow: 'neon', pattern: 'grid', card: 'gradient', corner: 'round', bg: 'stars', anim: 'stars' },
  { id: 'sunset-drive', label: 'Sunset drive', a: '#ff9a3c', b: '#ff4d8d', base: '#2a0f2e', name: 'gradient', fx: ['shimmer'], frame: 'g-sunset', pattern: 'scanlines', card: 'gradient', corner: 'soft', bg: 'gradient' },
  { id: 'ocean-deep', label: 'Ocean deep', a: '#3ce6e6', b: '#1c4dd2', base: '#06182e', name: 'gradient', fx: ['glow'], frame: 'g-ocean', pattern: 'dots', anim: 'aurora', card: 'glass', corner: 'round', bg: 'aurora' },
  { id: 'ember', label: 'Ember', a: '#ffc23c', b: '#ff5d3c', base: '#2a1008', name: 'gradient', fx: ['glow', 'pulse'], frame: 'g-fire', pattern: 'none', anim: 'stars', card: 'solid', corner: 'sharp', bg: 'gradient' },
  { id: 'frost', label: 'Frost', a: '#e6f6ff', b: '#5cb4ff', base: '#0e2036', name: 'gradient', fx: ['shimmer'], frame: 'g-ice', pattern: 'hex', card: 'glass', corner: 'round', bg: 'dots' },
  { id: 'royal', label: 'Royal', a: '#e8c14b', b: '#4c5cff', base: '#0d1038', name: 'gradient', fx: ['shimmer'], font: 'serif', weight: 'bold', frame: 'duo-royal', orn: 'crown', pattern: 'none', card: 'solid', corner: 'soft', bg: 'gradient', glow: 'soft' },
  { id: 'gilded', label: 'Gilded', a: '#fff3b0', b: '#9a7418', base: '#1d1606', name: 'gradient', fx: ['shimmer'], font: 'serif', weight: 'bold', frame: 'g-gilded', pattern: 'none', card: 'solid', corner: 'soft', bg: 'color' },
  { id: 'toxic', label: 'Toxic', a: '#b6ff3c', b: '#1f5c1f', base: '#0a1a08', name: 'solid', fx: ['glow', 'outline'], frame: 'g-toxic', pattern: 'hex', anim: 'sweep', card: 'solid', corner: 'pixel', bg: 'grid', font: 'mono' },
  { id: 'candy', label: 'Candy', a: '#ff7ac8', b: '#ffffff', base: '#33122a', name: 'gradient', fx: ['pulse'], frame: 'g-candy', orn: 'ears', pattern: 'dots', card: 'gradient', corner: 'round', bg: 'dots', font: 'rounded' },
  { id: 'berry', label: 'Berry', a: '#d23ca8', b: '#6a3cd2', base: '#1d0a2a', name: 'gradient', fx: ['glow'], frame: 'duo-berry', pattern: 'stars', anim: 'stars', card: 'glass', corner: 'soft', bg: 'stars' },
  { id: 'aurora', label: 'Aurora', a: '#41f88d', b: '#9a5cff', base: '#081a24', name: 'gradient', fx: ['shimmer', 'glow'], frame: 'g-aurora', pattern: 'none', anim: 'aurora', card: 'glass', corner: 'round', bg: 'aurora', height: 'tall' },
  { id: 'monochrome', label: 'Monochrome', a: '#f9ffe4', b: '#8a8a8a', base: '#161616', name: 'solid', fx: [], frame: 'ring-white', pattern: 'grid', card: 'solid', corner: 'sharp', bg: 'none', font: 'mono' },
  { id: 'paper', label: 'Paper', a: '#2a2a2a', b: '#b8bcc4', base: '#d9d6cc', name: 'solid', fx: [], frame: 'ring-ink', pattern: 'dots', card: 'solid', corner: 'soft', bg: 'color', font: 'serif' },
  { id: 'blood-moon', label: 'Blood moon', a: '#ff4d4d', b: '#7a0f2a', base: '#1d0508', name: 'gradient', fx: ['glow'], frame: 'ring-red', orn: 'horns', pattern: 'scanlines', anim: 'stars', card: 'solid', corner: 'sharp', bg: 'stars', glow: 'neon' },
  { id: 'cyber-pink', label: 'Cyber pink', a: '#ff2d95', b: '#00e5ff', base: '#12082a', name: 'gradient', fx: ['pixel'], frame: 's-pixel-duo', shape: 'diamond', pattern: 'grid', anim: 'sweep', card: 'glass', corner: 'pixel', bg: 'grid', font: 'vt323' },
  { id: 'retro-arcade', label: 'Retro arcade', a: '#ffe14d', b: '#ff4d4d', base: '#0a0a24', name: 'solid', fx: ['pixel'], frame: 'pixel-gold', shape: 'squircle', pattern: 'scanlines', card: 'solid', corner: 'pixel', bg: 'dots', font: 'vt323', weight: 'bold', spacing: 'wide' },
  { id: 'vaporwave', label: 'Vaporwave', a: '#ff9ad5', b: '#9ad5ff', base: '#241142', name: 'gradient', fx: ['shimmer'], frame: 'g-holo', pattern: 'grid', anim: 'sweep', card: 'gradient', corner: 'soft', bg: 'gradient', spacing: 'wide' },
  { id: 'forest', label: 'Forest', a: '#7dd87d', b: '#2f7a4a', base: '#0c1d12', name: 'gradient', fx: [], frame: 's-double', orn: 'wreath', pattern: 'hex', card: 'solid', corner: 'soft', bg: 'color' },
  { id: 'sakura', label: 'Sakura', a: '#ffb7d5', b: '#ff7ac8', base: '#2a1422', name: 'gradient', fx: ['glow'], frame: 'ring-pink', orn: 'sparkles', pattern: 'dots', anim: 'stars', card: 'glass', corner: 'round', bg: 'dots', font: 'rounded' },
  { id: 'midnight', label: 'Midnight', a: '#4d8dff', b: '#9a5cff', base: '#070b1f', name: 'gradient', fx: ['glow'], frame: 's-spin-arc', pattern: 'stars', anim: 'stars', card: 'glass', corner: 'soft', bg: 'stars' },
  { id: 'lava-lamp', label: 'Lava lamp', a: '#ff9a3c', b: '#c63ed8', base: '#220a2e', name: 'gradient', fx: ['rainbow'], frame: 's-spin-comet', pattern: 'none', anim: 'aurora', card: 'gradient', corner: 'round', bg: 'aurora' },
  { id: 'rainbow-riot', label: 'Rainbow riot', a: '#ff4d4d', b: '#4d8dff', base: '#14142a', name: 'gradient', fx: ['rainbow'], frame: 'spin-rainbow-spin', pattern: 'dots', card: 'glass', corner: 'round', bg: 'dots', glow: 'soft' },
  { id: 'slate', label: 'Slate', a: '#9fb4c8', b: '#546a80', base: '#10161d', name: 'solid', fx: [], frame: 'ring-silver', pattern: 'grid', card: 'solid', corner: 'soft', bg: 'none', font: 'sans' },
  { id: 'copper', label: 'Copper', a: '#e08a4a', b: '#8a4a1f', base: '#1f120a', name: 'gradient', fx: ['shimmer'], frame: 's-thick', pattern: 'hex', card: 'solid', corner: 'soft', bg: 'color', font: 'typewriter' },
  { id: 'lime-pop', label: 'Lime pop', a: '#b6ff3c', b: '#ffe14d', base: '#142208', name: 'gradient', fx: ['pulse'], frame: 'ring-lime', shape: 'squircle', pattern: 'dots', card: 'solid', corner: 'round', bg: 'dots', font: 'rounded', weight: 'heavy' },
  { id: 'ghost', label: 'Ghost', a: '#f0f4ff', b: '#b8c4ff', base: '#161a2e', name: 'solid', fx: ['glow', 'pulse'], frame: 's-dotted', pattern: 'none', anim: 'stars', card: 'glass', corner: 'round', bg: 'stars', glow: 'soft', spacing: 'wide' },
  { id: 'magma', label: 'Magma', a: '#ffe14d', b: '#ff3c3c', base: '#1c0808', name: 'gradient', fx: ['glow'], frame: 'duo-ember', orn: 'flame', pattern: 'scanlines', anim: 'sweep', card: 'gradient', corner: 'sharp', bg: 'gradient', glow: 'neon' },
  { id: 'galaxy', label: 'Galaxy', a: '#c63ed8', b: '#3ce6e6', base: '#0a0620', name: 'gradient', fx: ['shimmer', 'glow'], frame: 'g-quarters', orn: 'star', pattern: 'stars', anim: 'stars', card: 'glass', corner: 'soft', bg: 'stars', height: 'hero' },
  { id: 'honey', label: 'Honey', a: '#ffe14d', b: '#1c1c1c', base: '#241c04', name: 'solid', fx: ['outline'], frame: 'g-bee', shape: 'hex', pattern: 'hex', card: 'solid', corner: 'soft', bg: 'color', weight: 'bold' },
  { id: 'robot', label: 'Robot', a: '#3ce6e6', b: '#546a80', base: '#0c1620', name: 'solid', fx: ['pixel'], frame: 's-pixel', shape: 'squircle', orn: 'antenna', pattern: 'grid', anim: 'sweep', card: 'solid', corner: 'pixel', bg: 'grid', font: 'mono' },
  { id: 'cat-cafe', label: 'Cat cafe', a: '#ffc9a0', b: '#d28a5a', base: '#2a1a14', name: 'gradient', fx: [], frame: 'ring-orange', orn: 'ears', pattern: 'dots', card: 'solid', corner: 'round', bg: 'color', font: 'rounded' },
  { id: 'angel', label: 'Angel', a: '#fff3b0', b: '#e6f6ff', base: '#1a2238', name: 'gradient', fx: ['glow'], frame: 'g-gilded', orn: 'halo', pattern: 'none', anim: 'aurora', card: 'glass', corner: 'round', bg: 'aurora', glow: 'soft' },
  { id: 'imp', label: 'Imp', a: '#ff4d4d', b: '#9a5cff', base: '#1a0a24', name: 'gradient', fx: ['outline'], frame: 'square-red', shape: 'squircle', orn: 'horns', pattern: 'stars', card: 'solid', corner: 'sharp', bg: 'stars' },
];

function build(r: Row): Preset {
  const d = defaultExt();
  const style: Preset['style'] = {
    name: {
      ...d.name,
      mode: r.name ?? 'solid',
      colors: r.name === 'gradient' ? [r.a, r.b] : [r.a],
      angle: 90,
      effects: r.fx ?? [],
      effectColor: null,
      font: r.font ?? 'vt323', weight: r.weight ?? 'normal', spacing: r.spacing ?? 'normal',
    },
    avatar: {
      ...d.avatar,
      shape: r.shape ?? 'circle', frame: r.frame ?? 'none', frameColors: [r.a, r.b],
      ornament: r.orn ?? 'none', ornamentColor: r.orn ? r.a : null, glow: r.glow ?? 'none',
    },
    banner: {
      ...d.banner,
      mode: 'gradient', colors: [r.base, r.a], angle: 135,
      pattern: r.pattern ?? 'none', anim: r.anim ?? 'none', height: r.height ?? 'normal', dim: 0, tint: null,
    },
    theme: {
      ...d.theme,
      accent: r.a, card: r.card ?? 'glass', bg: r.bg ?? 'none', bgColors: [r.base, r.b], corner: r.corner ?? 'soft', preset: r.id,
    },
  };
  return { id: r.id, label: r.label, swatch: [r.base, r.a, r.b], style };
}

export const PRESETS: Preset[] = ROWS.map(build);

export function presetById(id: string | null | undefined): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** A preset laid over a profile: only the look changes. The result is sanitised, so it can never be invalid. */
export function applyPreset(ext: Ext, preset: Preset): Ext {
  const copy = JSON.parse(JSON.stringify(preset.style)) as Preset['style'];
  // Keep a picture banner and your crop; presets only restyle the colours around it.
  const keepImage = ext.banner.mode === 'image';
  const banner = keepImage ? { ...copy.banner, mode: 'image', imgX: ext.banner.imgX, imgY: ext.banner.imgY, imgZoom: ext.banner.imgZoom } : copy.banner;
  const avatar = { ...copy.avatar, zoom: ext.avatar.zoom, x: ext.avatar.x, y: ext.avatar.y, status: ext.avatar.status };
  return sanitize({ ...ext, name: copy.name, avatar, banner, theme: copy.theme });
}

/* ---------------- random ---------------- */

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

function oneOf<T>(list: readonly T[], rng: () => number): T { return list[Math.floor(rng() * list.length) % list.length]; }

/** A random but tasteful look: a hue, a harmony, and whitelisted choices. `rng` returns [0, 1). */
export function randomStyle(rng: () => number = Math.random): Preset {
  const hue = rng() * 360;
  const harmony = oneOf([30, 60, 150, 180, 210], rng);
  const a = hsl(hue, 0.8 + rng() * 0.2, 0.6 + rng() * 0.1);
  const b = hsl((hue + harmony) % 360, 0.75, 0.55 + rng() * 0.15);
  const base = hsl(hue, 0.45, 0.08 + rng() * 0.05);
  const row: Row = {
    id: 'random', label: 'Random', a, b, base,
    name: rng() < 0.6 ? 'gradient' : 'solid',
    fx: rng() < 0.5 ? [oneOf(['glow', 'shimmer', 'pulse', 'outline'], rng)] : [],
    font: oneOf(['vt323', 'vt323', 'mono', 'sans', 'rounded', 'serif'], rng),
    weight: oneOf(['normal', 'normal', 'bold'], rng),
    frame: oneOf(['s-ring', 's-gradient', 's-double', 's-dashed', 's-spin-arc', 's-spin-gradient', 's-pixel', 'g-aurora', 's-segments', 's-spin-segments'], rng),
    shape: oneOf(['circle', 'circle', 'squircle', 'hex', 'diamond'], rng),
    orn: rng() < 0.3 ? oneOf(['crown', 'halo', 'ears', 'sparkles', 'star', 'flame'], rng) : undefined,
    glow: oneOf(['none', 'none', 'soft', 'neon'], rng),
    pattern: oneOf(['none', 'grid', 'dots', 'scanlines', 'stars', 'hex'], rng),
    anim: oneOf(['none', 'none', 'stars', 'aurora', 'sweep'], rng),
    card: oneOf(['glass', 'solid', 'gradient', 'pattern'], rng),
    corner: oneOf(['sharp', 'soft', 'round', 'pixel'], rng),
    bg: oneOf(['none', 'gradient', 'grid', 'dots', 'stars', 'aurora'], rng),
  };
  const preset = build(row);
  preset.style.theme.preset = null;
  return preset;
}

/* ---------------- match my avatar ---------------- */

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/**
 * The dominant colours of an RGBA pixel buffer: pixels are binned to 4 bits per channel, near-grey and near-transparent ones are
 * ignored, and the most common bins that are not alike are returned (most common first).
 */
export function dominantColors(data: ArrayLike<number>, count = 3): string[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (max < 40 || (sat < 0.18 && max < 235 && max > 30 && min > 30)) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  const sorted = [...bins.values()].sort((x, y) => y.n - x.n);
  const out: Array<[number, number, number]> = [];
  for (const bin of sorted) {
    const colour: [number, number, number] = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
    if (out.every((o) => Math.hypot(o[0] - colour[0], o[1] - colour[1], o[2] - colour[2]) > 70)) out.push(colour);
    if (out.length >= count) break;
  }
  return out.map(([r, g, b]) => toHex(r, g, b));
}

function shade(colour: string, factor: number): string {
  const n = parseInt(colour.slice(1), 16);
  return toHex(((n >> 16) & 255) * factor, ((n >> 8) & 255) * factor, (n & 255) * factor);
}

/** A look built from avatar colours (accent, second, third). Falls back to the default accent when the picture has no colour. */
export function paletteStyle(colors: string[]): Preset {
  const a = colors[0] ?? '#41f88d';
  const b = colors[1] ?? shade(a, 0.7);
  const base = shade(colors[2] ?? a, 0.18);
  const preset = build({ id: 'avatar', label: 'Match my avatar', a, b, base, name: 'gradient', fx: ['glow'], frame: 's-gradient', pattern: 'none', anim: 'aurora', card: 'glass', corner: 'soft', bg: 'gradient' });
  preset.style.theme.preset = null;
  return preset;
}
