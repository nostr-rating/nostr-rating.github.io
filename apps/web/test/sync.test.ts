import {
  buildAccountInfo,
  buildReport,
  MemoryRelay,
  newRecoveryWords,
  parseGameDefinition,
  initialState,
  currentSeason,
  kelParts,
  KIND,
} from '@nostr-rating/core';
import { describe, expect, test } from 'vitest';
import rawDef from '../../../configs/smash_sp.json';
import { Account, memoryKeyStore } from '../src/account/account.js';
import { syncRatings } from '../src/services/sync.js';
import { MemoryEventStore } from '../src/storage/memory.js';
import { matchBetween, type Player } from './helpers.js';
import { snapshotRoutes } from './snapshot.js';

const def = parseGameDefinition(rawDef);
const CUT = 1_793_026_800;
const BASE = 'https://example.test/';

function fakeFetch(files: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = files[url];
    return body === undefined ? new Response('nf', { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
}

const PATH = 'snapshots/smash_sp/season_1/2026-10-27.json';

function snapshotFiles(tamper = false) {
  const files = snapshotRoutes(BASE, 'smash_sp', initialState(def, 1, CUT), PATH);
  if (tamper) files[`${BASE}${PATH}`] = files[`${BASE}${PATH}`]!.replace('"season": 1', '"season": 2');
  return files;
}

/** 時計を動かせるアカウント（at に作り、紐づけを出す） */
async function playerAt(relay: MemoryRelay, clock: { t: number }, name: string): Promise<Player> {
  const keyStore = memoryKeyStore();
  const now = () => clock.t;
  const words = newRecoveryWords();
  const account = await Account.create(keyStore, relay, now, name, { cards: [words], threshold: 1 });
  const session = await account.session();
  await relay.publish(await session.signer.signEvent(buildAccountInfo({ pubkey: account.aid, name, claims: [{ platform: 'github', identity: name, proof: 'abc' }] }, clock.t)));
  return { account, keyStore, words, aid: account.aid, signer: session.signer, session };
}

/** その時刻の使い捨ての鍵に替える */
async function at(p: Player, clock: { t: number }, t: number): Promise<Player> {
  clock.t = t;
  const session = await p.account.session();
  return { ...p, signer: session.signer, session };
}

async function playedMatch(relay: MemoryRelay, a: Player, b: Player, t: number) {
  const m = await matchBetween(relay, a, b, { at: t });
  await relay.publish(await a.signer.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: m.sessions[1]!, result: 'win' }, t + 100)));
  await relay.publish(await b.signer.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: m.sessions[0]!, result: 'lose' }, t + 101)));
  return { pa: a.aid, pb: b.aid };
}

describe('syncRatings across seasons', () => {
  test('a snapshot from the previous season starts the current season from zero and keeps the summaries', async () => {
    const s2 = 1_798_729_200; // 2027-01-01 JST
    const base = initialState(def, 1, s2);
    const final = { ...base, seasonSummaries: { '1': { ['a'.repeat(64)]: { finalRating: 1600, peakRating: 1650, matches: 3, wins: 2, losses: 1, draws: 0 } } } };
    const files = snapshotRoutes(BASE, 'smash_sp', final, 'snapshots/smash_sp/season_1/final.json', 'final');
    const { state } = await syncRatings({ def, relay: new MemoryRelay(() => s2 + 100), store: new MemoryEventStore(), fetchFn: fakeFetch(files), base: BASE, now: () => s2 + 100 });
    expect([state.season, state.cutoff, state.players]).toEqual([2, s2 + 100, {}]);
    expect(state.seasonSummaries).toEqual(final.seasonSummaries);
  });
});

describe('syncRatings at the start of a season before the final snapshot', () => {
  test('keeps KEL events made between the last snapshot of the previous season and the start of the new one', async () => {
    const s2 = 1_798_729_200; // 2027-01-01 JST
    const rollingCut = s2 - 3 * 86400;
    const now = s2 + 5000;
    const relay = new MemoryRelay(() => now);
    const clock = { t: rollingCut - 2 * 86400 };
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    const kels = { [a.aid]: a.account.kel, [b.aid]: b.account.kel };
    // 前のシーズンの rolling のスナップショットのあと、新しいシーズンが始まる前に a が端末を足す
    clock.t = rollingCut + 3600;
    await a.account.addDevice(await Account.prepareDevice(memoryKeyStore(), 'pc'));
    await playedMatch(relay, await at(a, clock, s2 + 100), await at(b, clock, s2 + 100), s2 + 100);
    const files = snapshotRoutes(BASE, 'smash_sp', { ...initialState(def, 1, rollingCut), kels }, 'snapshots/smash_sp/season_1/2026-12-28.json');
    const { shown } = await syncRatings({ def, relay, store: new MemoryEventStore(), fetchFn: fakeFetch(files), base: BASE, now: () => now });
    expect([shown.season, shown.kels[a.aid]!.length]).toEqual([2, 2]);
  });
});

describe('syncRatings', () => {
  test('rejects a snapshot whose sha256 does not match latest.json', async () => {
    await expect(
      syncRatings({
        def,
        relay: new MemoryRelay(() => CUT + 10),
        store: new MemoryEventStore(),
        fetchFn: fakeFetch(snapshotFiles(true)),
        base: BASE,
        now: () => CUT + 10,
      }),
    ).rejects.toThrow(new Error(`sha256 mismatch: ${PATH}`));
  });

  test('reuses the snapshot while latest.json points to the same one', async () => {
    const files = snapshotFiles();
    const asked: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return fakeFetch(files)(input);
    }) as typeof fetch;
    const snapshotCache = new Map();
    const deps = { def, relay: new MemoryRelay(() => CUT + 100), store: new MemoryEventStore(), fetchFn, base: BASE, now: () => CUT + 100, snapshotCache };
    await syncRatings(deps);
    await syncRatings(deps);
    expect(asked.filter((u) => u.endsWith('2026-10-27.json'))).toHaveLength(1);
    expect(asked.filter((u) => u.includes('/parts/'))).toHaveLength(1);
    expect(asked.filter((u) => u.endsWith('latest.json'))).toHaveLength(2);
  });

  test('rejects a part whose sha256 does not match the table of contents', async () => {
    const files = snapshotFiles();
    const players = Object.keys(files).find((u) => u.includes('/parts/'))!;
    files[players] = files[players]!.replace('"players":{}', '"players":{ }');
    await expect(
      syncRatings({ def, relay: new MemoryRelay(() => CUT + 10), store: new MemoryEventStore(), fetchFn: fakeFetch(files), base: BASE, now: () => CUT + 10 }),
    ).rejects.toThrow(new Error(`sha256 mismatch: part ${players.split('/').pop()!.replace('.json', '')}`));
  });

  test('without a snapshot yet, starts the current season from its beginning', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    const clock = { t: CUT };
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    const { pa } = await playedMatch(relay, await at(a, clock, CUT + 100), await at(b, clock, CUT + 100), CUT + 100);
    const { state, shown, snapshotCutoff } = await syncRatings({ def, relay, store: new MemoryEventStore(), fetchFn: fakeFetch({}), base: BASE, now: () => now });
    expect([state.season, snapshotCutoff, shown.players[pa]!.wins]).toEqual([currentSeason(def, now)!.id, null, 1]);
  });

  test('reads the recorded KEL of only the accounts in new events, from the players part or the index', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    // idle は、取得する幅よりずっと前に作られて、それ以後何もしていない
    const clock = { t: CUT - 90 * 86400 };
    const idle = await playerAt(relay, clock, 'idle');
    clock.t = CUT - 86400;
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    const { pa } = await playedMatch(relay, await at(a, clock, CUT + 100), await at(b, clock, CUT + 100), CUT + 100);
    // a はそのシーズンの選手、b と idle は KEL だけが記録されている
    const kels = { [a.aid]: a.account.kel, [b.aid]: b.account.kel, [idle.aid]: idle.account.kel };
    const player = { rating: 1500, rd: 350, volatility: 0.06, peakRating: 1500, matches: 0, wins: 0, losses: 0, draws: 0, manners: { noReport: 0, cancel: 0, mismatch: 0 }, lastMatchAt: null, hasIdentity: true };
    const files = snapshotRoutes(BASE, 'smash_sp', { ...initialState(def, 1, CUT), players: { [a.aid]: player }, kels }, PATH);
    const asked: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return fakeFetch(files)(input);
    }) as typeof fetch;
    const { shown } = await syncRatings({ def, relay, store: new MemoryEventStore(), fetchFn, base: BASE, now: () => now });
    expect(shown.players[pa]!.wins).toBe(1);
    const sha = kelParts(kels).kelSha;
    const parts = new Set(asked.filter((u) => u.includes('/parts/')).map((u) => u.split('/').pop()!.replace('.json', '')));
    expect([parts.has(sha.get(a.aid)!), parts.has(sha.get(b.aid)!), parts.has(sha.get(idle.aid)!)]).toEqual([true, true, false]);
  });

  test('does not read the KEL of an account that appears only in old cached events', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    const clock = { t: CUT - 90 * 86400 };
    // idle の KEL と公開情報は、前に同期したときの手元の控えにだけある
    const old = new MemoryRelay(() => clock.t);
    const idle = await playerAt(old, clock, 'idle');
    const store = new MemoryEventStore();
    await store.put(await old.query([{ kinds: [KIND.kel, KIND.account] }]));
    clock.t = CUT - 86400;
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    const { pa } = await playedMatch(relay, await at(a, clock, CUT + 100), await at(b, clock, CUT + 100), CUT + 100);
    const kels = { [a.aid]: a.account.kel, [b.aid]: b.account.kel, [idle.aid]: idle.account.kel };
    const files = snapshotRoutes(BASE, 'smash_sp', { ...initialState(def, 1, CUT), kels }, PATH);
    const asked: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return fakeFetch(files)(input);
    }) as typeof fetch;
    const { shown } = await syncRatings({ def, relay, store, fetchFn, base: BASE, now: () => now });
    expect(shown.players[pa]!.wins).toBe(1);
    const sha = kelParts(kels).kelSha;
    const parts = new Set(asked.filter((u) => u.includes('/parts/')).map((u) => u.split('/').pop()!.replace('.json', '')));
    expect([parts.has(sha.get(a.aid)!), parts.has(sha.get(idle.aid)!)]).toEqual([true, false]);
  });

  test('fails the sync when a recorded KEL cannot be read, instead of treating it as a relay failure', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    const clock = { t: CUT - 86400 };
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    await playedMatch(relay, await at(a, clock, CUT + 100), await at(b, clock, CUT + 100), CUT + 100);
    const kels = { [a.aid]: a.account.kel, [b.aid]: b.account.kel };
    const files = snapshotRoutes(BASE, 'smash_sp', { ...initialState(def, 1, CUT), kels }, PATH);
    const index = `${BASE}snapshots/parts/${JSON.parse(files[`${BASE}${PATH}`]!).kel_index.sha256}.json`;
    const fetchFn = (async (input: string | URL | Request) => (String(input) === index ? new Response('busy', { status: 503 }) : fakeFetch(files)(input))) as typeof fetch;
    await expect(syncRatings({ def, relay, store: new MemoryEventStore(), fetchFn, base: BASE, now: () => now })).rejects.toThrow(new Error(`${index}: HTTP 503`));
  });

  test('shows confirmed matches before their deadline and caches the events', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    const clock = { t: CUT };
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    const { pa, pb } = await playedMatch(relay, await at(a, clock, CUT + 100), await at(b, clock, CUT + 100), CUT + 100);

    const store = new MemoryEventStore();
    const { state, shown, snapshotCutoff } = await syncRatings({ def, relay, store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(snapshotCutoff).toBe(CUT);
    expect(state.players[pa]?.wins ?? 0).toBe(0);
    expect(shown.players[pa]!.wins).toBe(1);
    expect(shown.players[pb]!.losses).toBe(1);

    // リレーが消えても、キャッシュから同じ結果を出せる
    const again = await syncRatings({ def, relay: new MemoryRelay(() => now), store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(again.shown).toEqual(shown);
  });

  test('accounts and identity claims made long before the report window still count', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    const clock = { t: CUT - 30 * 86400 };
    const [a, b] = [await playerAt(relay, clock, 'a'), await playerAt(relay, clock, 'b')];
    const { pa } = await playedMatch(relay, await at(a, clock, CUT + 100), await at(b, clock, CUT + 100), CUT + 100);
    const store = new MemoryEventStore();
    const { shown } = await syncRatings({ def, relay, store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(shown.players[pa]!.wins).toBe(1);
    // シーズン開始より前の KEL と紐づけも、パージで消えずにキャッシュから効く
    const again = await syncRatings({ def, relay: new MemoryRelay(() => now), store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(again.shown.players[pa]!.wins).toBe(1);
  });
});
