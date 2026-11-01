import { getSettings } from './api.js';
import { applyAll, applyTheme, startEventWatch } from './theme.js';
import { setSidebarCollapsed } from '../shell.js';

/** Applies the saved theme, background and sidebar choice when the app starts. A missing bridge (plain browser) is fine. */
export async function bootSettings(): Promise<void> {
  applyTheme('auto');
  startEventWatch();
  try {
    const settings = await getSettings();
    if (settings.sidebarCollapsed) setSidebarCollapsed(true);
    await applyAll(settings);
  } catch {
    /* No bridge or unreadable settings: keep the defaults. */
  }
}

void bootSettings();
