/** Pure pieces of the Upload form and the upload cards' GitHub auto-update line (no DOM, so they can be tested). */
import { githubRepoUrl } from './sourceUrl.js';

export type UploadKind = 'mod' | 'map' | 'skin';
export const UPLOAD_KINDS: Array<{ value: UploadKind; label: string }> = [
  { value: 'mod', label: 'Mod' },
  { value: 'map', label: 'Map' },
  { value: 'skin', label: 'Skin' },
];
export const MAX_GALLERY = 8;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 2000;
export const REPO_HINT = "Paste the GitHub repo with the mod's source, like https://github.com/owner/repo";

/** The latest GitHub release of a mod's repo, as GET /api/github/release answers it. */
export interface ReleaseInfo {
  repo: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  version: string;
  asset: { name: string; size: number } | null;
  problem: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Shapes the hub's release reply; null when it is not an object. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  const a = r.asset && typeof r.asset === 'object' ? r.asset as Record<string, unknown> : null;
  const assetName = a ? str(a.name) : '';
  return {
    repo: str(r.repo),
    tag: str(r.tag),
    name: str(r.name),
    notes: str(r.notes),
    publishedAt: str(r.publishedAt),
    version: str(r.version),
    asset: assetName ? { name: assetName, size: typeof a?.size === 'number' ? a.size : 0 } : null,
    problem: str(r.problem) || null,
  };
}

/** "Latest release v0.6.1 · Tas-Studio-0.6.1.zip", or the reason the release can't be used. */
export function releaseLine(release: ReleaseInfo | null): string {
  if (!release) return '';
  const head = release.tag ? 'Latest release ' + release.tag : 'Latest release';
  if (release.problem) return head + ' · ' + release.problem;
  return release.asset ? head + ' · ' + release.asset.name : head + ' · no zip attached';
}

const TAGLIKE = /^v?\d+(\.\d+)*([-+.][0-9A-Za-z.]+)?$/i;

/** "Tas-Studio" -> "Tas Studio". */
export function prettyRepoName(repoUrl: string): string {
  const repo = repoUrl.replace(/\/+$/, '').split('/').pop() || '';
  return repo.replace(/\.git$/i, '').replace(/[-_.]+/g, ' ').trim().replace(/\s+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The release's name when it says something, else the repository's name made readable (a release called just "v0.6.1" is a tag). */
export function suggestedName(release: ReleaseInfo, repoUrl: string): string {
  const name = release.name.trim();
  if (name && !TAGLIKE.test(name) && name !== release.tag) return name;
  return prettyRepoName(repoUrl);
}

export type FileSource = 'release' | 'zip';

export interface UploadForm {
  kind: UploadKind;
  repo: string;
  name: string;
  author: string;
  version: string;
  description: string;
  source: FileSource;
  zipPath: string;
  gallery: string[];
  release: ReleaseInfo | null;
}

/** The first problem with the form, in plain words, or null when it can be sent. */
export function validateUpload(form: UploadForm): string | null {
  if (form.kind === 'mod') {
    if (!form.repo.trim()) return REPO_HINT;
    if (!githubRepoUrl(form.repo)) return REPO_HINT;
  }
  if (!form.name.trim()) return 'Give it a name.';
  if (form.name.trim().length > NAME_MAX) return 'The name is over ' + NAME_MAX + ' characters.';
  if (form.description.trim().length > DESCRIPTION_MAX) return 'The description is over ' + DESCRIPTION_MAX + ' characters.';
  if (form.gallery.length > MAX_GALLERY) return 'Add at most ' + MAX_GALLERY + ' screenshots.';
  if (form.kind === 'mod' && form.source === 'release') {
    if (!form.release?.asset) return form.release?.problem || 'That release has no zip. Choose a zip instead.';
  } else if (!form.zipPath) {
    return form.kind === 'mod' ? 'Choose the mod zip, or use the GitHub release.' : 'Choose the zip to upload.';
  }
  return null;
}

/** The text fields POST /api/submit takes (the zip and pictures travel as files). */
export function buildFields(form: UploadForm): Record<string, string> {
  const fields: Record<string, string> = {
    kind: form.kind,
    name: form.name.trim(),
    author: form.author.trim(),
    description: form.description.trim(),
    version: form.version.trim(),
  };
  if (form.kind === 'mod') {
    fields.sourceUrl = githubRepoUrl(form.repo) || '';
    if (form.source === 'release') fields.fromRelease = '1';
  }
  return fields;
}

/** The file name at the end of a path from either OS. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Image extensions the hub takes for screenshots. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** Adds paths to the gallery without repeats, up to the limit. */
export function addGallery(current: string[], added: string[]): string[] {
  const next = current.slice();
  for (const path of added) if (!next.includes(path) && next.length < MAX_GALLERY) next.push(path);
  return next;
}

// ---- the upload card's GitHub line ----

export interface AutoUpdateInfo {
  autoUpdate: boolean;
  releaseTag: string;
  releaseCheckedAt: string;
  releaseError: string;
}

export interface AutoUpdateLine { text: string; tone: 'ok' | 'off' | 'error' }

/** "Auto-updates from GitHub · v0.6.1 · checked 5 min ago", "Auto-update off", or the error in a warning tone. */
export function autoUpdateLine(info: AutoUpdateInfo, ago: (iso: string) => string): AutoUpdateLine {
  if (!info.autoUpdate) return { text: 'Auto-update off', tone: 'off' };
  if (info.releaseError) return { text: info.releaseError, tone: 'error' };
  const parts = ['Auto-updates from GitHub'];
  if (info.releaseTag) parts.push(info.releaseTag);
  const when = info.releaseCheckedAt ? ago(info.releaseCheckedAt) : '';
  parts.push(when ? 'checked ' + when : 'not checked yet');
  return { text: parts.join(' · '), tone: 'ok' };
}

export interface CheckReply { status: string; tag: string; version: string; error: string }

export function parseCheck(json: unknown): CheckReply {
  const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  return { status: str(r.status), tag: str(r.tag), version: str(r.version), error: str(r.error) };
}

/** What the "Check GitHub now" toast says, and in which tone. */
export function checkMessage(name: string, reply: CheckReply): { text: string; kind: 'success' | 'info' | 'error' } {
  const which = reply.tag || (reply.version ? 'v' + reply.version : '');
  switch (reply.status) {
    case 'up-to-date': return { text: name + ' is up to date' + (which ? ' (' + which + ')' : ''), kind: 'info' };
    case 'updated': return { text: name + ' updated to ' + (which || 'the latest release'), kind: 'success' };
    case 'pending-review': return { text: (which ? which + ' of ' : '') + name + ' is waiting for review', kind: 'success' };
    case 'off': return { text: 'Auto-update is off for ' + name, kind: 'info' };
    default: return { text: reply.error || 'Could not check GitHub for ' + name, kind: 'error' };
  }
}
