import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { partStore } from './parts.js';
import { cliPath } from './paths.js';
import { buildSite, type ClaimResults } from './site.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'app-url': { type: 'string' },
    parts: { type: 'string' },
    'release-base': { type: 'string', default: process.env.SNAPSHOT_RELEASE_BASE },
    /** 前回の配信の紐づけの確認の結果（https://<配信先>/api/v1/claims.json）。取れなければ全部確かめる */
    'claims-cache': { type: 'string' },
    root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  },
});

if (!values.out || !values['app-url']) {
  console.error('usage: npm run site -- --out <dir> --app-url https://<owner>.github.io/<repo>/ [--root .] [--parts <dir>] [--release-base <url>] [--claims-cache <url>]');
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
const root = cliPath(values.root);
const parts = partStore(values.parts ? cliPath(values.parts) : join(root, '.snapshot-parts'), values['release-base'] || null);
let previousClaims: ClaimResults = {};
if (values['claims-cache']) {
  try {
    const res = await fetch(values['claims-cache']);
    if (res.ok) previousClaims = (await res.json()) as ClaimResults;
    else console.warn(`${values['claims-cache']}: HTTP ${res.status}; checking every claim`);
  } catch (e) {
    console.warn(`could not read ${values['claims-cache']}; checking every claim`, e);
  }
}
const { players } = await buildSite({ root, out: cliPath(values.out), appUrl, fetchFn, parts, previousClaims, now: Math.floor(Date.now() / 1000) });
console.log(`wrote ${players} player pages and API files to ${values.out}`);
