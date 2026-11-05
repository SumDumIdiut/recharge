/** Pure Library logic: kinds, rows, colours, search, sort, install matching, updates. No DOM. */
import { slug } from '../util.js';
import { isNewer } from './version.js';
import { githubRepoUrl } from './sourceUrl.js';

export type Kind = 'maps' | 'mods' | 'skins' | 'backgrounds' | 'playlists' | 'games';
export const KINDS: Kind[] = ['maps', 'mods', 'skins', 'backgrounds', 'playlists', 'games'];
export const KIND_LABEL: Record<Kind, string> = {
  maps: 'Map',
  mods: 'Mod',
  skins: 'Skin',
  backgrounds: 'Background',
  playlists: 'Playlist',
  games: 'Game',
};
export type Status = 'installed' | 'update' | null;
export type Sort = 'new' | 'updated' | 'name' | 'popular';
export const SORTS: Sort[] = ['new', 'updated', 'name', 'popular'];
export type Mode = 'discover' | 'installed' | 'updates';
export const MODES: Mode[] = ['discover', 'installed', 'updates'];

export interface InstalledRef {
  folder: string | null;
  version: string | null;
  revision: number | null;
  enabled: boolean | null;
  /** True when the folder was installed from this hub entry (its hub id record matches), so Update and Remove apply. */
  linked: boolean;
}

export interface Item {
  key: string;
  kind: Kind;
  id: string;
  name: string;
  author: string;
  color: string | null;
  version: string;
  description: string;
  gallery: string[];
  createdAt: string;
  updatedAt: string;
  revision: number | null;
  modId: string | null;
  /** The mod's source code on GitHub (a clean https://github.com/owner/repo address), or null. */
  sourceUrl: string | null;
  /** True for installed items that have no hub row. */
  local: boolean;
  status: Status;
  installed: InstalledRef | null;
  size: number | null;
  type: string;
}

export interface InstalledMod { id: string; displayName: string; version: string; enabled: boolean; folder: string; hubId: string | null; revision: number | null }
export interface InstalledMap { folder: string; name: string; hubId: string | null; revision: number | null }
export interface InstalledSkin { folder: string; name: string; hubId: string | null; revision: number | null }
/** A background or playlist folder in the app's own data. */
export interface InstalledContent { folder: string; name: string; hubId: string | null; revision: number | null }
export interface InstalledData {
  game: string | null;
  mods: InstalledMod[];
  maps: InstalledMap[];
  skins: InstalledSkin[];
  backgrounds: InstalledContent[];
  playlists: InstalledContent[];
}

export type Lists = Record<Kind, Item[] | null>;

const HEX = /^#[0-9a-fA-F]{6}$/;
const GRADIENT = /^linear-gradient\([#0-9a-fA-F%., ()a-z-]*\)$/;

/** Allow only a #rrggbb colour or a plain linear-gradient(...); anything else is null. */
export function validNameColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (HEX.test(text)) return text;
  if (text.length <= 300 && GRADIENT.test(text) && !/url|var\(|attr\(|image|expression|env\(/.test(text)) return text;
  return null;
}

export interface NameStyle {
  color?: string;
  background?: string;
  clip?: boolean;
}

export function nameStyle(color: string | null): NameStyle {
  const valid = validNameColor(color);
  if (!valid) return {};
  if (valid.startsWith('#')) return { color: valid };
  return { background: valid, clip: true };
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** Turn one hub row into an Item. */
export function rowToItem(kind: Kind, row: unknown): Item | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const gallery = Array.isArray(r.gallery) ? r.gallery.filter((file) => typeof file === 'string') as string[] : [];
  const revision = typeof r.revision === 'number' && Number.isFinite(r.revision) ? r.revision : null;
  const author = str(r.author) || str(r.uploader);
  return {
    key: kind + ':' + id,
    kind,
    id,
    name: str(r.name) || id,
    author,
    color: validNameColor(r.uploader_name_color),
    version: str(r.version),
    description: str(r.description),
    gallery,
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
    revision,
    modId: r.modId === null || r.modId === undefined ? null : str(r.modId),
    sourceUrl: githubRepoUrl(r.sourceUrl),
    local: false,
    status: null,
    installed: null,
    size: typeof r.size === 'number' ? r.size : null,
    type: str(r.type),
  };
}

export function rowsToItems(kind: Kind, json: unknown): Item[] {
  if (!Array.isArray(json)) throw new Error('unexpected response shape');
  const items: Item[] = [];
  for (const row of json) {
    const item = rowToItem(kind, row);
    if (item) items.push(item);
  }
  return items;
}

export function skinMatches(folder: string, name: string): boolean {
  return slug(name) === folder;
}

function installedRef(folder: string | null, version: string | null, revision: number | null, enabled: boolean | null, linked = false): InstalledRef {
  return { folder, version, revision, enabled, linked };
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which hub entry each installed map folder was really installed from.
 * The link is the hub id recorded in the folder's hub.json at install time; never the map's uid or name.
 * One repair for the state the old app left behind: it installed a copy of a map (same uid) INTO the original's folder and
 * stamped the copy's hub id on it, so the folder claims hub entry H while the name it was installed under (hub.json name)
 * is another hub entry's name. When H's current name differs from the recorded name and another, unclaimed hub entry
 * carries exactly that name, the folder belongs to that entry instead, and H shows as not installed.
 * A genuine rename (no other entry has the old name) keeps its link.
 */
export function mapLinks(installed: InstalledData, hubMaps: Item[]): Map<InstalledMap, string | null> {
  const links = new Map<InstalledMap, string | null>();
  // An entry counts as claimed when a folder carries its id AND the name it currently has (so a stale claim doesn't block the repair).
  const claimed = new Set(installed.maps.filter((m) => {
    const row = m.hubId ? hubMaps.find((item) => item.id === m.hubId) : undefined;
    return m.hubId && (!row || !m.name || sameName(row.name, m.name));
  }).map((m) => m.hubId as string));
  for (const map of installed.maps) {
    let link = map.hubId;
    const row = link ? hubMaps.find((item) => item.id === link) : undefined;
    if (link && row && map.name && !sameName(row.name, map.name)) {
      const owner = hubMaps.find((item) => item.id !== link && sameName(item.name, map.name) && !claimed.has(item.id));
      if (owner) { link = owner.id; claimed.add(owner.id); }
    }
    links.set(map, link);
  }
  return links;
}

/** The installed folder for a hub map id, or undefined. With several claimants, the one whose recorded name matches wins. */
function installedMapFor(item: Item, installed: InstalledData, hubMaps: Item[]): InstalledMap | undefined {
  const links = mapLinks(installed, hubMaps.some((h) => h.id === item.id) ? hubMaps : [...hubMaps, item]);
  const mine = installed.maps.filter((map) => links.get(map) === item.id);
  return mine.find((map) => sameName(map.name, item.name)) || mine[0];
}

/** The installed counterpart of a hub item, or null. hubMaps is the whole hub map list (needed to tell apart a legacy collision). */
export function findInstalled(item: Item, installed: InstalledData | null, hubMaps: Item[] = []): InstalledRef | null {
  if (!installed) return null;
  if (item.kind === 'maps') {
    const found = installedMapFor(item, installed, hubMaps);
    return found ? installedRef(found.folder, null, found.revision, null, found.hubId === item.id) : null;
  }
  if (item.kind === 'mods') {
    const found = installed.mods.find((mod) => mod.hubId === item.id) || installed.mods.find((mod) => item.modId && mod.id === item.modId);
    return found ? installedRef(found.folder, found.version, found.revision, found.enabled, found.hubId === item.id) : null;
  }
  if (item.kind === 'skins') {
    // The hub id record is the link. A skin folder with no record at all (made by hand) is matched by its name's slug, for display only.
    const found = installed.skins.find((skin) => skin.hubId === item.id)
      || installed.skins.find((skin) => !skin.hubId && skinMatches(skin.folder, item.name));
    return found ? installedRef(found.folder, null, found.revision, null, found.hubId === item.id) : null;
  }
  if (item.kind === 'backgrounds' || item.kind === 'playlists') {
    const found = installed[item.kind].find((entry) => entry.hubId === item.id);
    return found ? installedRef(found.folder, null, found.revision, null, true) : null;
  }
  return null;
}

/** Whether the hub item is newer than the installed copy. */
export function statusOf(item: Item, ref: InstalledRef | null): Status {
  if (!ref) return null;
  if (item.kind === 'maps') {
    // As in the current app (autoupdate.js isNewerRevision): an install from before revisions existed, and a hub row
    // without one, both count as revision 1.
    const have = ref.revision === null ? 1 : ref.revision;
    const hub = item.revision === null ? 1 : item.revision;
    return hub > have ? 'update' : 'installed';
  }
  if (item.kind === 'mods') {
    if (ref.revision !== null && item.revision !== null && item.revision > ref.revision) return 'update';
    return ref.version && item.version && isNewer(item.version, ref.version) ? 'update' : 'installed';
  }
  // Skins, backgrounds, playlists: by revision, like maps; an unrecorded revision counts as 1.
  const have = ref.revision === null ? 1 : ref.revision;
  const hub = item.revision === null ? 1 : item.revision;
  return hub > have ? 'update' : 'installed';
}

export interface ItemActions {
  /** Label of the main button: Install, Update or Installed (nothing to do). */
  main: 'Install' | 'Update' | 'Installed';
  /** The main button can be pressed (Install and Update are; Installed is not). */
  canInstall: boolean;
  /** Remove applies: the folder is linked to this hub entry by its hub id record. */
  canRemove: boolean;
  /** Why Install / Update is unavailable, for the tooltip. */
  reason: string;
}

/** What the detail panel offers for an item. Every kind except games can be installed, updated and removed. */
export function actionsOf(item: Item, gameFound: boolean): ItemActions {
  const main = item.status === 'update' ? 'Update' : item.status === 'installed' ? 'Installed' : 'Install';
  const inGame = item.kind === 'maps' || item.kind === 'mods' || item.kind === 'skins';
  const installable = item.kind !== 'games' && !item.local;
  if (!installable) return { main, canInstall: false, canRemove: false, reason: item.local ? 'Not on the hub' : 'Games are not installed here' };
  if (inGame && !gameFound) return { main, canInstall: false, canRemove: false, reason: 'IGTAP was not found. Set its location in Settings.' };
  return {
    main,
    canInstall: main !== 'Installed',
    canRemove: !!item.installed && item.installed.linked,
    reason: main === 'Installed' ? 'Already installed and up to date' : '',
  };
}

/** Hub items with their install status filled in. */
export function annotate(items: Item[], installed: InstalledData | null, hubMaps: Item[] = items): Item[] {
  return items.map((item) => {
    const ref = findInstalled(item, installed, hubMaps);
    return ref ? { ...item, installed: ref, status: statusOf(item, ref) } : item;
  });
}

function localItem(kind: Kind, id: string, name: string, version: string, ref: InstalledRef): Item {
  return {
    key: kind + ':' + id,
    kind,
    id,
    name,
    author: '',
    color: null,
    version,
    description: '',
    gallery: [],
    createdAt: '',
    updatedAt: '',
    revision: ref.revision,
    modId: null,
    sourceUrl: null,
    local: true,
    status: 'installed',
    installed: ref,
    size: null,
    type: '',
  };
}

/** Everything that is installed, merged with its hub row when there is one. */
/**
 * Mods Recharge has built in (Navigator, DOTnet, Skinmod): its loader does their jobs, so they are not offered or listed as mods.
 * The folders stay where they are (the maps and skins live inside them).
 */
export const EMBEDDED_MODS: readonly string[] = ['recharge.maps', 'recharge.multiplayer', 'recharge.customskins'];

export function isEmbeddedMod(item: Pick<Item, 'kind' | 'modId' | 'id'>): boolean {
  return item.kind === 'mods' && EMBEDDED_MODS.includes((item.modId || item.id).toLowerCase());
}

export function installedItems(installed: InstalledData | null, lists: Lists): Item[] {
  if (!installed) return [];
  const out: Item[] = [];
  const hub = (kind: Kind): Item[] => lists[kind] || [];

  for (const mod of installed.mods) {
    if (EMBEDDED_MODS.includes(mod.id.toLowerCase())) continue;
    const row = (mod.hubId ? hub('mods').find((item) => item.id === mod.hubId) : undefined) || hub('mods').find((item) => item.modId === mod.id);
    const ref = installedRef(mod.folder, mod.version, mod.revision, mod.enabled, !!row && mod.hubId === row.id);
    if (row) out.push({ ...row, installed: ref, status: statusOf(row, ref) });
    else out.push({ ...localItem('mods', mod.id, mod.displayName || mod.id, mod.version, ref), modId: mod.id });
  }
  const links = mapLinks(installed, hub('maps'));
  for (const map of installed.maps) {
    const linked = links.get(map);
    const row = linked ? hub('maps').find((item) => item.id === linked) : undefined;
    const ref = installedRef(map.folder, null, map.revision, null, !!row && map.hubId === row.id);
    if (row) out.push({ ...row, installed: ref, status: statusOf(row, ref) });
    else out.push(localItem('maps', map.folder, map.name || map.folder, '', ref));
  }
  for (const skin of installed.skins) {
    const row = (skin.hubId ? hub('skins').find((item) => item.id === skin.hubId) : undefined)
      || (!skin.hubId ? hub('skins').find((item) => skinMatches(skin.folder, item.name)) : undefined);
    const ref = installedRef(skin.folder, null, skin.revision, null, !!row && skin.hubId === row.id);
    if (row) out.push({ ...row, installed: ref, status: statusOf(row, ref) });
    else out.push(localItem('skins', skin.folder, skin.name || skin.folder, '', ref));
  }
  for (const kind of ['backgrounds', 'playlists'] as const) {
    for (const entry of installed[kind]) {
      const row = entry.hubId ? hub(kind).find((item) => item.id === entry.hubId) : undefined;
      const ref = installedRef(entry.folder, null, entry.revision, null, !!row);
      if (row) out.push({ ...row, installed: ref, status: statusOf(row, ref) });
      else out.push(localItem(kind, entry.folder, entry.name || entry.folder, '', ref));
    }
  }
  return out;
}

export function updatesOf(items: Item[]): Item[] {
  return items.filter((item) => item.status === 'update');
}

/** Case-insensitive; every word must appear in the name, author or description. */
export function matchesQuery(item: Pick<Item, 'name' | 'author' | 'description'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return true;
  const haystack = (item.name + '\n' + item.author + '\n' + item.description).toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function time(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function sortItems(items: Item[], sort: Sort): Item[] {
  const list = items.slice();
  if (sort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else if (sort === 'new') {
    list.sort((a, b) => time(b.createdAt) - time(a.createdAt));
  } else {
    // 'updated', and 'popular' until the hub has popularity data.
    list.sort((a, b) => time(b.updatedAt || b.createdAt) - time(a.updatedAt || a.createdAt));
  }
  return list;
}

let itemBase = '#/library';

/** Where item cards open their panel: '#/library', or a sidebar content page such as '#/maps' while it is shown. */
export function setItemBase(base: string): void { itemBase = base; }

export function itemRoute(item: Pick<Item, 'kind' | 'id'>): string {
  return itemBase + '/item/' + item.kind + '/' + encodeURIComponent(item.id);
}

export const HUB_BASE = 'https://codecade.co.za/recharge';

export function imageUrl(kind: Kind, id: string, file: string): string {
  return HUB_BASE + '/api/' + kind + '/' + id + '/gallery/' + encodeURIComponent(file);
}

export function itemWebUrl(kind: Kind, id: string): string {
  return HUB_BASE + '/#/item/' + kind + '/' + id;
}

/** Counts per kind plus 'all', for a list of items. */
export function countByKind(items: Item[]): Record<Kind | 'all', number> {
  const counts: Record<string, number> = { all: items.length };
  for (const kind of KINDS) counts[kind] = 0;
  for (const item of items) counts[item.kind] += 1;
  return counts as Record<Kind | 'all', number>;
}

export function newestAcross(lists: Lists, n: number): Item[] {
  const all: Item[] = [];
  for (const kind of KINDS) {
    if (kind === 'games') continue;
    for (const item of lists[kind] || []) all.push(item);
  }
  return sortItems(all, 'new').slice(0, n);
}
