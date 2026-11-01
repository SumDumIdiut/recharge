// The notebook's part of the URL. Pure, so `node --test` covers it.
//
// Canonical form today:  #/notebook?vault=<id>&note=<path>&a=<heading slug>&q=<search>
// Also read:             #/notebook/<id>/<note path segments>   (the path form, once the router matches it)
import { buildRoute, type Query } from '../router.js';

export interface NotebookRoute {
  vault: string;
  /** A note path (as in index.json) or a bare note name; empty means "the home note". */
  note: string;
  /** A heading slug to scroll to. */
  anchor: string;
  /** The sidebar search text. */
  q: string;
}

export function parseNotebookRoute(route: { segments: string[]; query: Query }): NotebookRoute {
  const rest = route.segments.slice(1);
  const query = route.query;
  const vault = query.vault || rest[0] || '';
  const note = query.note || (query.vault ? '' : rest.slice(1).join('/'));
  return { vault, note, anchor: query.a || '', q: query.q || '' };
}

/** The canonical hash for a notebook location. */
export function notebookHash(route: Partial<NotebookRoute>): string {
  const query: Query = {};
  if (route.vault) query.vault = route.vault;
  if (route.note) query.note = route.note;
  if (route.anchor) query.a = route.anchor;
  if (route.q) query.q = route.q;
  return buildRoute('/notebook', query);
}
