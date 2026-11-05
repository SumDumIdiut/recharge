import { Router, type PageRegistry } from './router.js';
import { bindRouter } from './navigation.js';
import { initShell, setActive } from './shell.js';
import { homePage } from './pages/home.js';
import { libraryPage } from './pages/library.js';
import { communityPage } from './pages/community.js';
import { lobbiesPage } from './pages/lobbies.js';
import { notebookPage } from './pages/notebook.js';
import { settingsPage } from './pages/settings.js';
import './settings/boot.js';
import { notFoundPage } from './pages/notFound.js';
import { initPerf } from './perf.js';
import { themeAllSelects } from './components/dropdown.js';

const routes: PageRegistry = {
  home: homePage,
  library: libraryPage,
  community: communityPage,
  lobbies: lobbiesPage,
  notebook: notebookPage,
  settings: settingsPage,
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
void router.start();
void initPerf();
