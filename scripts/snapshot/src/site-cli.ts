import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { partStore } from './parts.js';
import { buildSite } from './site.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'app-url': { type: 'string' },
    parts: { type: 'string' },
    'release-base': { type: 'string', default: process.env.SNAPSHOT_RELEASE_BASE },
    root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  },
});

if (!values.out || !values['app-url']) {
  console.error('usage: npm run site -- --out <dir> --app-url https://<owner>.github.io/<repo>/ [--root .] [--parts <dir>] [--release-base <url>]');
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
const root = resolve(values.root);
const parts = partStore(resolve(values.parts ?? join(root, '.snapshot-parts')), values['release-base'] || null);
const { players } = await buildSite({ root, out: resolve(values.out), appUrl, fetchFn, parts });
console.log(`wrote ${players} player pages and API files to ${values.out}`);
