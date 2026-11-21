export type View = 'browse' | 'viewer';

export interface Route {
  view: View;
  rootId?: string;
  path: string;
}

export function parseRoute(search: string = window.location.search): Route {
  const params = new URLSearchParams(search);
  const rootId = params.get('root') ?? undefined;
  const path = params.get('path') ?? '';
  const view = params.get('view') === 'viewer' ? 'viewer' : 'browse';
  if (view === 'viewer' && (!rootId || !path)) {
    return { view: 'browse', rootId, path: '' };
  }
  return { view, rootId, path };
}

export function routeToUrl(route: Route): string {
  const params = new URLSearchParams();
  if (route.rootId) params.set('root', route.rootId);
  if (route.path) params.set('path', route.path);
  if (route.view === 'viewer') params.set('view', 'viewer');
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const url = routeToUrl(route);
  if (options.replace) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function dirnameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? '' : relativePath.slice(0, index);
}

export function basenameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

export function joinPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}
