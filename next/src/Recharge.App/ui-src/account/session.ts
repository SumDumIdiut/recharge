/** Who is signed in. The page only ever holds the public profile; the session token stays in the app's C# side. */
import { call } from '../bridge.js';

export interface Me {
  username: string;
  admin: boolean;
  avatar_url?: string | null;
  name_color?: string | null;
  frame?: string;
  frame_colors?: string[];
  banner_color?: string | null;
  banner_url?: string | null;
  accent_color?: string | null;
  bio?: string;
  pronouns?: string | null;
  links?: string[];
}

type Listener = (me: Me | null) => void;

let current: Me | null = null;
let loaded: Promise<Me | null> | null = null;
let listeners: Listener[] = [];

export function currentUser(): Me | null {
  return current;
}

function set(me: Me | null): void {
  const same = JSON.stringify(me) === JSON.stringify(current);
  current = me;
  if (same) return;
  for (const listener of listeners.slice()) {
    try { listener(me); } catch (error) { console.error('session listener failed', error); }
  }
}

function asMe(value: unknown): Me | null {
  const v = value as Partial<Me> | null;
  if (!v || typeof v.username !== 'string' || !v.username) return null;
  return { ...(v as Me), admin: v.admin === true };
}

/** Subscribe to sign-in and sign-out. Returns the unsubscribe function. */
export function onSession(listener: Listener): () => void {
  listeners = listeners.concat(listener);
  return () => { listeners = listeners.filter((entry) => entry !== listener); };
}

/** Ask the app who is signed in (the first call settles it; later calls re-check). */
export function refreshSession(): Promise<Me | null> {
  const pending = call<unknown>('account.me', {}).then(asMe, () => null).then((me) => { set(me); return me; });
  loaded = pending;
  return pending;
}

/** Resolves once the first check has finished. */
export function sessionReady(): Promise<Me | null> {
  return loaded || refreshSession();
}

export async function signIn(username: string, password: string): Promise<Me> {
  const me = asMe(await call<unknown>('account.login', { username, password }));
  if (!me) throw new Error('The hub did not recognise that account.');
  set(me);
  return me;
}

export async function signUp(username: string, password: string): Promise<Me> {
  const me = asMe(await call<unknown>('account.register', { username, password }));
  if (!me) throw new Error('The hub did not accept that account.');
  set(me);
  return me;
}

export async function signOut(): Promise<void> {
  try { await call('account.logout', {}); } finally { set(null); }
}

/** Test hook: forget everything. */
export function resetSession(): void {
  current = null;
  loaded = null;
  listeners = [];
}

export function validateCredentials(username: string, password: string, registering: boolean): string | null {
  if (!username.trim()) return 'Enter a username.';
  if (!password) return 'Enter a password.';
  if (registering && password.length < 4) return 'Choose a password of at least 4 characters.';
  return null;
}
