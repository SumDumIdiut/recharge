/**
 * Styles that belong to one player. The social server refuses them on anyone else's profile (Profiles.cs ExclusiveOwners);
 * the editor only offers them to their owner. The hub keeps a stand-in frame, since it only knows its own frame ids.
 */
export const EXCLUSIVE_FRAMES: Record<string, { owner: string; label: string; hubFallback: string }> = {
  'x-flipped-signature': { owner: 'flipped', label: 'Flipped signature', hubFallback: 'spin-aurora-spin' },
  'x-flipped-frost': { owner: 'flipped', label: 'Frost signature', hubFallback: 'g-ice' },
};
export const EXCLUSIVE_ANIMS: Record<string, { owner: string; label: string }> = {
  'signature': { owner: 'flipped', label: 'Signature circuit' },
  'frostfall': { owner: 'flipped', label: 'Frostfall' },
};

/** Theme presets with their own whole-page layer (pt-sig-<id> in profile.css), shown only on their owner's profile. */
export const EXCLUSIVE_THEMES: Record<string, { owner: string }> = {
  'flipped-frost': { owner: 'flipped' },
  'flipped-signature': { owner: 'flipped' },
};

export function ownsStyle(owner: string, username: string | null | undefined): boolean {
  return !!username && username.toLowerCase() === owner;
}

/**
 * Flipped's signature look: everything turned up, in the Recharge palette. Like any preset it restyles the name, avatar, banner
 * and theme only; sections, their order, the bio, links and the showcase are left exactly as they are.
 */
export const SIGNATURE_PRESETS = [
  {
    owner: 'flipped',
    preset: {
      id: 'flipped-frost',
      label: 'Your frost',
      swatch: ['#06182e', '#bfe8ff', '#7a6bff'],
      style: {
        // Ice-white through glacier blue to a violet edge, frosted: shimmer over a cold glow with a crisp outline, heavy and spaced wide.
        name: { mode: 'gradient', colors: ['#ffffff', '#bfe8ff', '#5cb4ff', '#7a6bff'], angle: 105, effects: ['shimmer', 'glow', 'outline'], effectColor: '#9fdcff', font: 'vt323', weight: 'heavy', spacing: 'wider' },
        // The frost signature ring turning round the picture, neon-lit, ice sparkles above, a pulsing presence dot.
        avatar: { shape: 'circle', frame: 'x-flipped-frost', frameColors: [], ornament: 'sparkles', ornamentColor: '#e6f6ff', glow: 'neon', zoom: 100, x: 50, y: 50, status: 'pulse' },
        // A hero banner from the deep night sky into glacier light, hexagonal ice crystals, frostfall drifting down through it, iced over.
        banner: { mode: 'gradient', colors: ['#040f22', '#0e2b52', '#5cb4ff'], angle: 160, imgX: 50, imgY: 50, imgZoom: 100, pattern: 'hex', anim: 'frostfall', dim: 0, tint: '#bfe8ff', height: 'hero' },
        // Frosted glass cards, an ice-blue accent, stars glittering behind the page, round corners.
        theme: { accent: '#9fdcff', card: 'glass', bg: 'stars', bgColors: ['#030a18', '#0c2140'], corner: 'round', preset: 'flipped-frost' },
      },
    },
  },
  {
    owner: 'flipped',
    preset: {
      id: 'flipped-signature',
      label: 'Your signature',
      swatch: ['#41f88d', '#3a7bff', '#c63ed8'],
      style: {
        // Green → cyan → blue → magenta, lit from within: shimmer passes over a glow, with a hard pixel shadow under it.
        name: { mode: 'gradient', colors: ['#41f88d', '#2fd6d0', '#3a7bff', '#c63ed8'], angle: 100, effects: ['shimmer', 'glow', 'pixel'], effectColor: '#41f88d', font: 'vt323', weight: 'heavy', spacing: 'wide' },
        // The signature ring turning around the picture, neon-lit, with green sparkles and a pulsing presence dot.
        avatar: { shape: 'circle', frame: 'x-flipped-signature', frameColors: [], ornament: 'sparkles', ornamentColor: '#41f88d', glow: 'neon', zoom: 100, x: 50, y: 50, status: 'pulse' },
        // A hero-height banner from deep green through navy into violet, gridded, with the signature circuit running across it.
        banner: { mode: 'gradient', colors: ['#03170d', '#0b2650', '#2a0e3d'], angle: 115, imgX: 50, imgY: 50, imgZoom: 100, pattern: 'grid', anim: 'signature', dim: 6, tint: null, height: 'hero' },
        // Green accents, cards lit from the accent, an aurora behind the page, soft corners.
        theme: { accent: '#41f88d', card: 'gradient', bg: 'aurora', bgColors: ['#020d08', '#0a1730'], corner: 'soft', preset: 'flipped-signature' },
      },
    },
  },
];
