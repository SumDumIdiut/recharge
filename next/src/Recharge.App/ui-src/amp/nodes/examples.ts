/** Built-in example nodes - each composes whitelisted behaviours, proving the system end to end. Position-independent. */
import { parseManifest } from './manifest.js';
import { registerNode } from './registry.js';

function def(raw: unknown): void {
  const { manifest } = parseManifest(raw);
  if (manifest) registerNode(manifest);
}

// A floor pad that flings the player up (one-shot on enter).
def({
  id: 'bounce-pad', label: 'Bounce pad', category: 'Custom', icon: '⇡', place: 'cell',
  options: [{ key: 'power', label: 'Bounce power', type: 'number', min: 0, max: 999, step: 10, unit: 'u/s', default: 120 }],
  appearance: [{ glyph: '⇡', color: '#ff9a3c' }],
  build: { collider: { shape: 'box', trigger: true }, behaviors: [{ behavior: 'setVelocity', event: 'enter', params: { vx: 0, vy: { option: 'power' } } }] },
});

// A region of reduced gravity while the player is inside.
def({
  id: 'low-gravity', label: 'Low-gravity zone', category: 'Custom', icon: '☁', place: 'zone',
  options: [{ key: 'gravity', label: 'Gravity', type: 'number', min: 0, max: 5, step: 0.1, unit: 'x', default: 0.4 }],
  appearance: [{ zone: true, glyph: '☁', color: '#9ad0ff' }],
  build: { collider: { shape: 'box', trigger: true }, behaviors: [{ behavior: 'scaleStats', event: 'enter', params: { gravity: { option: 'gravity' } } }] },
});

// A pad that tops the player's air jumps and dashes back up.
def({
  id: 'dash-refill', label: 'Refill pad', category: 'Custom', icon: '↻', place: 'cell',
  options: [],
  appearance: [{ glyph: '↻', color: '#5fd4a0' }],
  build: { collider: { shape: 'box', trigger: true }, behaviors: [{ behavior: 'refill', event: 'enter', params: {} }] },
});
