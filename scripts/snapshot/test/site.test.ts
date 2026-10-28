import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { verificationText, type Snapshot } from '@nostr-rating/core';
import { buildSite, type PlayerDoc } from '../src/site.js';

const FIXTURES = resolve(__dirname, 'fixtures');
let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nr-site-'));
  out = join(root, 'dist');
  // golden のスナップショットを最新として置く
  cpSync(join(FIXTURES, 'snapshot.json'), join(root, 'snapshots/season_1/2026-10-02.json'));
  cpSync(join(FIXTURES, 'latest.json'), join(root, 'snapshots/latest.json'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const snapshot = () => JSON.parse(readFileSync(join(FIXTURES, 'snapshot.json'), 'utf8')) as Snapshot;
const read = <T>(p: string) => JSON.parse(readFileSync(join(out, p), 'utf8')) as T;

/** a1 の Gist だけが本物（本文に aid がある）。b2 は所有者が違う */
function stubFetch(): typeof fetch {
  const s = snapshot();
  const aidOf = (identity: string) => Object.entries(s.accounts).find(([, a]) => a.claims.some((c) => c.identity === identity))![0];
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://api.github.com/gists/a1') {
      return new Response(JSON.stringify({ owner: { login: 'a1' }, files: { f: { content: verificationText(aidOf('a1')) } } }));
    }
    if (url === 'https://api.github.com/gists/b2') {
      return new Response(JSON.stringify({ owner: { login: 'mallory' }, files: { f: { content: verificationText(aidOf('b2')) } } }));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('buildSite', () => {
  test('writes a JSON document and a page for every player', async () => {
    const { players } = await buildSite({ root, out, appUrl: 'https://example.github.io/nostr-rating/', fetchFn: stubFetch() });
    const s = snapshot();
    expect(players).toBe(2);
    for (const [aid, p] of Object.entries(s.players)) {
      const doc = read<PlayerDoc>(`api/v1/players/${aid}.json`);
      expect([doc.rating, doc.wins, doc.losses]).toEqual([p.rating, p.wins, p.losses]);
      expect(doc.snapshot.path).toBe('snapshots/season_1/2026-10-02.json');
      const html = readFileSync(join(out, `p/${aid}.html`), 'utf8');
      expect(html).toContain(`<meta property="og:url" content="https://example.github.io/nostr-rating/p/${aid}.html">`);
    }
    expect(read<{ players: number }>('api/v1/index.json').players).toBe(2);
  });

  test('indexes only verified external accounts', async () => {
    await buildSite({ root, out, appUrl: 'https://example.github.io/nostr-rating/', fetchFn: stubFetch() });
    const byA1 = read<{ players: PlayerDoc[] }>('api/v1/by/github/a1.json');
    expect(byA1.players).toHaveLength(1);
    expect(byA1.players[0]!.accounts).toEqual([{ platform: 'github', identity: 'a1', proof_url: 'https://gist.github.com/a1/a1', verified: true }]);
    expect(existsSync(join(out, 'api/v1/by/github/b2.json'))).toBe(false);
  });

  test('escapes names in the player page', async () => {
    const s = snapshot();
    const aid = Object.keys(s.accounts)[0]!;
    s.accounts[aid]!.name = '<script>alert(1)</script>';
    const text = `${JSON.stringify(s)}`;
    const { writeFileSync } = await import('node:fs');
    const { sha256Hex } = await import('@nostr-rating/core');
    writeFileSync(join(root, 'snapshots/season_1/2026-10-02.json'), text);
    writeFileSync(join(root, 'snapshots/latest.json'), JSON.stringify({ path: 'snapshots/season_1/2026-10-02.json', sha256: sha256Hex(text) }));
    await buildSite({ root, out, appUrl: 'https://example.github.io/nostr-rating/', fetchFn: stubFetch() });
    const html = readFileSync(join(out, `p/${aid}.html`), 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('links another account that verifiably shares an external account and shows its past seasons', async () => {
    const { writeFileSync } = await import('node:fs');
    const { sha256Hex } = await import('@nostr-rating/core');
    const s = snapshot();
    const [a, b] = Object.entries(s.accounts).sort(([, x], [, y]) => (x.claims[0]!.identity < y.claims[0]!.identity ? -1 : 1)).map(([aid]) => aid);
    // b は a と同じ GitHub アカウント（A1、大文字小文字は違う）を、別の Gist で紐づけた。b には過去のシーズンの成績がある
    s.accounts[b!]!.claims = [{ platform: 'github', identity: 'A1', proof: 'b9' }];
    s.season_summaries = { '0': { [b!]: { final_rating: 1700, peak_rating: 1750, matches: 9, wins: 6, losses: 3 } } };
    const text = JSON.stringify(s);
    writeFileSync(join(root, 'snapshots/season_1/2026-10-02.json'), text);
    writeFileSync(join(root, 'snapshots/latest.json'), JSON.stringify({ path: 'snapshots/season_1/2026-10-02.json', sha256: sha256Hex(text) }));
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      const gist = (aid: string) => new Response(JSON.stringify({ owner: { login: 'a1' }, files: { f: { content: verificationText(aid) } } }));
      if (url === 'https://api.github.com/gists/a1') return gist(a!);
      if (url === 'https://api.github.com/gists/b9') return gist(b!);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    await buildSite({ root, out, appUrl: 'https://example.github.io/nostr-rating/', fetchFn });
    expect(read<PlayerDoc>(`api/v1/players/${a}.json`).linked_accounts).toEqual([
      { aid: b, name: '', via: [{ platform: 'github', identity: 'a1' }], past_seasons: { '0': { final_rating: 1700, peak_rating: 1750, matches: 9, wins: 6, losses: 3 } } },
    ]);
    expect(read<{ players: PlayerDoc[] }>('api/v1/by/github/a1.json').players.map((p) => p.aid).sort()).toEqual([a, b].sort());
  });
});
