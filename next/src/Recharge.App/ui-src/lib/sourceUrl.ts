/** The GitHub repository of a mod's source code. Same rule as the hub: https://github.com/<owner>/<repo>, no other site. */
const REPO = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})\/?$/;

/** The clean repository address (no trailing slash or .git), or null when the value is not a github.com repository. */
export function githubRepoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = REPO.exec(value.trim());
  if (!match) return null;
  const repo = match[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return null;
  return 'https://github.com/' + match[1] + '/' + repo;
}

/** "owner/repo" for showing next to a link. */
export function repoLabel(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, '');
}
