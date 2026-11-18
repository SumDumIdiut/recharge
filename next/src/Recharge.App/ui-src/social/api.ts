/** Talking to the social server. Every request goes through the app, which adds the hub session token. */
import { call } from '../bridge.js';
import { normalizeChannel, normalizeServer, normalizeServers, type Channel, type Server } from './model.js';

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

/** Toggle an emoji reaction on one message. The pushed `reaction` event carries the authoritative map. */
export function react(convKey: string, messageId: number, emoji: string): Promise<void> {
  return socialJson('POST', '/api/conversations/' + userPath(convKey) + '/messages/' + messageId + '/react', { emoji }).then(() => undefined);
}

/** Edit your own message text. The pushed `edit` event carries the authoritative text/time. */
export function editMessage(convKey: string, messageId: number, text: string): Promise<void> {
  return socialJson('PATCH', '/api/conversations/' + userPath(convKey) + '/messages/' + messageId, { text }).then(() => undefined);
}

/** Delete your own message (kept as a tombstone). The pushed `delete` event carries the authoritative time. */
export function deleteMessage(convKey: string, messageId: number): Promise<void> {
  return socialJson('DELETE', '/api/conversations/' + userPath(convKey) + '/messages/' + messageId).then(() => undefined);
}

/** Change a group's name, colour and/or avatar (any member may). Avatar is a media filename from uploadChatMedia. */
export function setGroupProfile(convId: string, patch: { name?: string; color?: string; avatar?: string }): Promise<void> {
  return socialJson('PATCH', '/api/conversations/' + userPath(convId) + '/profile', patch).then(() => undefined);
}

// ---- servers and text channels ----
const serverPath = (id: string): string => '/api/servers/' + userPath(id);

function one<T>(raw: unknown, read: (value: unknown) => T | null): T {
  const value = read(raw);
  if (!value) throw new SocialError(0, 'The social server sent something unreadable.');
  return value;
}

export function listServers(): Promise<Server[]> {
  return socialJson<unknown>('GET', '/api/servers').then(normalizeServers);
}

export function createServer(name: string): Promise<Server> {
  return socialJson<unknown>('POST', '/api/servers', { name }).then((raw) => one(raw, normalizeServer));
}

export function createChannel(serverId: string, name: string): Promise<Channel> {
  return socialJson<unknown>('POST', serverPath(serverId) + '/channels', { name }).then((raw) => one(raw, normalizeChannel));
}

/** Owner-only channel edit; omitted fields are left alone by the server. */
export function renameChannel(serverId: string, channelId: string, patch: { name?: string; topic?: string; position?: number }): Promise<Channel> {
  return socialJson<unknown>('PATCH', serverPath(serverId) + '/channels/' + userPath(channelId), patch).then((raw) => one(raw, normalizeChannel));
}

export function deleteChannel(serverId: string, channelId: string): Promise<void> {
  return socialJson('DELETE', serverPath(serverId) + '/channels/' + userPath(channelId)).then(() => undefined);
}

export function addServerMember(serverId: string, username: string): Promise<Server> {
  return socialJson<unknown>('POST', serverPath(serverId) + '/members', { username }).then((raw) => one(raw, normalizeServer));
}

/** Owner removes someone, or a member leaves with their own name. */
export function removeServerMember(serverId: string, username: string): Promise<void> {
  return socialJson('DELETE', serverPath(serverId) + '/members/' + userPath(username)).then(() => undefined);
}

export function leaveServer(serverId: string, username: string): Promise<void> {
  return removeServerMember(serverId, username);
}

/** Base64 for the JSON upload frames, chunked to keep the argument list small. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Upload one attachment as base64-in-JSON; returns the stored media name for the send frame. */
export async function uploadChatMedia(convKey: string, file: File): Promise<string> {
  const reply = await socialJson<{ name: string; url: string }>('POST', '/api/conversations/' + userPath(convKey) + '/media', {
    name: file.name, mime: file.type, data: await base64Of(file),
  });
  return reply.name;
}

/** The global shared custom emoji catalog. */
export interface ServerEmoji { shortcode: string; url: string }

export function listEmojis(): Promise<ServerEmoji[]> {
  return socialJson<ServerEmoji[]>('GET', '/api/emojis');
}

/** Add a custom emoji to the shared set (PNG/GIF/WebP, 256 KB max). */
export async function uploadEmoji(shortcode: string, file: File): Promise<void> {
  await socialJson('POST', '/api/emojis', { shortcode, mime: file.type, data: await base64Of(file) });
}

/** Remove an emoji you uploaded (or any emoji, if you are an admin). */
export function deleteEmoji(shortcode: string): Promise<void> {
  return socialJson('DELETE', '/api/emojis/' + encodeURIComponent(shortcode)).then(() => undefined);
}
