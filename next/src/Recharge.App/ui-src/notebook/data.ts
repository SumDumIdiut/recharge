// The notebook's data: the vault list, each vault's index and its notes, read through the bridge from the hub.
import { call } from '../bridge.js';
import { buildTree, createResolver, type NoteInfo, type Resolver, type TreeNode, type VaultIndex } from './markdown.js';

export const HUB = 'https://codecade.co.za/recharge';
const API = '/api/notebook';
const VAULTS_KEY = 'rechargeNotebookVaults';

export interface VaultMeta {
  id: string;
  title: string;
  version: string;
  notes: number;
  home: string;
  zip: string;
  zipBytes: number;
  builtAt: string;
}

export interface Vault {
  meta: VaultMeta;
  index: VaultIndex;
  resolver: Resolver;
  tree: TreeNode;
  byPath: Map<string, NoteInfo>;
}

const texts = new Map<string, string>();
const vaults = new Map<string, Vault>();
let listCache: { at: number; list: VaultMeta[] } | null = null;
const LIST_TTL = 60_000;

export const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

async function hubText(path: string): Promise<string> {
  const reply = await call<{ status: number; body: string }>('hub.get', { path });
  if (reply.status !== 200) throw new Error('the hub answered ' + reply.status);
  return reply.body;
}

function remember(list: VaultMeta[]): void {
  try { localStorage.setItem(VAULTS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

function remembered(): VaultMeta[] | null {
  try {
    const saved = JSON.parse(localStorage.getItem(VAULTS_KEY) || 'null');
    return Array.isArray(saved) && saved.length ? saved : null;
  } catch { return null; }
}

export function normalizeVaults(json: unknown): VaultMeta[] {
  const rows = (json as { vaults?: unknown })?.vaults;
  if (!Array.isArray(rows)) return [];
  const out: VaultMeta[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    out.push({
      id: row.id,
      title: typeof row.title === 'string' && row.title ? row.title : row.id,
      version: typeof row.version === 'string' ? row.version : '',
      notes: Number(row.notes) || 0,
      home: typeof row.home === 'string' ? row.home : '',
      zip: typeof row.zip === 'string' ? row.zip : '',
      zipBytes: Number(row.zipBytes) || 0,
      builtAt: typeof row.builtAt === 'string' ? row.builtAt : '',
    });
  }
  return out;
}

export async function listVaults(force = false): Promise<VaultMeta[]> {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL) return listCache.list;
  try {
    const list = normalizeVaults(JSON.parse(await hubText(API)));
    if (!list.length) throw new Error('the hub has no vaults');
    listCache = { at: Date.now(), list };
    remember(list);
    return list;
  } catch (error) {
    const saved = remembered();
    if (saved) return saved; // offline: an earlier list still names the vaults
    throw error;
  }
}

/** The vault's index and tree, cached for the session and refetched when the vault's version changes. */
export async function loadVault(meta: VaultMeta): Promise<Vault> {
  const have = vaults.get(meta.id);
  if (have && have.meta.version === meta.version) return have;
  const index = JSON.parse(await hubText(`${API}/${encodeURIComponent(meta.id)}/index.json`)) as VaultIndex;
  if (!index || !Array.isArray(index.notes)) throw new Error('the vault index is unreadable');
  const vault: Vault = {
    meta,
    index,
    resolver: createResolver(index, `${HUB}${API}/${encodeURIComponent(meta.id)}/`),
    tree: buildTree(index.notes, index.home),
    byPath: new Map(index.notes.map((n) => [n.path, n])),
  };
  vaults.set(meta.id, vault);
  return vault;
}

export async function loadNoteText(vault: Vault, path: string): Promise<string> {
  const key = `${vault.meta.id}@${vault.meta.version}/${path}`;
  const have = texts.get(key);
  if (have !== undefined) return have;
  const text = await hubText(`${API}/${encodeURIComponent(vault.meta.id)}/notes/${encodePath(path)}`);
  texts.set(key, text);
  return text;
}

/** The note a route names: an exact path, a note name or title, or the vault's home. */
export function pickNote(vault: Vault, want: string): NoteInfo | null {
  if (want) {
    const exact = vault.byPath.get(want);
    if (exact) return exact;
    const found = vault.resolver.note(want);
    if (found && vault.byPath.has(found)) return vault.byPath.get(found) || null;
  }
  const home = vault.resolver.note(vault.index.home);
  return (home && vault.byPath.get(home)) || vault.index.notes[0] || null;
}

export function zipUrl(meta: VaultMeta): string {
  return `${HUB}${API}/${meta.zip.split('/').map(encodeURIComponent).join('/')}`;
}
