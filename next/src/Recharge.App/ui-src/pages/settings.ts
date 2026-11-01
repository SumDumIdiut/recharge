import { replace } from '../navigation.js';
import { pageTemplate } from '../components/page.js';
import { tabs } from '../components/tabs.js';
import { buildRoute, type PageModule } from '../router.js';
import { gameSection } from '../settings/game.js';
import { appearanceSection } from '../settings/appearance.js';
import { updatesSection } from '../settings/updates.js';
import { accountSection } from '../settings/account.js';
import { aboutSection } from '../settings/about.js';
import { profileSection } from '../profile/editor.js';
import type { Section as Built } from '../settings/ui.js';

type Section = 'game' | 'appearance' | 'updates' | 'account' | 'profile' | 'about';

const SECTIONS = [
  { value: 'game', label: 'Game', icon: 'gamepad' },
  { value: 'appearance', label: 'Appearance', icon: 'image' },
  { value: 'updates', label: 'Updates', icon: 'download' },
  { value: 'account', label: 'Account', icon: 'user' },
  { value: 'profile', label: 'Profile', icon: 'sparkles' },
  { value: 'about', label: 'About', icon: 'info' },
];

const BUILDERS: Record<Section, () => Built> = {
  game: gameSection,
  appearance: appearanceSection,
  updates: updatesSection,
  account: accountSection,
  profile: profileSection,
  about: aboutSection,
};

function sectionRoute(section: Section): string {
  if (section === 'about') return buildRoute('/settings/about');
  if (section === 'profile') return buildRoute('/settings/profile');
  if (section === 'game') return buildRoute('/settings');
  return buildRoute('/settings', { section });
}

function initial(params: Record<string, string>, query: Record<string, string>): Section {
  const wanted = query.section || params.section;
  return wanted === 'appearance' || wanted === 'updates' || wanted === 'account' || wanted === 'profile' || wanted === 'about' ? wanted : 'game';
}

let built: Built | null = null;

export const settingsPage: PageModule = {
  title: 'Settings',
  mount(el, route): void {
    let section: Section = initial(route.params, route.query);
    const page = pageTemplate({
      title: 'Settings',
      subtitle: 'Tune Recharge to your setup.',
      tabs: tabs(SECTIONS, {
        value: section,
        onChange: (value) => {
          section = value as Section;
          replace(sectionRoute(section));
          paint();
        },
      }),
    });
    function paint(): void {
      if (built && built.dispose) built.dispose();
      built = BUILDERS[section]();
      page.content.replaceChildren(built.node);
    }
    paint();
    el.appendChild(page);
  },
  unmount(): void {
    if (built && built.dispose) built.dispose();
    built = null;
  },
};
