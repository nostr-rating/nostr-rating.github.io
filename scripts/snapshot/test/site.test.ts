import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildSnapshot,
  serializeToc,
  sha256Hex,
  stateFromParts,
  verificationText,
  type KelPrefixPart,
  type KelIndexPart,
  type MatchesPart,
  type PlayersPart,
  type RatingState,
  type SnapshotToc,
} from '@nostr-rating/core';
import { partStore, type PartStore } from '../src/parts.js';
import { buildSite, claimResultKey, type ClaimResults, type PlayerDoc } from '../src/site.js';

const FIXTURES = resolve(__dirname, 'fixtures');
const REPO = resolve(__dirname, '../../..');
let root: string;
let out: string;
let parts: PartStore;

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
/** aid の先頭1文字ごとの golden の部品（accounts-<文字>.json など）をまとめる */
const shards = <T>(kind: string): T => Object.assign({}, ...readdirSync(FIXTURES).filter((f) => f.startsWith(`${kind}-`)).map((f) => fixture(f))) as T;

/** golden の部品から作った状態 */
const snapshot = (): RatingState =>
  stateFromParts(fixture<SnapshotToc>('toc.json'), { players: fixture('players.json'), seasons: {}, accounts: shards('accounts'), kels: shards('kels') });

/** 状態を、そのゲームの最新のスナップショットとして置く（目次と latest.json はリポジトリに、部品は置き場に） */
function put(game: string, state: RatingState): void {
  const path = `snapshots/${game}/season_1/2026-10-02.json`;
  const { toc, texts } = buildSnapshot(state, { game, previous: null, previousSha256: null, eventIds: [], configSha256: 'x', release: 'r' });
  for (const [sha, text] of texts) parts.put('r', sha, text);
  const text = serializeToc(toc);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  writeFileSync(join(root, `snapshots/${game}/latest.json`), `${JSON.stringify({ path, sha256: sha256Hex(text) }, null, 2)}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nr-site-'));
  out = join(root, 'dist');
  parts = partStore(join(root, '.parts'), null);
  cpSync(join(REPO, 'configs'), join(root, 'configs'), { recursive: true });
  put('smash_sp', snapshot());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = <T>(p: string) => JSON.parse(readFileSync(join(out, p), 'utf8')) as T;
const NOW = 1_790_000_000;
const site = (fetchFn: typeof fetch, previousClaims: ClaimResults = {}, now = NOW) =>
  buildSite({ root, out, appUrl: 'https://example.github.io/nostr-rating/', fetchFn, parts, previousClaims, now });

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
    const { players } = await site(stubFetch());
    const s = snapshot();
    expect(players).toBe(2);
    for (const [aid, p] of Object.entries(s.players)) {
      const doc = read<PlayerDoc>(`api/v1/smash_sp/players/${aid}.json`);
      expect([doc.rating, doc.wins, doc.losses]).toEqual([p.rating, p.wins, p.losses]);
      expect(doc.snapshot.path).toBe('snapshots/smash_sp/season_1/2026-10-02.json');
      const html = readFileSync(join(out, `p/${aid}.html`), 'utf8');
      expect(html).toContain(`<meta property="og:url" content="https://example.github.io/nostr-rating/p/${aid}.html">`);
    }
    expect(read<{ games: { id: string; players: number }[] }>('api/v1/index.json').games).toEqual([expect.objectContaining({ id: 'smash_sp', players: 2 })]);
  });

  test('publishes the snapshot the app reads: the pointer, the table of contents, the players part and every KEL', async () => {
    await site(stubFetch());
    const pointer = readFileSync(join(root, 'snapshots/smash_sp/latest.json'), 'utf8');
    expect(readFileSync(join(out, 'snapshots/smash_sp/latest.json'), 'utf8')).toBe(pointer);
    const { path } = JSON.parse(pointer) as { path: string };
    expect(readFileSync(join(out, path), 'utf8')).toBe(readFileSync(join(root, path), 'utf8'));
    const toc = read<SnapshotToc>(path);
    const part = <T>(sha: string) => {
      const text = readFileSync(join(out, `snapshots/parts/${sha}.json`), 'utf8');
      expect(sha256Hex(text)).toBe(sha);
      return JSON.parse(text) as T;
    };
    const players = part<PlayersPart>(toc.parts.players.sha256);
    const index = part<KelIndexPart>(toc.kel_index.sha256);
    for (const aid of Object.keys(snapshot().kels)) {
      const prefix = part<KelPrefixPart>(index[aid.slice(0, 2)]!.sha256);
      expect([part(prefix[aid]!), players.kels[aid]]).toEqual([snapshot().kels[aid], prefix[aid]]);
    }
    // 対戦ごとの記録も、誰でも1つの対戦を確かめられるように配信する（docs/adr/0014）
    // （この目次はレートの状態だけから作ったので、記録は空）
    expect(part<MatchesPart>(toc.parts.matches!.sha256)).toEqual({ matches: [] });
    // アプリはリレーの一覧も同じ配信元から読む
    expect(readFileSync(join(out, 'configs/relays.json'), 'utf8')).toBe(readFileSync(join(root, 'configs/relays.json'), 'utf8'));
    // 生成だけが使う部品は配信しない
    for (const r of Object.values(toc.parts.accounts)) expect(existsSync(join(out, `snapshots/parts/${r.sha256}.json`))).toBe(false);
  });

  test('indexes only verified external accounts', async () => {
    await site(stubFetch());
    const byA1 = read<{ players: PlayerDoc[] }>('api/v1/smash_sp/by/github/a1.json');
    expect(byA1.players).toHaveLength(1);
    expect(byA1.players[0]!.accounts).toEqual([{ platform: 'github', identity: 'a1', proof_url: 'https://gist.github.com/a1/a1', verified: true }]);
    expect(existsSync(join(out, 'api/v1/smash_sp/by/github/b2.json'))).toBe(false);
  });

  test('records the result of every claim check, so the next publish can reuse it', async () => {
    await site(stubFetch());
    const a1 = Object.entries(snapshot().accounts).find(([, a]) => a.claims.some((c) => c.identity === 'a1'))!;
    const b2 = Object.entries(snapshot().accounts).find(([, a]) => a.claims.some((c) => c.identity === 'b2'))!;
    expect(read<ClaimResults>('api/v1/claims.json')).toEqual({
      [claimResultKey(a1[0], a1[1].claims[0]!)]: { verified: true, at: NOW },
      [claimResultKey(b2[0], b2[1].claims[0]!)]: { verified: false, at: NOW },
    });
  });

  test('reuses a recent result without asking again, and keeps the previous result when a check cannot be made', async () => {
    const [aid, a] = Object.entries(snapshot().accounts).find(([, x]) => x.claims.some((c) => c.identity === 'a1'))!;
    const key = claimResultKey(aid, a.claims[0]!);
    const asked: string[] = [];
    // GitHub の API の上限に当たった
    const limited = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response('rate limited', { status: 403 });
    }) as typeof fetch;
    await site(limited, { [key]: { verified: true, at: NOW - 86400 } });
    expect([asked.includes('https://api.github.com/gists/a1'), read<{ players: PlayerDoc[] }>('api/v1/smash_sp/by/github/a1.json').players.length]).toEqual([false, 1]);
    // 7日より古い結果は確かめ直す。確かめられなければ前の結果を残す
    asked.length = 0;
    await site(limited, { [key]: { verified: true, at: NOW - 8 * 86400 } });
    expect([asked.includes('https://api.github.com/gists/a1'), read<ClaimResults>('api/v1/claims.json')[key]]).toEqual([true, { verified: true, at: NOW - 8 * 86400 }]);
    expect(read<{ players: PlayerDoc[] }>('api/v1/smash_sp/by/github/a1.json').players.length).toBe(1);
  });

  test('escapes names in the player page', async () => {
    const s = snapshot();
    const aid = Object.keys(s.accounts)[0]!;
    s.accounts[aid]!.name = '<script>alert(1)</script>';
    put('smash_sp', s);
    await site(stubFetch());
    const html = readFileSync(join(out, `p/${aid}.html`), 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('links another account that verifiably shares an external account and shows its past seasons', async () => {
    const s = snapshot();
    const [a, b] = Object.entries(s.accounts).sort(([, x], [, y]) => (x.claims[0]!.identity < y.claims[0]!.identity ? -1 : 1)).map(([aid]) => aid);
    // b は a と同じ GitHub アカウント（A1、大文字小文字は違う）を、別の Gist で紐づけた。b には過去のシーズンの成績がある
    s.accounts[b!]!.claims = [{ platform: 'github', identity: 'A1', proof: 'b9' }];
    s.seasonSummaries = { '0': { [b!]: { finalRating: 1700, peakRating: 1750, matches: 9, wins: 6, losses: 3, draws: 0 } } };
    put('smash_sp', s);
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      const gist = (aid: string) => new Response(JSON.stringify({ owner: { login: 'a1' }, files: { f: { content: verificationText(aid) } } }));
      if (url === 'https://api.github.com/gists/a1') return gist(a!);
      if (url === 'https://api.github.com/gists/b9') return gist(b!);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    await site(fetchFn);
    expect(read<PlayerDoc>(`api/v1/smash_sp/players/${a}.json`).linked_accounts).toEqual([
      { aid: b, name: '', via: [{ platform: 'github', identity: 'a1' }], past_seasons: { '0': { final_rating: 1700, peak_rating: 1750, matches: 9, wins: 6, losses: 3, draws: 0 } } },
    ]);
    expect(read<{ players: PlayerDoc[] }>('api/v1/smash_sp/by/github/a1.json').players.map((p) => p.aid).sort()).toEqual([a, b].sort());
  });

  test('writes each game under its own path and puts every game on one player page', async () => {
    const c = snapshot();
    // チェスには a1 の Gist で紐づけた a だけが参加し、2回引き分けた
    const a = Object.entries(c.accounts).find(([, x]) => x.claims.some((cl) => cl.identity === 'a1'))![0];
    const b = Object.keys(c.players).find((aid) => aid !== a)!;
    // 紐づけのあるアカウントは、対戦していないゲームのスナップショットにも 0 戦で入る
    c.players[b] = { ...c.players[b]!, rating: 1500, peakRating: 1500, matches: 0, wins: 0, losses: 0, draws: 0, manners: { noReport: 0, cancel: 0, mismatch: 0 } };
    c.players[a]!.draws = 2;
    put('chess', c);

    const { players, games } = await site(stubFetch());
    expect(games).toEqual(['smash_sp', 'chess']);
    expect(players).toBe(2);
    expect(read<{ games: { id: string; name: string; names: unknown; players: number }[] }>('api/v1/index.json').games.map((g) => [g.id, g.name, g.names, g.players])).toEqual([
      ['smash_sp', '大乱闘スマッシュブラザーズ SPECIAL', { ja: '大乱闘スマッシュブラザーズ SPECIAL', en: 'Super Smash Bros. Ultimate' }, 2],
      ['chess', 'チェス', { ja: 'チェス', en: 'Chess' }, 1],
    ]);
    const doc = read<PlayerDoc>(`api/v1/chess/players/${a}.json`);
    expect([doc.game, doc.draws, doc.snapshot.path]).toEqual([{ id: 'chess', name: 'チェス', names: { ja: 'チェス', en: 'Chess' } }, 2, 'snapshots/chess/season_1/2026-10-02.json']);
    expect(existsSync(join(out, `api/v1/chess/players/${b}.json`))).toBe(false);
    // 紐づけは全ゲームで共通なので、チェスの索引にも出る
    expect(read<{ players: PlayerDoc[] }>('api/v1/chess/by/github/a1.json').players.map((p) => p.aid)).toEqual([a]);
    const html = readFileSync(join(out, `p/${a}.html`), 'utf8');
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(['大乱闘スマッシュブラザーズ SPECIAL', 'チェス', '紐づけたアカウント']);
    expect(html).toContain('2分');
  });
});
