/** Talking to the social server. Every request goes through the app, which adds the hub session token. */
import { call } from '../bridge.js';

export class SocialError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Reply { status: number; body: string }

function messageOf(status: number, body: string): string {
  try {
    const json = JSON.parse(body) as { error?: unknown; retry_after?: unknown };
    if (typeof json.error === 'string' && json.error) {
      if (status === 429 && typeof json.retry_after === 'number') return json.error + ' (try again in ' + json.retry_after + ' s)';
      return json.error;
    }
  } catch {
    /* not JSON */
  }
  if (status === 401) return 'You are not logged in.';
  if (status === 404) return 'That was not found.';
  return 'The social server answered ' + status + '.';
}

/** A JSON request. Throws SocialError with the server's own message for any non-2xx answer. */
export async function socialJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const reply = await call<Reply>('social.request', body === undefined ? { method, path } : { method, path, body });
  if (reply.status < 200 || reply.status >= 300) throw new SocialError(reply.status, messageOf(reply.status, reply.body));
  if (!reply.body) return {} as T;
  try {
    return JSON.parse(reply.body) as T;
  } catch {
    throw new SocialError(reply.status, 'The social server sent something unreadable.');
  }
}

export function userPath(name: string): string {
  return encodeURIComponent(name);
}
