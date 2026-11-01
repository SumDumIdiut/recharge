import { call } from '../bridge.js';

export interface Settings {
  gamePath: string | null;
  sidebarCollapsed: boolean;
  theme: 'auto' | 'classic' | 'halloween';
  background: string | null;
  backgroundSource: 'none' | 'background' | 'playlist';
  backgroundPlaylist: string | null;
  bgFit: string;
  bgPosition: string;
  bgDim: number;
  bgTint: string | null;
  bgBlur: number;
  bgInterval: number;
  bgShuffle: boolean;
  bgFadeMs: number;
  bgPauseUnfocused: boolean;
  bgStillOnly: boolean;
  bgPageDim: Record<string, number>;
  updateChannel: 'stable' | 'beta';
  updateUrl: string | null;
  autoUpdate: boolean;
}

export interface UpdateStatus {
  version: string;
  build: number;
  channel: string;
  /** Installed by the Recharge launcher, which then does the updating. */
  managed: boolean;
  auto: boolean;
  url: string;
  defaultUrl: string;
  lastCheck: string;
  lastCheckState: string;
  lastCheckError: string;
  ready: { version: string; build: number } | null;
  staged: { version: string; build: number } | null;
  lastRollback: string;
  failure: string;
}

export interface UpdateCheck {
  state: 'none-yet' | 'up-to-date' | 'available' | 'ready';
  version: string;
  build: number;
  files: number;
  downloadBytes: number;
}

export interface LoaderStatus {
  state: string;
  legacy: boolean;
  hasBackup: boolean;
  detail: string;
}

export interface BackgroundRow {
  folder: string;
  name: string;
}

export const getSettings = (): Promise<Settings> => call<Settings>('settings.get');
export const saveSettings = (patch: Partial<Settings> | Record<string, unknown>): Promise<Settings> => call<Settings>('settings.set', patch as Record<string, unknown>);
export const setGamePath = (path: string | null): Promise<Settings> => call<Settings>('settings.setGamePath', { path });
export const pickFolder = (start?: string): Promise<{ path: string | null }> => call('settings.pickFolder', { start: start || '' });
export const openGameFolder = (): Promise<unknown> => call('settings.openGameFolder');
export const readBackground = (folder: string): Promise<{ kind: string; mime: string; data: string | null }> => call('settings.background', { folder });
export const updateStatus = (): Promise<UpdateStatus> => call<UpdateStatus>('updates.status');
export const updateCheck = (): Promise<UpdateCheck> => call<UpdateCheck>('updates.check');
export const updateDownload = (): Promise<UpdateCheck> => call<UpdateCheck>('updates.download');
export const updateBegin = (): Promise<UpdateStatus> => call<UpdateStatus>('updates.begin');
export const updateRestart = (): Promise<{ restarting: boolean }> => call('updates.restart');
export const updateSetChannel = (channel: 'stable' | 'beta'): Promise<UpdateStatus> => call<UpdateStatus>('updates.setChannel', { channel });

export async function installedBackgrounds(): Promise<BackgroundRow[]> {
  const data = await call<{ backgrounds?: BackgroundRow[] }>('library.installed');
  return Array.isArray(data.backgrounds) ? data.backgrounds : [];
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
