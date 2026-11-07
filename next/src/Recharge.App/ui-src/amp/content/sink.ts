/** What content types write into when a map is saved: tile runs per game tilemap, `tile` objects, other objects, and the group's fields. */
import type { Json } from '../core/types.js';

export const IDENTITY: readonly number[] = [1, 0, 0, 1];
/** The 2x2 matrix of a quarter turn count (the game's y-up counter-clockwise turns). */
export function rotMatrix(k: number): number[] {
  const a = ((((k % 4) + 4) % 4) * Math.PI) / 2;
  const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return [c, -s || 0, s, c];
}

interface Placed { x: number; y: number; name: string; mat: number }

export class JsonSink {
  private tiles = new Map<string, Placed[]>();
  private mats: number[][] = [[...IDENTITY]];
  objects: Json[] = [];
  /** Fields for the first group (start/end/spawn, gates...). */
  group: Json = {};
  /** Player rules a content type needs switched on (merged into the file's `player`). */
  player: Json = {};

  private matIndex(m: readonly number[]): number {
    const i = this.mats.findIndex((x) => x[0] === m[0] && x[1] === m[1] && x[2] === m[2] && x[3] === m[3]);
    if (i >= 0) return i;
    this.mats.push([m[0], m[1], m[2], m[3]]);
    return this.mats.length - 1;
  }

  /** A named game tile painted at a cell of a game tilemap. */
  tile(tilemap: string, name: string, x: number, y: number, matrix: readonly number[] = IDENTITY): void {
    let list = this.tiles.get(tilemap);
    if (!list) this.tiles.set(tilemap, (list = []));
    list.push({ x, y, name, mat: this.matIndex(matrix) });
  }

  /** `tileLayers` and `mats` of the file: runs of [y, x, n, name index, matrix index], rows bottom to top, cells left to right. */
  tileLayers(): { layers: Json[]; mats: number[][] } {
    const layers: Json[] = [];
    for (const [tilemap, list] of this.tiles) {
      list.sort((a, b) => a.y - b.y || a.x - b.x);
      const names: string[] = [];
      const index = new Map<string, number>();
      const runs: number[] = [];
      let cur: { y: number; x: number; n: number; idx: number; mat: number } | null = null;
      const flush = (): void => { if (cur) runs.push(cur.y, cur.x, cur.n, cur.idx, cur.mat); cur = null; };
      for (const p of list) {
        let idx = index.get(p.name);
        if (idx === undefined) { idx = names.length; names.push(p.name); index.set(p.name, idx); }
        if (cur && cur.y === p.y && cur.x + cur.n === p.x && cur.idx === idx && cur.mat === p.mat) cur.n++;
        else { flush(); cur = { y: p.y, x: p.x, n: 1, idx, mat: p.mat }; }
      }
      flush();
      layers.push({ tilemap, names, runs });
    }
    return { layers, mats: this.mats };
  }
}
