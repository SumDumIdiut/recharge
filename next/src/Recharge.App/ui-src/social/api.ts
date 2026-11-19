/** Talking to the social server. Every request goes through the app, which adds the hub session token. */
import { call } from '../bridge.js';
import { normalizeCategory, normalizeChannel, normalizeRole, normalizeServer, normalizeServers, type Category, type Channel, type Role, type Server } from './model.js';

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

let socialBase = '';
/** A full, WebView-loadable URL for a public social media path (attachments, group avatars, custom emoji). */
export function socialMediaSrc(pathOrUrl: string): string {
  if (!pathOrUrl) return '';
  if (/^(https?:|blob:|data:)/.test(pathOrUrl)) return pathOrUrl;
  return socialBase + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
}
export async function loadSocialBase(): Promise<void> {
  try { const r = await call<{ base?: string }>('social.base'); if (r && typeof r.base === 'string' && r.base) socialBase = r.base.replace(/\/+$/, ''); } catch { /* keep relative */ }
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

export function createChannel(serverId: string, name: string, kind?: 'text' | 'voice', categoryId?: string): Promise<Channel> {
  const body: Record<string, unknown> = { name };
  if (kind) body.kind = kind;
  if (categoryId) body.categoryId = categoryId;
  return socialJson<unknown>('POST', serverPath(serverId) + '/channels', body).then((raw) => one(raw, normalizeChannel));
}

/** Manage-only channel edit; omitted fields are left alone by the server. categoryId: "" moves it to uncategorised. */
export function renameChannel(serverId: string, channelId: string, patch: { name?: string; topic?: string; position?: number; categoryId?: string }): Promise<Channel> {
  return socialJson<unknown>('PATCH', serverPath(serverId) + '/channels/' + userPath(channelId), patch).then((raw) => one(raw, normalizeChannel));
}

export function deleteChannel(serverId: string, channelId: string): Promise<void> {
  return socialJson('DELETE', serverPath(serverId) + '/channels/' + userPath(channelId)).then(() => undefined);
}

/** Change a server's name (owner or admin). */
export function renameServer(serverId: string, name: string): Promise<Server> {
  return socialJson<unknown>('PATCH', serverPath(serverId), { name }).then((raw) => one(raw, normalizeServer));
}

// ---- categories ----
export function createCategory(serverId: string, name: string): Promise<Category> {
  return socialJson<unknown>('POST', serverPath(serverId) + '/categories', { name }).then((raw) => one(raw, normalizeCategory));
}
export function updateCategory(serverId: string, categoryId: string, patch: { name?: string; position?: number }): Promise<Category> {
  return socialJson<unknown>('PATCH', serverPath(serverId) + '/categories/' + userPath(categoryId), patch).then((raw) => one(raw, normalizeCategory));
}
export function deleteCategory(serverId: string, categoryId: string): Promise<void> {
  return socialJson('DELETE', serverPath(serverId) + '/categories/' + userPath(categoryId)).then(() => undefined);
}

// ---- roles ----
export function createRole(serverId: string, name: string, color: string, admin: boolean): Promise<Role> {
  return socialJson<unknown>('POST', serverPath(serverId) + '/roles', { name, color, admin }).then((raw) => one(raw, normalizeRole));
}
export function updateRole(serverId: string, roleId: string, patch: { name?: string; color?: string; admin?: boolean; position?: number }): Promise<Role> {
  return socialJson<unknown>('PATCH', serverPath(serverId) + '/roles/' + userPath(roleId), patch).then((raw) => one(raw, normalizeRole));
}
export function deleteRole(serverId: string, roleId: string): Promise<void> {
  return socialJson('DELETE', serverPath(serverId) + '/roles/' + userPath(roleId)).then(() => undefined);
}
/** Set a member's whole role list. */
export function setMemberRoles(serverId: string, username: string, roleIds: string[]): Promise<void> {
  return socialJson('PUT', serverPath(serverId) + '/members/' + userPath(username) + '/roles', { roleIds }).then(() => undefined);
}

// ---- a server's own emoji set ----
export function listServerEmojis(serverId: string): Promise<ServerEmoji[]> {
  return socialJson<ServerEmoji[]>('GET', serverPath(serverId) + '/emojis');
}
export async function addServerEmoji(serverId: string, shortcode: string, file: File): Promise<void> {
  await socialJson('POST', serverPath(serverId) + '/emojis', { shortcode, mime: file.type, data: await base64Of(file) });
}
export function removeServerEmoji(serverId: string, shortcode: string): Promise<void> {
  return socialJson('DELETE', serverPath(serverId) + '/emojis/' + encodeURIComponent(shortcode)).then(() => undefined);
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

/** The caller's personal arsenal: the emoji their picker offers (own uploads + everything unlocked by joining servers). */
export function myArsenal(): Promise<ServerEmoji[]> {
  return socialJson<ServerEmoji[]>('GET', '/api/emojis/mine');
}

/** Add a custom emoji to the shared set (PNG/GIF/WebP, 256 KB max). */
export async function uploadEmoji(shortcode: string, file: File): Promise<void> {
  await socialJson('POST', '/api/emojis', { shortcode, mime: file.type, data: await base64Of(file) });
}

/** Remove an emoji you uploaded (or any emoji, if you are an admin). */
export function deleteEmoji(shortcode: string): Promise<void> {
  return socialJson('DELETE', '/api/emojis/' + encodeURIComponent(shortcode)).then(() => undefined);
}

// ---- voice (authenticated Cloudflare realtime proxy) ----
export interface VoiceSession { sessionId: string }
export interface VoiceIce { iceServers: RTCIceServer[] }
export interface VoiceSdp { type: string; sdp: string }
export interface VoiceTrackInfo { location?: string; mid?: string; trackName?: string; sessionId?: string }
export interface VoiceTracksReply { sessionDescription: VoiceSdp; tracks?: VoiceTrackInfo[]; requiresImmediateRenegotiation?: boolean }

const voicePath = (sid: string): string => '/api/voice/session/' + encodeURIComponent(sid);

export function voiceIce(): Promise<VoiceIce> {
  return socialJson<VoiceIce>('GET', '/api/voice/ice');
}

export function voiceSession(): Promise<VoiceSession> {
  return socialJson<VoiceSession>('POST', '/api/voice/session');
}

export function voiceNewTracks(sid: string, body: unknown): Promise<VoiceTracksReply> {
  return socialJson<VoiceTracksReply>('POST', voicePath(sid) + '/tracks', body);
}

export function voiceRenegotiate(sid: string, body: unknown): Promise<void> {
  return socialJson('PUT', voicePath(sid) + '/renegotiate', body).then(() => undefined);
}

export function voiceCloseTracks(sid: string, body: unknown): Promise<void> {
  return socialJson('PUT', voicePath(sid) + '/tracks/close', body).then(() => undefined);
}
