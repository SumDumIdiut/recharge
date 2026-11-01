import { go } from '../navigation.js';
import { pageTemplate } from '../components/page.js';
import { emptyState } from '../components/emptyState.js';
import type { PageModule } from '../router.js';

export const notFoundPage: PageModule = {
  title: 'Not found',
  mount(el): void {
    const page = pageTemplate({ title: 'Not found' });
    page.content.appendChild(
      emptyState('alert', 'Page not found', 'That address does not lead anywhere in Recharge.', {
        label: 'Go home',
        kind: 'primary',
        onClick: () => go('#/home'),
      })
    );
    el.appendChild(page);
  },
};
