/** Shared small types of the Amplifier. Pure, no DOM. */
export interface Cell { x: number; y: number }
export const CELL = 32;
export const cellKey = (x: number, y: number): string => x + ',' + y;
export function parseKey(key: string): Cell {
  const c = key.indexOf(',');
  return { x: +key.slice(0, c), y: +key.slice(c + 1) };
}
export const sameCell = (a: Cell | null | undefined, b: Cell | null | undefined): boolean => !!a && !!b && a.x === b.x && a.y === b.y;
export type Json = Record<string, unknown>;
