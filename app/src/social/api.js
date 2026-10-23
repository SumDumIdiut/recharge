// Thin client for the hub's forum / comments / profile routes. Errors carry a readable message for inline display.
import { HUB_BASE } from '../hub.js';
import { getToken } from '../auth.js';

export class HubError extends Error {
  constructor(message, status = 0, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Turns a failed response into the sentence shown to the person.
export function errorMessage(status, body) {
  const msg = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401) return 'You need to log in to do that.';
  if (status === 429) {
    const s = Number(body?.retry_after) || 0;
    const wait = s >= 120 ? `${Math.ceil(s / 60)} minutes` : s > 0 ? `${s} seconds` : 'a while';
    return `Slow down - you are doing that too often. Try again in ${wait}.`;
  }
  if (status === 413) return 'That image is too large.';
  if (status === 415) return 'Images must be PNG, JPEG, GIF or WebP.';
  if (status === 403) return msg ? `Not allowed: ${msg}.` : 'You are not allowed to do that.';
  if (status === 404) return 'Not found - it may have been deleted.';
  return msg || `Request failed (${status}).`;
}

// path starts with /api/...; body: plain object (JSON), FormData, or undefined.
export async function hub(path, { method = 'GET', body, auth = true, fetchFn = (...a) => fetch(...a) } = {}) {
  const headers = {};
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetchFn(HUB_BASE + path, { method, headers, body: payload });
  } catch {
    throw new HubError("Couldn't reach the Recharge hub. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HubError(errorMessage(res.status, data), res.status, Number(data?.retry_after) || 0);
  return data;
}

export const enc = encodeURIComponent;

export function multipart(fields, images = [], field = 'images') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, v);
  for (const f of images) fd.append(field, f, f.name || 'image');
  return fd;
}

export const forum = {
  list: (q) => hub(`/api/forum?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null))}`),
  get: (id) => hub(`/api/forum/${enc(id)}`),
  create: (fields, images) => hub('/api/forum', { method: 'POST', body: multipart(fields, images) }),
  edit: (id, fields, images = []) => hub(`/api/forum/${enc(id)}`, { method: 'PUT', body: multipart(fields, images) }),
  remove: (id) => hub(`/api/forum/${enc(id)}`, { method: 'DELETE' }),
  reply: (id, body, images) => hub(`/api/forum/${enc(id)}/replies`, { method: 'POST', body: multipart({ body }, images) }),
  editReply: (rid, body) => hub(`/api/forum/replies/${enc(rid)}`, { method: 'PUT', body: { body } }),
  removeReply: (rid) => hub(`/api/forum/replies/${enc(rid)}`, { method: 'DELETE' }),
};

export const comments = {
  list: (kind, id, page = 1) => hub(`/api/${enc(kind)}/${enc(id)}/comments?page=${page}`),
  add: (kind, id, body, parent_id) => hub(`/api/${enc(kind)}/${enc(id)}/comments`, { method: 'POST', body: parent_id ? { body, parent_id } : { body } }),
  edit: (cid, body) => hub(`/api/comments/${enc(cid)}`, { method: 'PUT', body: { body } }),
  remove: (cid) => hub(`/api/comments/${enc(cid)}`, { method: 'DELETE' }),
};

// The caller's own uploads, and the admins' view of everybody's. `opts` (e.g. { fetchFn }) goes
// to hub(), so a test can drive the route without a network.
export const submissions = {
  mine: (opts) => hub('/api/me/submissions', opts),
  admin: (opts) => hub('/api/admin/submissions', opts),
  patch: (id, body, opts) => hub(`/api/submissions/${enc(id)}`, { ...opts, method: 'PATCH', body }),
  remove: (id, opts) => hub(`/api/submissions/${enc(id)}`, { ...opts, method: 'DELETE' }),
};

export const profiles = {
  get: (name) => hub(`/api/users/${enc(name)}`, { auth: false }),
  me: () => hub('/api/me'),
  save: (fields) => hub('/api/me/profile', { method: 'PUT', body: fields }),
  setAvatar: (blob) => hub('/api/me/avatar', { method: 'POST', body: multipart({}, [blob], 'image') }),
  clearAvatar: () => hub('/api/me/avatar', { method: 'DELETE' }),
  setBanner: (blob) => hub('/api/me/banner', { method: 'POST', body: multipart({}, [blob], 'image') }),
  clearBanner: () => hub('/api/me/banner', { method: 'DELETE' }),
};

// The public player directory (hub/users). Search is a name match, prefix first.
export const moderation = {
  users: (q) => hub(`/api/users${q ? `?q=${encodeURIComponent(q)}` : ''}`, { auth: false }),
};
