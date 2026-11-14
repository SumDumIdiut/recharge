/** The live set of node manifests (built-ins registered at load; map-carried defs registered when a file is read; user-made ones kept in this browser). */
import { parseManifest, type NodeManifest } from './manifest.js';

const REGISTRY = new Map<string, NodeManifest>();
const CUSTOM = new Set<string>();
const STORE_KEY = 'rechargeAmpCustomNodes';

export function registerNode(m: NodeManifest): void { REGISTRY.set(m.id, m); }
export function allNodes(): NodeManifest[] { return [...REGISTRY.values()]; }
export function nodeById(id: string): NodeManifest | undefined { return REGISTRY.get(id); }
export function isCustomNode(id: string): boolean { return CUSTOM.has(id); }

/** Register a user-made node and persist every custom node to this browser. */
export function addCustomNode(m: NodeManifest): void {
  REGISTRY.set(m.id, m);
  CUSTOM.add(m.id);
  saveCustom();
}

/** Forget a user-made node (built-ins and map-carried defs are left alone). */
export function removeCustomNode(id: string): void {
  if (!CUSTOM.delete(id)) return;
  REGISTRY.delete(id);
  saveCustom();
}

function saveCustom(): void {
  try {
    const defs = [...CUSTOM].map((id) => REGISTRY.get(id)).filter((m): m is NodeManifest => !!m);
    localStorage.setItem(STORE_KEY, JSON.stringify(defs));
  } catch { /* storage unavailable; the node still lives this session */ }
}

/** Load this browser's saved custom nodes. Call once at startup, after the built-ins. */
export function loadCustomNodes(): void {
  let raw: unknown;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return; }
  if (!Array.isArray(raw)) return;
  for (const r of raw) {
    const { manifest } = parseManifest(r);
    if (manifest) { REGISTRY.set(manifest.id, manifest); CUSTOM.add(manifest.id); }
  }
}
