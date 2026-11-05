/**
 * Dev-only timing harness. Off unless the app was started with RECHARGE_PERF=1 or --route-sequence (see tools/perf.sh): then
 * every mark is logged as "[perf] name key=value ..." through the console relay (the app stamps t=<ms since process start>),
 * and the route sequence, when given, is visited one route after another. Costs one counter increment per bridge call otherwise.
 */
import { call } from './bridge.js';

let enabled: boolean | null = null; // null until the app says
const early: string[] = [];
let calls = new Map<string, number>();
const waiters = new Map<string, () => void>();

/** Count one bridge call (always, cheaply). */
export function perfCount(command: string): void {
  if (command === 'app.perf' || command === 'perf.done') return;
  calls.set(command, (calls.get(command) || 0) + 1);
}

export function perfLog(name: string, fields: Record<string, string | number> = {}): void {
  if (enabled === false) return;
  const text = Object.entries({ ...fields, at: Math.round(performance.now()) }).map(([k, v]) => k + '=' + v).join(' ');
  const line = '[perf] ' + name + (text ? ' ' + text : '');
  if (enabled === null) early.push(line); else console.log(line);
}

const starts = new Map<string, number>();

/** The router starts showing a route. */
export function perfRouteStart(hash: string): void {
  starts.set(hash, performance.now());
}

/** The page's first (synchronous) content is in the DOM and has been painted. */
export function perfRouteContent(hash: string): void {
  if (enabled === false) return;
  const t0 = starts.get(hash);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    perfLog('route-content', { route: hash, ms: t0 === undefined ? -1 : Math.round(performance.now() - t0) });
  }));
}

/** The page finished mounting (its data loaded). */
export function perfRouteSettled(hash: string): void {
  if (enabled === false) return;
  const t0 = starts.get(hash);
  perfLog('route-settled', { route: hash, ms: t0 === undefined ? -1 : Math.round(performance.now() - t0) });
  const waiter = waiters.get(hash);
  if (waiter) { waiters.delete(hash); waiter(); }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function settled(hash: string, limitMs: number): Promise<void> {
  return new Promise((resolve) => {
    waiters.set(hash, resolve);
    window.setTimeout(() => { if (waiters.delete(hash)) { perfLog('route-timeout', { route: hash }); resolve(); } }, limitMs);
  });
}

function canonical(route: string): string {
  return route.startsWith('#') ? route : '#' + route;
}

async function runSequence(sequence: string[]): Promise<void> {
  await wait(1200); // let the start-up work and its background fetches finish
  const seen = new Map<string, number>();
  for (const raw of sequence) {
    const hash = canonical(raw);
    const visit = (seen.get(hash) || 0) + 1;
    seen.set(hash, visit);
    calls = new Map();
    window.location.hash = hash;
    await settled(hash, 25000);
    await wait(700); // background refreshes after the page is up still count
    const names = [...calls.entries()].sort().map(([k, v]) => k + ':' + v).join(',');
    perfLog('route-calls', { route: hash, visit, total: [...calls.values()].reduce((a, b) => a + b, 0), calls: names || '-' });
  }
  perfLog('sequence-done');
  await wait(300);
  try { await call('perf.done', {}); } catch { /* the app is closing */ }
}

/** Start-up marks, and the route sequence when the app was given one. */
export async function initPerf(): Promise<void> {
  let config: { enabled?: boolean; sequence?: string[] };
  try { config = await call<{ enabled?: boolean; sequence?: string[] }>('app.perf', {}); } catch { enabled = false; return; }
  if (!config.enabled) { enabled = false; early.length = 0; return; }
  enabled = true;
  for (const line of early.splice(0)) console.log(line);
  perfLog('app-js', { ms: Math.round(performance.now()) });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perfLog('paint', { name: entry.name, ms: Math.round(entry.startTime) });
    }).observe({ type: 'paint', buffered: true });
  } catch { /* no paint timing in this engine */ }
  const boot = calls.size ? [...calls.entries()].sort().map(([k, v]) => k + ':' + v).join(',') : '-';
  perfLog('boot-calls', { calls: boot });
  if (config.sequence && config.sequence.length) {
    // wait for the first route to settle, then walk the sequence
    window.setTimeout(() => void runSequence(config.sequence as string[]), 0);
  }
}

/** The current page has its data on screen (before it waits for pictures). */
export function perfRouteData(): void {
  if (enabled === false) return;
  const hash = [...starts.keys()].pop() || '';
  const t0 = starts.get(hash);
  requestAnimationFrame(() => perfLog('route-data', { route: hash, ms: t0 === undefined ? -1 : Math.round(performance.now() - t0) }));
}
