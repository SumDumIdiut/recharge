// Pure beat scheduling for the home waveform. The trace scrolls left at `speed` px/s and wraps every `total` px; a beat fires
// when a unit's peak crosses the pulse line at x = tx. Returns the next beat as { delayMs, shape }, or null when no peak can cross.
export function nextBeat(units, total, tx, speed, offsetNow) {
  if (!(speed > 0) || !(total > 0)) return null;
  let best = null;
  for (const u of units) {
    const d = u.peakX - tx; // scroll offset at which this peak reaches tx
    if (d < 0 || d >= total) continue; // the offset only runs over [0, total), so such a peak never crosses
    let delta = d - offsetNow;
    if (delta <= 1e-6) delta += total;
    if (!best || delta < best.delta) best = { delta, shape: u.shape };
  }
  return best ? { delayMs: (best.delta / speed) * 1000, shape: best.shape } : null;
}

// Same keyframes as the old wave-beat-1/2/3 CSS, played through the Web Animations API so a beat restarts without a forced reflow.
export const BEAT_ANIMATIONS = {
  single: { duration: 500, keyframes: [{ strokeWidth: 2, offset: 0 }, { strokeWidth: 3.2, offset: 0.5 }, { strokeWidth: 2, offset: 1 }] },
  double: {
    duration: 600,
    keyframes: [
      { strokeWidth: 2, offset: 0 }, { strokeWidth: 3, offset: 0.25 }, { strokeWidth: 2, offset: 0.45 },
      { strokeWidth: 3.6, offset: 0.6 }, { strokeWidth: 2, offset: 1 },
    ],
  },
  sharp: { duration: 400, keyframes: [{ strokeWidth: 2, offset: 0 }, { strokeWidth: 4, offset: 0.15 }, { strokeWidth: 2, offset: 1 }] },
};
