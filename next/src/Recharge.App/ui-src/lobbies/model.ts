/** Pure Lobbies logic: normalising relay rows, filters and the data a card shows. No DOM. */
import { findInstalled, itemRoute, validNameColor, type InstalledData, type Item } from '../lib/library.js';

export const MAX_PLAYERS = 16;
export const JOIN_TOOLTIP = 'Start the game and join this lobby (beta)';
export const JOIN_FULL_TOOLTIP = 'This lobby is full';

export interface Lobby {
  id: number;
  name: string;
  hostName: string;
  /** A validated #rrggbb (or gradient) colour, or null. */
  hostColor: string | null;
  count: number;
  hard: boolean;
  mapHubId: string | null;
  mapName: string | null;
}

export interface LobbyReply {
  connected: boolean;
  error: string | null;
  lobbies: Lobby[];
}

export interface LobbyFilters {
  q: string;
  hasMap: boolean;
  notHard: boolean;
}

export const NO_FILTERS: LobbyFilters = { q: '', hasMap: false, notHard: false };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** One relay row; null when it has no usable id. Lobby names are shown as plain text, never as markup. */
export function normalizeLobby(raw: unknown): Lobby | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isFinite(r.id)) return null;
  const count = typeof r.count === 'number' && Number.isFinite(r.count) ? Math.max(0, Math.floor(r.count)) : 0;
  return {
    id: r.id,
    name: text(r.name).trim() || 'Untitled lobby',
    hostName: text(r.hostName).trim() || 'Someone',
    hostColor: validNameColor(r.hostColor),
    count,
    hard: r.hard === true,
    mapHubId: optText(r.mapHubId),
    mapName: optText(r.mapName),
  };
}

export function normalizeReply(raw: unknown): LobbyReply {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lobbies: Lobby[] = [];
  if (Array.isArray(r.lobbies)) for (const row of r.lobbies) { const l = normalizeLobby(row); if (l) lobbies.push(l); }
  return { connected: r.connected === true, error: typeof r.error === 'string' && r.error ? r.error : null, lobbies };
}

/** Search: every word must appear in the lobby name, host, or map name (case-insensitive). */
export function matchesLobby(lobby: Lobby, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = (lobby.name + ' ' + lobby.hostName + ' ' + (lobby.mapName || '')).toLowerCase();
  return words.every((word) => hay.includes(word));
}

export function filterLobbies(lobbies: Lobby[], f: LobbyFilters): Lobby[] {
  return lobbies.filter((l) => {
    if (f.hasMap && !l.mapHubId && !l.mapName) return false;
    if (f.notHard && l.hard) return false;
    return matchesLobby(l, f.q);
  });
}

/** Fullest first, then newest (highest id) first, so the list is steady between polls. */
export function sortLobbies(lobbies: Lobby[]): Lobby[] {
  return lobbies.slice().sort((a, b) => b.count - a.count || b.id - a.id);
}

export interface LobbyCardData {
  id: number;
  name: string;
  hostName: string;
  hostColor: string | null;
  count: number;
  playersLabel: string;
  full: boolean;
  hard: boolean;
  /** The map's name, or null for the base game. */
  mapName: string | null;
  /** The matching hub map, when mapHubId is a hub map id. */
  hubMap: Item | null;
  hubMapId: string | null;
  /** True while the hub map list has not loaded, so a missing hub map is not yet known. */
  hubUnknown: boolean;
  /** The hub map's first picture, if it has one. */
  picture: string | null;
  /** True when the map is installed (or there is no map to need). */
  mapReady: boolean;
  /** Where "Get map" goes: the Library detail of the hub map, else null. */
  getMapRoute: string | null;
  joinDisabled: boolean;
  joinTitle: string;
}

export function cardData(lobby: Lobby, hubMaps: Item[] | null, installed: InstalledData | null): LobbyCardData {
  const hubMap = lobby.mapHubId && hubMaps ? hubMaps.find((m) => m.id === lobby.mapHubId) || null : null;
  const hasMap = !!(lobby.mapHubId || lobby.mapName);
  const installedHere = hubMap && installed ? findInstalled(hubMap, installed, hubMaps || []) : null;
  return {
    id: lobby.id,
    name: lobby.name,
    hostName: lobby.hostName,
    hostColor: lobby.hostColor,
    count: lobby.count,
    playersLabel: lobby.count + '/' + MAX_PLAYERS,
    full: lobby.count >= MAX_PLAYERS,
    hard: lobby.hard,
    mapName: lobby.mapName || (hubMap ? hubMap.name : null),
    hubMap,
    hubMapId: lobby.mapHubId,
    hubUnknown: hubMaps === null,
    picture: hubMap && hubMap.gallery.length > 0 ? hubMap.gallery[0] : null,
    mapReady: !hasMap || !!installedHere,
    getMapRoute: hubMap && !installedHere ? itemRoute(hubMap) : null,
    joinDisabled: lobby.count >= MAX_PLAYERS,
    joinTitle: lobby.count >= MAX_PLAYERS ? JOIN_FULL_TOOLTIP : JOIN_TOOLTIP,
  };
}

/** A cheap signature so an unchanged poll does not repaint the cards. */
export function signature(lobbies: Lobby[]): string {
  return JSON.stringify(lobbies);
}

/** "just now", "12 s ago", "3 min ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3) return 'just now';
  if (s < 60) return s + ' s ago';
  return Math.floor(s / 60) + ' min ago';
}

/** The game.launch arguments that start the game and join a lobby. */
export function joinRequest(lobbyId: number): { modded: boolean; intent: { kind: string; args: { lobbyId: number } } } {
  return { modded: true, intent: { kind: 'lobby.join', args: { lobbyId } } };
}

export const LOBBY_NAME_MAX = 40;

/** What the host dialog picked: a lobby name, the base game (normal or hard) or an installed map. */
export interface HostChoice { name: string; map: { folder: string; name: string; hubId: string | null } | null; hard: boolean }

/** Checks the host dialog: null when fine, or what to fix. */
export function hostProblem(choice: HostChoice): string | null {
  const name = choice.name.trim();
  if (!name) return 'Give the lobby a name.';
  if (name.length > LOBBY_NAME_MAX) return 'Lobby names are at most ' + LOBBY_NAME_MAX + ' characters.';
  return null;
}

/** game.launch arguments that start the game modded and open the lobby (the lobby.host intent). Hard applies to the base game only. */
export function hostRequest(choice: HostChoice): { modded: boolean; intent: { kind: string; args: Record<string, string | boolean> } } {
  const args: Record<string, string | boolean> = { name: choice.name.trim() };
  if (choice.map) {
    args.map = choice.map.folder;
    args.mapName = choice.map.name || choice.map.folder;
    if (choice.map.hubId) args.mapHubId = choice.map.hubId;
  } else if (choice.hard) {
    args.hard = true;
  }
  return { modded: true, intent: { kind: 'lobby.host', args } };
}
