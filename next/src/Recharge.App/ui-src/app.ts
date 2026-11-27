import { Router, type PageRegistry } from './router.js';
import { bindRouter } from './navigation.js';
import { initShell, setActive } from './shell.js';
import { homePage } from './pages/home.js';
import { libraryPage } from './pages/library.js';
import { communityPage } from './pages/community.js';
import { notebookPage } from './pages/notebook.js';
import { settingsPage } from './pages/settings.js';
import './settings/boot.js';
import { ampPage } from './pages/amp.js';
import { notFoundPage } from './pages/notFound.js';
import { initPerf } from './perf.js';
import { initUnread } from './social/unread.js';
import { initMessageAlerts } from './social/messageAlerts.js';
import { initCallAlerts } from './social/callAlert.js';
import { themeAllSelects } from './components/dropdown.js';
import { initChangelog } from './changelog.js';

const routes: PageRegistry = {
  home: homePage,
  library: libraryPage,
  community: communityPage,
  notebook: notebookPage,
  settings: settingsPage,
  amp: ampPage,
};

const outlet = document.getElementById('page') as HTMLElement;

const router = new Router({
  outlet,
  routes,
  notFound: notFoundPage,
  onRoute: (route) => setActive(route.sidebar),
});
themeAllSelects();
bindRouter(router);
initShell({ onSearch: (query) => router.filter(query) });
// The popup waits for the first page to mount, then does its bridge calls in the background.
void router.start().then(
  () => { void initChangelog(); },
  () => { void initChangelog(); }
);
void initPerf();
initUnread();
initMessageAlerts();
initCallAlerts();
