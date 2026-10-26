import {
  buildApplication,
  buildIdentities,
  buildMatch,
  buildReport,
  LocalSigner,
  MemoryRelay,
  parseGameDefinition,
  serializeSnapshot,
  sha256Hex,
  stateToSnapshot,
  initialState,
} from '@nostr-rating/core';
import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import rawDef from '../../../configs/smash_sp.json';
import { syncRatings } from '../src/services/sync.js';
import { MemoryEventStore } from '../src/storage/memory.js';

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
  const path = 'snapshots/season_1/2026-10-27.json';
  return {
    [`${BASE}snapshots/latest.json`]: JSON.stringify({ path, sha256: sha256Hex(text) }),
    [`${BASE}${path}`]: tamper ? text.replace('"season": 1', '"season": 2') : text,
  };
}

async function playedMatch(relay: MemoryRelay, a: LocalSigner, b: LocalSigner, at: number) {
  const [pa, pb] = [await a.getPublicKey(), await b.getPublicKey()];
  const app = await b.signEvent(
    buildApplication('smash_sp', { recruiter: pa, firstFighter: 'fox', settingsId: '2'.repeat(64), rangeChoice: null, rematchHours: 0, waitingSince: at - 10 }, at - 1),
  );
  const m = await a.signEvent(
    buildMatch('smash_sp', { p1: pa, p2: pb, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: app.id }, at),
  );
  await relay.publish(app);
  await relay.publish(m);
  await relay.publish(await a.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: pb, result: 'win' }, at + 100)));
  await relay.publish(await b.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: pa, result: 'lose' }, at + 101)));
  return { pa, pb };
}

describe('syncRatings across seasons', () => {
  test('a snapshot from the previous season starts the current season from zero and keeps the summaries', async () => {
    const s2 = 1_798_729_200; // 2027-01-01 JST
    const base = initialState(def, 1, s2);
    const final = { ...base, seasonSummaries: { '1': { ['a'.repeat(64)]: { finalRating: 1600, peakRating: 1650, matches: 3, wins: 2, losses: 1 } } } };
    const text = serializeSnapshot(stateToSnapshot(final, { game: 'smash_sp', previous: null, previousSha256: null, eventIds: [], configSha256: 'x', kind: 'final' }));
    const path = 'snapshots/season_1/final.json';
    const files = { [`${BASE}snapshots/latest.json`]: JSON.stringify({ path, sha256: sha256Hex(text) }), [`${BASE}${path}`]: text };
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
    const a = new LocalSigner(generateSecretKey());
    const b = new LocalSigner(generateSecretKey());
    for (const s of [a, b]) await relay.publish(await s.signEvent(buildIdentities([{ platform: 'github', identity: 'x', proof: 'abc' }], CUT)));
    const { pa, pb } = await playedMatch(relay, a, b, CUT + 100);

    const store = new MemoryEventStore();
    const { state, shown, snapshotCutoff } = await syncRatings({ def, relay, store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(snapshotCutoff).toBe(CUT);
    expect(state.players[pa]?.wins ?? 0).toBe(0);
    expect(shown.players[pa]!.wins).toBe(1);
    expect(shown.players[pb]!.losses).toBe(1);
    expect((await store.query({})).length).toBe(6);

    // リレーが消えても、キャッシュから同じ結果を出せる
    const again = await syncRatings({ def, relay: new MemoryRelay(() => now), store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(again.shown).toEqual(shown);
  });

  test('identity claims older than the report window still count', async () => {
    const now = CUT + 5000;
    const relay = new MemoryRelay(() => now);
    const a = new LocalSigner(generateSecretKey());
    const b = new LocalSigner(generateSecretKey());
    const pa = await a.getPublicKey();
    for (const s of [a, b]) await relay.publish(await s.signEvent(buildIdentities([{ platform: 'github', identity: 'x', proof: 'abc' }], CUT - 30 * 86400)));
    await playedMatch(relay, a, b, CUT + 100);
    const store = new MemoryEventStore();
    const { shown } = await syncRatings({ def, relay, store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(shown.players[pa]!.wins).toBe(1);
    // シーズン開始より前の紐づけも、パージで消えずにキャッシュから効く
    const again = await syncRatings({ def, relay: new MemoryRelay(() => now), store, fetchFn: fakeFetch(snapshotFiles()), base: BASE, now: () => now });
    expect(again.shown.players[pa]!.wins).toBe(1);
  });
});
