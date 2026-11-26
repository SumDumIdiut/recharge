/**
 * Feeds the game the signed-in Recharge name + colour so multiplayer (the in-game
 * player labels and the Lobbies cards) shows it instead of the Steam persona name.
 * Pushes on every session change and once at startup; a blank name (logged out)
 * clears it in the app so the Steam name comes back.
 */
import { call } from '../bridge.js';
import { onSession, sessionReady, type Me } from './session.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A plain #rrggbb colour (upper-cased), or null. */
function solidHex(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return HEX.test(text) ? text.toUpperCase() : null;
}

/** The #rrggbb stops inside a CSS linear-gradient(...) name colour, in order. */
function gradientStops(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || !value.includes('gradient')) return [];
  const found = value.match(/#[0-9a-fA-F]{6}/g);
  return found ? found.map((hex) => hex.toUpperCase()) : [];
}

function push(me: Me | null): void {
  if (!me || !me.username) {
    // Logged out: clear the identity file so the game falls back to the Steam name.
    void call('mp.identity', { name: '' }).catch(() => {});
    return;
  }
  const raw = me.name_color ?? null;
  const stops = gradientStops(raw);
  const nameColor = solidHex(raw) || stops[0] || '#FFFFFF';
  const payload: Record<string, unknown> = { name: me.username, nameColor };
  if (stops.length >= 2) payload.gradient = stops;
  // The profile picture and banner show on the player's ghost in multiplayer.
  if (typeof me.avatar_url === 'string' && me.avatar_url) payload.avatar = me.avatar_url;
  if (typeof me.banner_url === 'string' && me.banner_url) payload.banner = me.banner_url;
  const bannerColor = solidHex(me.banner_color);
  if (bannerColor) payload.bannerColor = bannerColor;
  void call('mp.identity', payload).catch(() => {});
}

/** Wire the identity push into the session. Safe to call once at app startup. */
export function initMpIdentity(): void {
  onSession(push);
  void sessionReady().then(push, () => {});
}
