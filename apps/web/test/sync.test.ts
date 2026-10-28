import {
  buildAccountInfo,
  buildReport,
  MemoryRelay,
  parseGameDefinition,
  serializeSnapshot,
  sha256Hex,
  stateToSnapshot,
  initialState,
} from '@nostr-rating/core';
import { describe, expect, test } from 'vitest';
import rawDef from '../../../configs/smash_sp.json';
import { Account, memoryKeyStore } from '../src/account/account.js';
import { syncRatings } from '../src/services/sync.js';
import { MemoryEventStore } from '../src/storage/memory.js';
import { matchBetween, type Player } from './helpers.js';

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

function snapshotFiles(tamper = false) {
  const text = serializeSnapshot(
    stateToSnapshot(initialState(def, 1, CUT), { game: 'smash_sp', previous: null, previousSha256: null, eventIds: [], configSha256: 'x' }),
  );
  const path = 'snapshots/smash_sp/season_1/2026-10-27.json';
  return {
    [`${BASE}snapshots/smash_sp/latest.json`]: JSON.stringify({ path, sha256: sha256Hex(text) }),
    [`${BASE}${path}`]: tamper ? text.replace('"season": 1', '"season": 2') : text,
  };
}

/** 時計を動かせるアカウント（at に作り、紐づけを出す） */
async function playerAt(relay: MemoryRelay, clock: { t: number }, name: string): Promise<Player> {
  const keyStore = memoryKeyStore();
  const now = () => clock.t;
  const { account, words } = await Account.create(keyStore, relay, now, name);
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
    const text = serializeSnapshot(stateToSnapshot(final, { game: 'smash_sp', previous: null, previousSha256: null, eventIds: [], configSha256: 'x', kind: 'final' }));
    const path = 'snapshots/smash_sp/season_1/final.json';
    const files = { [`${BASE}snapshots/smash_sp/latest.json`]: JSON.stringify({ path, sha256: sha256Hex(text) }), [`${BASE}${path}`]: text };
    const { state } = await syncRatings({ def, relay: new MemoryRelay(() => s2 + 100), store: new MemoryEventStore(), fetchFn: fakeFetch(files), base: BASE, now: () => s2 + 100 });
    expect([state.season, state.cutoff, state.players]).toEqual([2, s2 + 100, {}]);
    expect(state.seasonSummaries).toEqual(final.seasonSummaries);
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
    ).rejects.toThrow(/sha256/);
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
