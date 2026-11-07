/** Keyboard to button mask. Held keys are level-triggered; the stepper makes jump / dash edge-triggered itself. */
import { BUTTON } from './step.js';

/** Keys, by event.code. The game's real bindings are not known here; these are the usual ones. */
export const KEYMAP: Record<string, number> = {
  ArrowLeft: BUTTON.LEFT, KeyA: BUTTON.LEFT,
  ArrowRight: BUTTON.RIGHT, KeyD: BUTTON.RIGHT,
  ArrowUp: BUTTON.UP, KeyW: BUTTON.UP,
  ArrowDown: BUTTON.DOWN, KeyS: BUTTON.DOWN,
  Space: BUTTON.JUMP, KeyZ: BUTTON.JUMP, KeyK: BUTTON.JUMP,
  ShiftLeft: BUTTON.DASH, ShiftRight: BUTTON.DASH, KeyX: BUTTON.DASH, KeyL: BUTTON.DASH,
};

export class Controller {
  private held = new Set<string>();
  /** Returns whether the key means a game button. */
  down(code: string): boolean { if (!(code in KEYMAP)) return false; this.held.add(code); return true; }
  up(code: string): void { this.held.delete(code); }
  clear(): void { this.held.clear(); }
  mask(): number {
    let m = 0;
    for (const c of this.held) m |= KEYMAP[c];
    // opposite directions cancel
    if ((m & BUTTON.LEFT) && (m & BUTTON.RIGHT)) m &= ~(BUTTON.LEFT | BUTTON.RIGHT);
    return m;
  }
}
