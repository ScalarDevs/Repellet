export type Page = 'projects' | 'settings' | 'github' | 'admin' | 'workspace';
export type Route = { page: Page; project: string; tab?: string };

export function parseRoute(pathname = location.pathname): Route {
  const match = pathname.match(/^\/projects\/([a-f0-9-]+)$/);
  if (match) return { page: 'workspace', project: match[1]! };
  const settingsMatch = pathname.match(/^\/settings(?:\/([a-z-]+))?$/);
  if (settingsMatch) return { page: 'settings', project: '', tab: settingsMatch[1] || 'account' };
  if (pathname === '/admin') return { page: 'admin', project: '' };
  if (pathname === '/github') return { page: 'github', project: '' };
  return { page: 'projects', project: '' };
}

export function pathFor(page: Page, project = '', tab = '') {
  if (page === 'workspace') return `/projects/${project}`;
  if (page === 'projects') return '/';
  if (page === 'settings') return tab ? `/settings/${tab}` : '/settings';
  return `/${page}`;
}
