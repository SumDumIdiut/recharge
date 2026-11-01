/** The app-wide cache of name and avatar looks, filled from the social server in batches. */
import { socialJson } from '../social/api.js';
import { createStyleCache, type ChipStyle } from './cache.js';

export type { ChipStyle } from './cache.js';

const cache = createStyleCache((names) => socialJson('GET', '/api/profiles?names=' + names.map(encodeURIComponent).join(',')));

export function peekStyle(name: string): ChipStyle | null | undefined { return cache.peek(name); }
export function watchStyle(name: string, cb: (style: ChipStyle | null) => void): void { cache.watch(name, cb); }
export function prefetchStyles(names: string[]): void { cache.prefetch(names); }
export function primeStyle(name: string, style: ChipStyle | null): void { cache.prime(name, style); }
export function forgetStyle(name: string): void { cache.forget(name); }
export function clearStyles(): void { cache.clear(); }
