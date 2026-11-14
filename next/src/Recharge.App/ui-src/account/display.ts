/**
 * Local multiplayer opacity prefs: how solid other players' name tags and bodies look in-game.
 * Kept in localStorage for the settings sliders and pushed to the game, which the Net module
 * reads from <gameDir>/Recharge/Mods/recharge.multiplayer/display.json.
 */
import { call } from '../bridge.js';

const NAME_KEY = 'rechargeMpNameOpacity';
const PLAYER_KEY = 'rechargeMpPlayerOpacity';
const DEFAULT = 0.9;

export interface MpDisplay {
  nameOpacity: number;
  playerOpacity: number;
}

function read(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function getMpDisplay(): MpDisplay {
  return { nameOpacity: read(NAME_KEY), playerOpacity: read(PLAYER_KEY) };
}

function push(d: MpDisplay): void {
  void call('mp.display', { nameOpacity: d.nameOpacity, playerOpacity: d.playerOpacity }).catch(() => {});
}

/** Save one or both opacities and push the pair to the game. */
export function setMpDisplay(partial: Partial<MpDisplay>): void {
  const next = { ...getMpDisplay(), ...partial };
  try {
    localStorage.setItem(NAME_KEY, String(next.nameOpacity));
    localStorage.setItem(PLAYER_KEY, String(next.playerOpacity));
  } catch {
    /* storage unavailable; still push to the game */
  }
  push(next);
}

/** Push the saved opacities to the game once at startup. Safe to call before the game is found. */
export function initMpDisplay(): void {
  push(getMpDisplay());
}
