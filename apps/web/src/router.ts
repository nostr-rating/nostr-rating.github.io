import { useEffect, useState } from 'react';

export type Route =
  | { name: 'onboarding' }
  | { name: 'lobby' }
  | { name: 'match'; id: string }
  | { name: 'settings' }
  | { name: 'ranking' }
  | { name: 'player'; pubkey: string };

export function parseHash(hash: string): Route {
  const [name, param] = hash.replace(/^#\/?/, '').split('/');
  switch (name) {
    case 'onboarding':
      return { name: 'onboarding' };
    case 'match':
      return param ? { name: 'match', id: param } : { name: 'lobby' };
    case 'settings':
      return { name: 'settings' };
    case 'ranking':
      return { name: 'ranking' };
    case 'player':
      return param ? { name: 'player', pubkey: param } : { name: 'ranking' };
    default:
      return { name: 'lobby' };
  }
}

export function routeHash(r: Route): string {
  switch (r.name) {
    case 'match':
      return `#/match/${r.id}`;
    case 'player':
      return `#/player/${r.pubkey}`;
    default:
      return `#/${r.name}`;
  }
}

export function navigate(r: Route): void {
  location.hash = routeHash(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
