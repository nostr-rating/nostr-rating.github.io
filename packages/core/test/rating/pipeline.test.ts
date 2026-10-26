import type { NostrEvent } from 'nostr-tools/pure';
import { beforeAll, describe, expect, test } from 'vitest';
import { buildMatch, buildReport } from '../../src/events/codec.js';
import { seasonById } from '../../src/game/definition.js';
import { advanceRatings, initialState, provisionalRatings, toLocalView } from '../../src/rating/pipeline.js';
import { def } from '../helpers/def.js';
import { newUser } from '../helpers/keys.js';
import { application, DAY, identity, matchFor, p1Wins, played, type User } from '../helpers/scenario.js';

const T0 = 1_790_800_000;
let alice: User;
let bob: User;
let carol: User;
let ids: NostrEvent[];

beforeAll(async () => {
  alice = newUser();
  bob = newUser();
  carol = newUser();
  ids = [await identity(alice, T0 - 10), await identity(bob, T0 - 10), await identity(carol, T0 - 10)];
});

const s0 = () => initialState(def, 1, T0 - 100);
const after = (at: number) => at + DAY;

function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('advanceRatings', () => {
  test('confirmed match updates both players once its deadline has passed', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0))];
    const { state, usedEventIds } = advanceRatings(def, s0(), evs, after(T0));
    expect(state.players[alice.pk]).toEqual({
      rating: 1662.310894,
      rd: 290.318964,
      volatility: 0.06,
      peakRating: 1662.310894,
      matches: 1,
      wins: 1,
      losses: 0,
      manners: { noReport: 0, cancel: 0, mismatch: 0 },
      lastMatchAt: T0,
      hasIdentity: true,
    });
    expect(state.players[bob.pk]).toEqual({
      rating: 1337.689106,
      rd: 290.318964,
      volatility: 0.06,
      peakRating: 1500,
      matches: 1,
      wins: 0,
      losses: 1,
      manners: { noReport: 0, cancel: 0, mismatch: 0 },
      lastMatchAt: T0,
      hasIdentity: true,
    });
    expect(state.cutoff).toBe(after(T0));
    expect(usedEventIds).toEqual(evs.map((e) => e.id).sort());
  });

  test('match before its deadline is not processed yet', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0))];
    const { state } = advanceRatings(def, s0(), evs, after(T0) - 1);
    expect(state.players[alice.pk]!.matches).toBe(0);
  });

  test('dedupes events delivered by multiple relays', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0))];
    const once = advanceRatings(def, s0(), evs, after(T0));
    const twice = advanceRatings(def, s0(), [...evs, ...evs.map((e) => ({ ...e }))], after(T0));
    expect(twice).toEqual(once);
  });

  test('an invalid copy with the same id does not hide the valid event', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0))];
    const forged = evs.map((e) => ({ ...e, sig: '0'.repeat(128) }));
    expect(advanceRatings(def, s0(), [...forged, ...evs], after(T0))).toEqual(advanceRatings(def, s0(), evs, after(T0)));
  });

  test('result is independent of input order, including matches created in the same second', async () => {
    const evs = [
      ...ids,
      await identity(alice, T0 + 5, 'b0'),
      ...(await p1Wins(alice, bob, T0)),
      ...(await p1Wins(carol, newUser(), T0)),
      ...(await p1Wins(bob, carol, T0 + 100)),
      ...(await p1Wins(carol, alice, T0 + 100)),
    ];
    const base = advanceRatings(def, s0(), evs, after(T0 + 100));
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(advanceRatings(def, s0(), shuffled(evs, seed), after(T0 + 100))).toEqual(base);
    }
  });

  test('matches whose deadline is at or before prev.cutoff are skipped', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0))];
    const { state } = advanceRatings(def, initialState(def, 1, after(T0)), evs, after(T0) + 1000);
    expect(state.players[alice.pk]?.matches ?? 0).toBe(0);
  });

  test('a report that reaches the relay late but before the deadline is not lost', async () => {
    const [app, match, winReport, loseReport] = [...(await p1Wins(alice, bob, T0))] as NostrEvent[];
    const early = advanceRatings(def, s0(), [...ids, app!, match!, winReport!], T0 + 1000).state;
    const chained = advanceRatings(def, early, [...ids, app!, match!, winReport!, loseReport!], after(T0)).state;
    const oneShot = advanceRatings(def, s0(), [...ids, app!, match!, winReport!, loseReport!], after(T0)).state;
    expect(chained).toEqual(oneShot);
    expect(chained.players[alice.pk]!.wins).toBe(1);
  });

  test('match without an application from p2 is ignored entirely', async () => {
    const forged = await alice.signer.signEvent(
      buildMatch(
        'smash_sp',
        { p1: alice.pk, p2: bob.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: 'a'.repeat(64) },
        T0,
      ),
    );
    const cancel = await alice.signer.signEvent(buildReport('smash_sp', { matchId: forged.id, opponent: bob.pk, result: 'cancel' }, T0 + 5));
    const { state } = advanceRatings(def, s0(), [...ids, forged, cancel], after(T0));
    expect(state.players[bob.pk]!.manners).toEqual({ noReport: 0, cancel: 0, mismatch: 0 });
  });

  test('application from someone else or too old does not link', async () => {
    const app = await application(alice, carol, T0 - 1);
    const wrongP2 = await alice.signer.signEvent(
      buildMatch(
        'smash_sp',
        { p1: alice.pk, p2: bob.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: app.id },
        T0,
      ),
    );
    const late = await matchFor(alice, carol, app, T0 + def.matching.applicationTimeoutSec + 5);
    const reports = [
      await alice.signer.signEvent(buildReport('smash_sp', { matchId: late.id, opponent: carol.pk, result: 'win' }, T0 + 100)),
      await carol.signer.signEvent(buildReport('smash_sp', { matchId: late.id, opponent: alice.pk, result: 'lose' }, T0 + 101)),
    ];
    const { state } = advanceRatings(def, s0(), [...ids, app, wrongP2, late, ...reports], after(T0 + 200));
    expect(state.players[alice.pk]!.matches).toBe(0);
    expect(state.players[bob.pk]!.manners.noReport).toBe(0);
  });

  test('only one match per application counts', async () => {
    const app = await application(alice, bob, T0 - 1);
    const m1 = await matchFor(alice, bob, app, T0);
    const m2 = await matchFor(alice, bob, app, T0 + 1);
    const rep = async (m: NostrEvent) => [
      await alice.signer.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: bob.pk, result: 'win' }, T0 + 50)),
      await bob.signer.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: alice.pk, result: 'lose' }, T0 + 51)),
    ];
    const { state } = advanceRatings(def, s0(), [...ids, app, m1, m2, ...(await rep(m1)), ...(await rep(m2))], after(T0 + 10));
    expect(state.players[alice.pk]!.matches).toBe(1);
  });

  test('match created before the season start is not counted', async () => {
    const start = seasonById(def, 1).startsAt;
    const evs = [...ids, ...(await p1Wins(alice, bob, start - 10))];
    const { state } = advanceRatings(def, initialState(def, 1, start - 10 - DAY), evs, after(start));
    expect(state.players[alice.pk]!.matches).toBe(0);
  });

  test('match whose deadline would fall after the season end is not counted', async () => {
    const end = seasonById(def, 1).endsAt;
    const inside = await p1Wins(alice, bob, end - DAY - 10);
    const straddling = await p1Wins(alice, carol, end - DAY + 10);
    const { state } = advanceRatings(def, s0(), [...ids, ...inside, ...straddling], end + 2 * DAY);
    expect(state.players[alice.pk]!.matches).toBe(1);
    expect(state.players[carol.pk]?.matches ?? 0).toBe(0);
  });

  test('player without identity claim is not rated', async () => {
    const dave = newUser();
    const { state } = advanceRatings(def, s0(), [...ids, ...(await p1Wins(alice, dave, T0))], after(T0));
    expect(state.players[alice.pk]!.matches).toBe(0);
  });

  test('identity published after the cutoff still counts and the used version is deterministic', async () => {
    const dave = newUser();
    const v1 = await identity(dave, after(T0) + 50, 'c1');
    const v2 = await identity(dave, after(T0) + 60, 'c2');
    const evs = [...ids, ...(await p1Wins(alice, dave, T0))];
    const a = advanceRatings(def, s0(), [...evs, v2, v1], after(T0));
    const b = advanceRatings(def, s0(), [v1, v2, ...evs], after(T0));
    expect(a).toEqual(b);
    expect(a.state.players[dave.pk]!.matches).toBe(1);
    expect(a.usedEventIds).toContain(v1.id);
    expect(a.usedEventIds).not.toContain(v2.id);
  });

  test('identity claim with no valid claims does not count', async () => {
    const dave = newUser();
    const empty = await dave.signer.signEvent({ kind: 10011, created_at: T0 - 5, tags: [], content: '' });
    const { state } = advanceRatings(def, s0(), [...ids, empty, ...(await p1Wins(alice, dave, T0))], after(T0));
    expect(state.players[dave.pk]?.hasIdentity ?? false).toBe(false);
  });

  test('second match within 24h has half weight, third quarter', async () => {
    const first = await p1Wins(alice, bob, T0);
    const base = advanceRatings(def, s0(), [...ids, ...first], after(T0)).state;
    const m2 = await p1Wins(alice, bob, T0 + 20_000);
    const after2 = advanceRatings(def, base, m2, after(T0 + 20_000)).state;
    const free2 = advanceRatings(def, { ...base, recentPairs: [] }, m2, after(T0 + 20_000)).state;
    const gain = (s: typeof base) => s.players[alice.pk]!.rating - base.players[alice.pk]!.rating;
    expect(gain(after2)).toBeCloseTo(gain(free2) / 2, 4);

    const m3 = await p1Wins(alice, bob, T0 + 40_000);
    const after3 = advanceRatings(def, after2, m3, after(T0 + 40_000)).state;
    const free3 = advanceRatings(def, { ...after2, recentPairs: [] }, m3, after(T0 + 40_000)).state;
    const gain3 = (s: typeof base) => s.players[alice.pk]!.rating - after2.players[alice.pk]!.rating;
    expect(gain3(after3)).toBeCloseTo(gain3(free3) / 4, 4);
  });

  test('pair outside the weight window counts as fresh', async () => {
    const base = advanceRatings(def, s0(), [...ids, ...(await p1Wins(alice, bob, T0))], after(T0)).state;
    const later = await p1Wins(alice, bob, T0 + DAY + 100);
    const a = advanceRatings(def, base, later, after(T0 + DAY + 100)).state;
    const b = advanceRatings(def, { ...base, recentPairs: [] }, later, after(T0 + DAY + 100)).state;
    expect(a.players).toEqual(b.players);
  });

  test('RD inflates with idle days', async () => {
    const base = advanceRatings(def, s0(), [...ids, ...(await p1Wins(alice, bob, T0))], after(T0)).state;
    const soon = advanceRatings(def, base, await p1Wins(alice, carol, T0 + DAY * 2), after(T0 + DAY * 2)).state;
    const late = advanceRatings(def, base, await p1Wins(alice, carol, T0 + DAY * 30), after(T0 + DAY * 30)).state;
    expect(late.players[alice.pk]!.rating - base.players[alice.pk]!.rating).toBeGreaterThan(
      soon.players[alice.pk]!.rating - base.players[alice.pk]!.rating,
    );
  });

  test('manners counts accumulate for mismatch/no_report/cancel', async () => {
    const evs = [
      ...ids,
      ...(await played(alice, bob, T0, ['win', 'win'])),
      ...(await played(alice, bob, T0 + 100, ['win', null])),
      ...(await played(alice, carol, T0 + 200, ['cancel', 'cancel'])),
      ...(await played(bob, carol, T0 + 300, [null, null])),
    ];
    const { state } = advanceRatings(def, s0(), evs, after(T0 + 300));
    expect(state.players[alice.pk]!.manners).toEqual({ noReport: 0, cancel: 1, mismatch: 1 });
    expect(state.players[bob.pk]!.manners).toEqual({ noReport: 1, cancel: 0, mismatch: 1 });
    expect(state.players[carol.pk]!.manners).toEqual({ noReport: 0, cancel: 1, mismatch: 0 });
    expect(state.players[alice.pk]!.matches).toBe(0);
  });

  test('advancing in two steps equals one step', async () => {
    const all = [
      ...ids,
      ...(await p1Wins(alice, bob, T0)),
      ...(await played(bob, carol, T0 + 500, ['win', null])),
      ...(await p1Wins(carol, alice, T0 + 3000)),
      ...(await p1Wins(alice, bob, T0 + 5000)),
    ];
    const t2 = after(T0 + 5000);
    const one = advanceRatings(def, s0(), all, t2).state;
    for (const t1 of [T0 + 1000, after(T0), after(T0 + 600), after(T0 + 3000)]) {
      const two = advanceRatings(def, advanceRatings(def, s0(), all, t1).state, all, t2).state;
      expect(two).toEqual(one);
    }
  });
});

describe('provisionalRatings', () => {
  test('shows confirmed matches before their deadline without counting pending ones', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0)), ...(await played(alice, carol, T0 + 10, ['win', null]))];
    const final = advanceRatings(def, s0(), evs, T0 + 1000).state;
    const shown = provisionalRatings(def, final, evs, T0 + 1000);
    expect(shown.players[alice.pk]!.wins).toBe(1);
    expect(shown.players[carol.pk]?.manners.noReport ?? 0).toBe(0);
    // 締め切り後の確定計算と一致する
    expect(shown.players[bob.pk]).toEqual(advanceRatings(def, s0(), evs, after(T0)).state.players[bob.pk]);
  });
});

describe('toLocalView', () => {
  test('reads ratings, manners and recent pairs', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0)), ...(await played(alice, carol, T0 + 10, ['win', 'win']))];
    const { state } = advanceRatings(def, s0(), evs, after(T0 + 10));
    const v = toLocalView(def, state);
    expect(v.ratingOf(alice.pk)).toBe(state.players[alice.pk]!.rating);
    expect(v.ratingOf(newUser().pk)).toBe(1500);
    expect(v.mannersTotalOf(carol.pk)).toBe(1);
    expect(v.lastMatchBetween(bob.pk, alice.pk)).toBe(T0);
    expect(v.lastMatchBetween(alice.pk, carol.pk)).toBeNull();
    expect(v.hasIdentity(alice.pk)).toBe(true);
    expect(v.hasIdentity(newUser().pk)).toBe(false);
  });
});
