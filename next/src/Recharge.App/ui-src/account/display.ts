/**
 * Local multiplayer opacity prefs: how solid other players' name tags, bodies,
 * profile pictures and banners look in-game. Kept in localStorage for the settings
 * sliders and pushed to the game, which the Net module reads from
 * <gameDir>/Recharge/Mods/recharge.multiplayer/display.json.
 */
import { call } from '../bridge.js';

const KEYS = {
  nameOpacity: 'rechargeMpNameOpacity',
  playerOpacity: 'rechargeMpPlayerOpacity',
  pfpOpacity: 'rechargeMpPfpOpacity',
  bannerOpacity: 'rechargeMpBannerOpacity',
} as const;
const DEFAULTS: MpDisplay = { nameOpacity: 0.9, playerOpacity: 0.9, pfpOpacity: 0.9, bannerOpacity: 0.7 };

export interface MpDisplay {
  nameOpacity: number;
  playerOpacity: number;
  pfpOpacity: number;
  bannerOpacity: number;
}

function read(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  } catch {
    return fallback;
  }
}

export function getMpDisplay(): MpDisplay {
  return {
    nameOpacity: read(KEYS.nameOpacity, DEFAULTS.nameOpacity),
    playerOpacity: read(KEYS.playerOpacity, DEFAULTS.playerOpacity),
    pfpOpacity: read(KEYS.pfpOpacity, DEFAULTS.pfpOpacity),
    bannerOpacity: read(KEYS.bannerOpacity, DEFAULTS.bannerOpacity),
  };
}

function push(d: MpDisplay): void {
  void call('mp.display', { ...d }).catch(() => {});
}

/** Save any subset of the opacities and push the full set to the game. */
export function setMpDisplay(partial: Partial<MpDisplay>): void {
  const next = { ...getMpDisplay(), ...partial };
  try {
    for (const k of Object.keys(KEYS) as (keyof MpDisplay)[]) localStorage.setItem(KEYS[k], String(next[k]));
  } catch {
    /* storage unavailable; still push to the game */
  }
  push(next);
}

/** Push the saved opacities to the game once at startup. Safe to call before the game is found. */
export function initMpDisplay(): void {
  push(getMpDisplay());
}
