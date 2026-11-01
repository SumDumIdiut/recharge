import { call } from '../bridge.js';
import type { PlaylistItem } from './model.js';

export interface MediaEntry extends PlaylistItem {
  poster?: string | null;
}

export interface BackgroundRow {
  folder: string;
  name: string;
  hubId: string | null;
  media: MediaEntry | null;
}

export interface PlaylistRow {
  folder: string;
  name: string;
  hubId: string | null;
  own: boolean;
  items: MediaEntry[];
}

export interface BackgroundList {
  backgrounds: BackgroundRow[];
  playlists: PlaylistRow[];
}

const lower = (e: Record<string, unknown> | null): MediaEntry | null =>
  e ? { file: String(e.file), kind: e.kind === 'video' ? 'video' : 'image', poster: typeof e.poster === 'string' ? e.poster : null } : null;

let videoBase = '';

/** The address videos are played from ('' until the first listBackgrounds, or when the app has no server). */
export function videoBaseUrl(): string {
  return videoBase;
}

export async function listBackgrounds(): Promise<BackgroundList> {
  if (!videoBase) {
    try {
      videoBase = (await call<{ mediaBase: string }>('backgrounds.mediaBase')).mediaBase;
    } catch {
      /* videos just won't play */
    }
  }
  const data = await call<{ backgrounds?: Array<Record<string, unknown>>; playlists?: Array<Record<string, unknown>> }>('backgrounds.list');
  return {
    backgrounds: (data.backgrounds || []).map((b) => ({
      folder: String(b.folder), name: String(b.name || b.folder), hubId: typeof b.hubId === 'string' ? b.hubId : null,
      media: lower(b.media as Record<string, unknown> | null),
    })),
    playlists: (data.playlists || []).map((p) => ({
      folder: String(p.folder), name: String(p.name || p.folder), hubId: typeof p.hubId === 'string' ? p.hubId : null, own: p.own === true,
      items: ((p.items as Array<Record<string, unknown>>) || []).map((e) => lower(e)!).filter(Boolean),
    })),
  };
}

export const pickMediaFile = (): Promise<{ path: string | null }> => call('backgrounds.pickFile');
export const importBackground = (path: string, name?: string): Promise<{ folder: string }> => call('backgrounds.import', { path, name: name || '' });
export const createPlaylist = (name: string): Promise<{ folder: string }> => call('backgrounds.createPlaylist', { name });
export const addFileToPlaylist = (playlist: string, path: string): Promise<{ file: string }> => call('backgrounds.addFile', { playlist, path });
export const addInstalledToPlaylist = (playlist: string, background: string): Promise<{ file: string }> => call('backgrounds.addInstalled', { playlist, background });
export const savePlaylistOrder = (playlist: string, files: string[]): Promise<unknown> => call('backgrounds.saveOrder', { playlist, files });
export const renamePlaylist = (playlist: string, name: string): Promise<unknown> => call('backgrounds.renamePlaylist', { playlist, name });
export const deletePlaylist = (playlist: string): Promise<unknown> => call('backgrounds.deletePlaylist', { playlist });
