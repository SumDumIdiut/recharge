// The game's spike tiles, by colour and turn (the level's most used tile for each way up).
const SPIKE_LAYER = { spike: 'Spikes', dark: 'Spikes', blue: 'blueSpikes', orange: 'orangeSpikes' };
const DARK_SPIKE_TILES = new Set(['spike_tileset_8', 'spike_tileset_11', 'spike_tileset_13', 'spike_tileset_14']);
export const TRUE_COLOR = '#ff2020';
export const rotMatrix = (k) => { const a = (((k % 4) + 4) % 4) * Math.PI / 2, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a)); return [c, -s, s, c]; };
export const mul2 = (p, q) => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const rot2 = (a) => [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];

const uses = new WeakMap();
export function spikeTile(base, c, q) {
  let u = uses.get(base);
  if (!u) {
    u = new Map();
    for (const b of [base.always, ...Object.values(base.states || {})]) { const h = b?.hazards || []; for (let i = 0; i < h.length; i += 5) u.set(h[i + 2], (u.get(h[i + 2]) || 0) + 1); }
    uses.set(base, u);
  }
  const layer = SPIKE_LAYER[c] || SPIKE_LAYER.spike;
  const spikes = base.defs.map((d, i) => [d, u.get(i) || 0]).filter(([d]) => d.layer === layer && d.kind === 'spike' && (layer !== 'Spikes' || DARK_SPIKE_TILES.has(d.tile) === (c === 'dark')));
  const best = (want) => spikes.filter(([d]) => d.base === want).sort((a, b) => b[1] - a[1])[0]?.[0];
  const d = (q === 1 && best(3)) || best(q) || best(0) || spikes[0][0];
  return { layer, tile: d.tile, matrix: rotMatrix(q - d.base), def: d };
}
// A free spike's own turn, size and flips on top of its tile's.
export const spikeExtra = (f) => mul2(rot2(((f.r || 0) * Math.PI) / 180), [(f.s || 1) * (f.fx ? -1 : 1), 0, 0, (f.s || 1) * (f.fy ? -1 : 1)]);
