import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { isSidebarCollapsed, setSidebarCollapsed, onSidebarChange } from '../shell.js';
import { getSettings, saveSettings } from './api.js';
import { applyTheme, isEventOn, onThemeChange, type ThemeChoice } from './theme.js';
import { panel, row, setSwitch, switchControl, type Section } from './ui.js';
import { backgroundSection } from './appearanceBackground.js';

export function appearanceSection(): Section {
  const toggle = switchControl('Collapse the sidebar', isSidebarCollapsed(), (next) => setSidebarCollapsed(next));
  const off = onSidebarChange((collapsed) => {
    setSwitch(toggle, collapsed);
    void saveSettings({ sidebarCollapsed: collapsed }).catch(() => undefined);
  });

  const choice = h('div', { className: 'theme-choice' });
  const auto = button('Automatic', { kind: 'secondary', title: 'Follows Recharge events: Halloween while the Halloween event runs', onClick: () => void pickTheme('auto') });
  const classic = button('Classic', { kind: 'secondary', onClick: () => void pickTheme('classic') });
  const halloween = button('Halloween', { kind: 'secondary', onClick: () => void pickTheme('halloween') });
  choice.append(auto, classic, halloween);
  const eventNote = h('span', { className: 'dim' });
  let picked = 'auto';
  function paintTheme(theme: string): void {
    picked = theme;
    auto.setAttribute('aria-pressed', theme === 'auto' ? 'true' : 'false');
    classic.setAttribute('aria-pressed', theme === 'classic' ? 'true' : 'false');
    halloween.setAttribute('aria-pressed', theme === 'halloween' ? 'true' : 'false');
    eventNote.textContent = isEventOn() ? (picked === 'classic' ? 'The Halloween event is on; you picked Classic.' : 'The Halloween event is on.') : '';
  }
  const offTheme = onThemeChange(() => paintTheme(picked));
  async function pickTheme(theme: ThemeChoice): Promise<void> {
    applyTheme(theme);
    paintTheme(theme);
    try {
      await saveSettings({ theme });
    } catch (e) {
      toast(describeError(e), 'error');
    }
  }
  void getSettings().then((s) => paintTheme(s.theme), () => paintTheme('auto'));

  const background = backgroundSection();
  const node = h('div', { className: 'appearance-stack' });
  node.append(
    panel(
      'Appearance',
      row('Collapse sidebar', 'Show only icons in the sidebar. It also collapses by itself in narrow windows.', toggle),
      row('Theme', 'Automatic follows Recharge events, like Halloween.', h('div', { className: 'settings-row-wrap' }, eventNote, choice))
    ),
    ...background.nodes
  );
  node.style.display = 'flex';
  node.style.flexDirection = 'column';
  node.style.gap = '16px';
  return {
    node,
    dispose: () => {
      off();
      offTheme();
      background.dispose();
    },
  };
}
