import type { Router } from './router.js';

let active: Router | null = null;

export function bindRouter(router: Router): void {
  active = router;
}

export function go(hash: string): void {
  active?.navigate(hash);
}

/** Update the query string without remounting the page. */
export function replace(hash: string): void {
  active?.replace(hash);
}

export function closePanel(fallback?: string): void {
  active?.closePanel(fallback);
}
