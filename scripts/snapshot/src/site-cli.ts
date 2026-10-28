import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSite } from './site.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'app-url': { type: 'string' },
    root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  },
});

if (!values.out || !values['app-url']) {
  console.error('usage: npm run site -- --out <dir> --app-url https://<owner>.github.io/<repo>/ [--root .]');
  process.exit(2);
}

// GitHub の API は認証すると回数の上限が上がる（Actions では GITHUB_TOKEN を渡す）
const token = process.env.GITHUB_TOKEN;
const fetchFn: typeof fetch = (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  if (token && url.startsWith('https://api.github.com/')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

const appUrl = values['app-url'].endsWith('/') ? values['app-url'] : `${values['app-url']}/`;
const { players } = await buildSite({ root: resolve(values.root), out: resolve(values.out), appUrl, fetchFn });
console.log(`wrote ${players} player pages and API files to ${values.out}`);
