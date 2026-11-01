/** Pure helpers for the update bar and Settings > Updates (no DOM, so tools/ui-tests can run them). */

export interface UpdateStatusLike {
  version: string;
  build: number;
  managed: boolean;
  auto: boolean;
  lastCheck: string;
  lastCheckState: string;
  lastCheckError: string;
  ready: { version: string; build: number } | null;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; "never" for an empty or invalid time. */
export function formatAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : m + ' minutes ago';
  const hr = Math.round(m / 60);
  if (hr < 24) return hr === 1 ? '1 hour ago' : hr + ' hours ago';
  const d = Math.round(hr / 24);
  return d === 1 ? '1 day ago' : d + ' days ago';
}

/** The text of the "ready" bar, or null when no update is waiting. */
export function barMessage(status: Pick<UpdateStatusLike, 'ready'> | null): string | null {
  if (!status || !status.ready) return null;
  const v = status.ready.version;
  return v ? 'Recharge ' + v + ' is ready \u2014 Restart to update' : 'A new version of Recharge is ready \u2014 Restart to update';
}

/** The bar shows for a waiting update unless the user dismissed this very build. */
export function shouldShowBar(status: Pick<UpdateStatusLike, 'ready'> | null, dismissedBuild: number): boolean {
  return !!status && !!status.ready && status.ready.build !== dismissedBuild;
}

/** The one-line summary Settings shows under "Updates". */
export function lastCheckLine(status: UpdateStatusLike, now: number): string {
  if (status.ready) return 'Version ' + status.ready.version + ' is downloaded. Restart Recharge to install it.';
  if (status.lastCheckState === 'error') return 'Last check ' + formatAgo(status.lastCheck, now) + ' failed: ' + status.lastCheckError;
  if (!status.lastCheck) return 'Not checked yet.';
  const when = 'Last checked ' + formatAgo(status.lastCheck, now);
  if (status.lastCheckState === 'none-yet') return when + ': no updates have been published yet.';
  return when + ': you have the latest version.';
}

export function channelLabel(channel: string): string {
  return channel === 'beta' ? 'Beta' : 'Stable';
}
