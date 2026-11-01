/** Small formatting and choice helpers for the Create page. DOM-free. */

export function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return 'just now';
  const plural = (n: number, unit: string) => n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(seconds / 86400);
  if (days < 30) return plural(days, 'day');
  const months = Math.round(days / 30);
  if (months < 12) return plural(months, 'month');
  return plural(Math.round(days / 365), 'year');
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return Math.round(bytes) + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return (kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
  return Math.round((mb / 1024) * 10) / 10 + ' GB';
}

export interface CreateMap {
  folder: string;
  name: string;
  hubId: string | null;
  hubName: string | null;
  revision: number | null;
  local: boolean;
  hasThumb: boolean;
  hasPreview: boolean;
  modified: string;
  sizeBytes: number;
}

export type ThumbSource = { kind: 'thumb' } | { kind: 'hub'; file: string } | { kind: 'cover' };

/** thumb.png wins; then the hub row's first gallery picture; else the cover. */
export function thumbSource(map: Pick<CreateMap, 'hasThumb' | 'hasPreview' | 'hubId'>, hubGallery: string[] | null | undefined): ThumbSource {
  // A render of this exact version of the map (with its background) comes first, then the hub's current picture, then the
  // packaged thumb.png (which can be an older version's picture), then the cover.
  if (map.hasPreview) return { kind: 'thumb' };
  if (map.hubId && hubGallery && hubGallery.length > 0) return { kind: 'hub', file: hubGallery[0] };
  if (map.hasThumb) return { kind: 'thumb' };
  return { kind: 'cover' };
}

export function normalizeMaps(raw: unknown): CreateMap[] {
  const rows = raw && typeof raw === 'object' ? (raw as { maps?: unknown }).maps : null;
  if (!Array.isArray(rows)) return [];
  const out: CreateMap[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.folder !== 'string') continue;
    out.push({
      folder: r.folder,
      name: typeof r.name === 'string' && r.name ? r.name : r.folder,
      hubId: typeof r.hubId === 'string' ? r.hubId : null,
      hubName: typeof r.hubName === 'string' ? r.hubName : null,
      revision: typeof r.revision === 'number' ? r.revision : null,
      local: r.local === true,
      hasThumb: r.hasThumb === true,
      hasPreview: r.hasPreview === true,
      modified: typeof r.modified === 'string' ? r.modified : '',
      sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : 0,
    });
  }
  return out;
}

/** Base64 image reply {mime, data} to a blob URL, or null when there is no data. */
export function blobUrlFromReply(reply: { mime?: string; data?: string | null } | null): string | null {
  if (!reply || !reply.data) return null;
  const raw = atob(reply.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: reply.mime || 'image/png' }));
}
