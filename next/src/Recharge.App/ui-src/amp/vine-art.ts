/**
 * Vine art: the original editor's thorn vines, one picture each (art/vines/<name>.png, 160 or 320 game units square, drawn one picture per
 * cell, centred on it, turned by quarter turns). Not an autotiled run: each vine is a single placed sprite. `shape` is the deadly outline
 * (polygons in game units from the cell's middle, y up, for the picture unturned), from the original's tile definitions (basemap.json
 * defs of kind "vine"). `label: null` pieces are in the game's tilemap but the original's picker hides them.
 */

export interface VineSprite { name: string; label: string | null; size: number; shape: number[][][] }

export const VINES: VineSprite[] = [
  { name: "Thorn", label: "Thorn spiral", size: 160, shape: [[[42.0,-50.0],[52.0,-25.0],[55.0,8.0],[47.0,46.0],[19.0,65.0],[-9.0,55.0],[-50.0,50.0],[-49.0,80.0],[-60.0,80.0],[-60.0,56.0],[-56.0,-14.0],[-34.0,-59.0],[-9.0,-70.0],[23.0,-67.0]]] },
  { name: "thornBig", label: "Thorn hook spiral", size: 320, shape: [[[84.0,-94.0],[108.0,-41.0],[110.0,46.0],[88.0,100.0],[38.0,127.0],[-97.0,119.0],[-99.0,160.0],[-118.0,160.0],[-116.0,17.0],[-102.0,-70.0],[-69.0,-115.0],[-33.0,-142.0],[45.0,-137.0]]] },
  { name: "BigThornLoop", label: "Thorn hook", size: 320, shape: [[[49.0,-134.0],[88.0,-85.0],[108.0,-16.0],[112.0,28.0],[96.0,84.0],[68.0,114.0],[45.0,125.0],[-99.0,160.0],[-118.0,160.0],[-117.0,28.0],[-102.0,-59.0],[-83.0,-99.0],[-52.0,-130.0],[6.0,-143.0]]] },
  { name: "SmallLoop", label: "Thorn hook (small)", size: 160, shape: [[[40.0,-49.0],[53.0,-20.0],[55.0,9.0],[51.0,36.0],[30.0,60.0],[-60.0,80.0],[-59.0,57.0],[-57.0,-9.0],[-36.0,-57.0],[-4.0,-70.0],[25.0,-66.0]]] },
  { name: "BigThornArc", label: "Thorn arc", size: 320, shape: [[[89.0,-91.0],[100.0,-61.0],[111.0,21.0],[103.0,78.0],[63.0,120.0],[-3.0,123.0],[-20.0,-141.0],[52.0,-136.0]]] },
  { name: "smallArc", label: "Thorn arc (small)", size: 160, shape: [[[49.0,-30.0],[56.0,7.0],[51.0,36.0],[33.0,59.0],[10.0,63.0],[-5.0,58.0],[-13.0,-68.0],[19.0,-69.0],[40.0,-50.0]]] },
  { name: "BigThornTallLoop", label: "Thorn curl", size: 320, shape: [[[107.0,-24.0],[109.0,45.0],[96.0,86.0],[67.0,117.0],[12.0,126.0],[-21.0,109.0],[-43.0,62.0],[-42.0,-13.0],[-20.0,-43.0]]] },
  { name: "bigThornTangle", label: "Thorn coil", size: 320, shape: [[[48.0,49.0],[15.0,61.0],[15.0,123.0],[-4.0,118.0],[-25.0,102.0],[-42.0,67.0],[-45.0,1.0],[-35.0,-31.0],[4.0,-49.0],[34.0,-33.0],[52.0,6.0]]] },
  { name: "smallTangle", label: "Thorn coil (small)", size: 160, shape: [[[21.0,-14.0],[26.0,3.0],[25.0,26.0],[9.0,34.0],[6.0,62.0],[-8.0,56.0],[-19.0,40.0],[-24.0,3.0],[-12.0,-22.0],[4.0,-25.0]]] },
  { name: "BigLoopAlt", label: null, size: 320, shape: [[[89.0,-92.0],[107.0,-47.0],[112.0,-28.0],[115.0,-9.0],[115.0,20.0],[98.0,64.0],[62.0,82.0],[25.0,63.0],[14.0,9.0],[-88.0,14.0],[-99.0,160.0],[-118.0,160.0],[-115.0,-13.0],[-98.0,-74.0],[-65.0,-122.0],[-13.0,-144.0],[55.0,-132.0]]] },
  { name: "thornBigAlt", label: null, size: 320, shape: [[[76.0,-108.0],[107.0,-42.0],[110.0,24.0],[95.0,86.0],[48.0,126.0],[-99.0,117.0],[-99.0,160.0],[-118.0,160.0],[-118.0,117.0],[-107.0,-40.0],[-77.0,-111.0],[-22.0,-139.0],[40.0,-138.0]]] },
];
export const vineSprite = (name: string): VineSprite | undefined => VINES.find((v) => v.name === name);

const images = new Map<string, HTMLImageElement | null>();
let listeners: Array<() => void> = [];

/** Called when a vine picture finishes loading (the editor repaints). */
export function onVineLoaded(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

export function vineImage(name: string): HTMLImageElement | null {
  if (images.has(name)) return images.get(name) as HTMLImageElement | null;
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  images.set(name, null);
  img.onload = () => { images.set(name, img); for (const l of listeners) l(); };
  img.src = 'amp/art/vines/' + encodeURIComponent(name) + '.png';
  return null;
}
