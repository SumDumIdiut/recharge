/**
 * The adaptive dim: the background is a calm backdrop, never the loudest thing on screen. The average luminance of the shown
 * picture is measured once (a tiny offscreen canvas) and sets how dark the dim layer is; the "Background strength" setting says
 * how much of the picture the user wants to see. The pure maths is here so node can test it.
 */

/** Mean perceived brightness (0 to 1) of RGBA pixel data: the mean of the per-pixel gamma-space luma, so a mid-grey reads 0.5. */
export function meanBrightness(rgba: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 8) continue;
    sum += (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
    n += 1;
  }
  return n === 0 ? 0.5 : sum / n;
}

/**
 * The dim opacity (0 to 0.94) for a picture of this brightness (0 dark to 1 white; null = unknown, treated as middling) at this
 * strength (0 to 100). Strength 0 nearly hides the picture; 100 shows it as much as keeps it calm: a white picture still gets 0.75.
 */
export function autoDimOpacity(brightness: number | null, strength: number): number {
  const b = brightness === null || !Number.isFinite(brightness) ? 0.5 : Math.min(1, Math.max(0, brightness));
  const s = Math.min(100, Math.max(0, Number.isFinite(strength) ? strength : 50)) / 100;
  const floor = 0.3 + 0.45 * b;
  return 0.94 + (floor - 0.94) * s;
}

/** The manual dim (0 to 1) stacked on the adaptive one, capped so the picture is never fully gone. */
export function combineDim(auto: number, manual: number): number {
  return Math.min(0.94, 1 - (1 - auto) * (1 - Math.min(1, Math.max(0, manual))));
}

const SIZE = 32;

/** Brightness of a loaded image or video frame, or null when it can't be read (cross-origin, not decoded yet). */
export function sampleBrightness(source: CanvasImageSource, doc: Document = document): number | null {
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, SIZE, SIZE);
    return meanBrightness(ctx.getImageData(0, 0, SIZE, SIZE).data);
  } catch {
    return null; // tainted canvas or an undecoded frame
  }
}
