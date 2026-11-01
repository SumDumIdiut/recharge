import { getSettings, saveSettings } from '../settings/api.js';
import { applyConfig } from './index.js';
import { configFromSettings, configToPatch } from './model.js';

/** Makes an installed background or playlist the app's background (saved and shown at once). */
export async function useAsBackground(kind: 'backgrounds' | 'playlists', folder: string): Promise<string | null> {
  const config = configFromSettings(await getSettings());
  if (kind === 'backgrounds') {
    config.source = 'background';
    config.background = folder;
  } else {
    config.source = 'playlist';
    config.playlist = folder;
  }
  const note = await applyConfig(config);
  await saveSettings(configToPatch(config));
  return note;
}
