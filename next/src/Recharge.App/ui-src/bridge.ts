import { perfCount } from './perf.js';

export interface AppInfo {
  name?: string;
  version?: string;
  dotnet?: string;
  /** "WebView2 <version>" on Windows, "WebKitGTK <version>" on Linux. */
  engine?: string;
}

export interface GameInfo {
  path?: string | null;
}

type RechargeBridge = {
  call?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  ready?: () => void;
};

function bridge(): RechargeBridge | null {
  const value = (window as unknown as { recharge?: RechargeBridge }).recharge;
  return value || null;
}

/** Call a native bridge command, or reject when the page runs outside the app. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  perfCount(command);
  const api = bridge();
  if (!api || typeof api.call !== 'function') {
    throw new Error('Recharge bridge is not available');
  }
  try {
    return (await api.call(command, args || {})) as T;
  } finally {
    for (const listener of settledListeners) {
      try { listener(command, args); } catch { /* a listener never breaks a call */ }
    }
  }
}

type SettledListener = (command: string, args: Record<string, unknown> | undefined) => void;
const settledListeners: SettledListener[] = [];

/** Run `listener` after every bridge call finishes (success or failure). The data cache uses it to drop what a command made stale. */
export function onCallSettled(listener: SettledListener): void {
  settledListeners.push(listener);
}

export function describeError(error: unknown): string {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  const value = error as { message?: string };
  return value.message || String(error);
}
