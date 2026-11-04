import type { NostrEvent } from 'nostr-tools/pure';
import { beforeAll, describe, expect, test } from 'vitest';
import { advanceRatings, recomputeRating, type EvaluatedMatch } from '../../src/rating/pipeline.js';
import { initialState } from '../helpers/state.js';
import { def } from '../helpers/def.js';
import { newUser } from '../helpers/keys.js';
import { DAY, identity, p1Wins, played, type User } from '../helpers/scenario.js';

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
const rated = (ms: EvaluatedMatch[]) => ms.filter((m) => m.rating !== null);
/** その選手の側の更新 */
const stepOf = (m: EvaluatedMatch, pk: string) => (m.p1 === pk ? m.rating!.p1 : m.rating!.p2);

describe('evaluated matches (docs/adr/0014)', () => {
  test('every evaluated match is recorded in order, with the result and who did not report', async () => {
    const evs = [
      ...ids,
      ...(await p1Wins(alice, bob, T0)),
      ...(await played(bob, alice, T0 + 600, ['win', 'lose'])),
      ...(await played(carol, alice, T0 + 1200, ['cancel', 'cancel'])),
      ...(await played(alice, carol, T0 + 1800, ['win', null])),
    ];
    const { matches } = advanceRatings(def, s0(), evs, T0 + 1800 + DAY);
    expect(matches.map((m) => [m.result, m.missing, m.rating === null])).toEqual([
      ['p1', [], false],
      ['p1', [], false],
      ['cancel', [], true],
      ['no_report', [carol.pk], true],
    ]);
  });

  test('each rated record recomputes to its own after, and chains to the next match of the same player', async () => {
    const evs = [...ids, ...(await p1Wins(alice, bob, T0)), ...(await played(bob, alice, T0 + 600, ['win', 'lose']))];
    const { state, matches } = advanceRatings(def, s0(), evs, T0 + 600 + DAY);
    const [first, second] = rated(matches);
    for (const m of [first!, second!]) {
      const got = recomputeRating(def, m)!;
      expect([got.p1, got.p2]).toEqual([m.rating!.p1.after, m.rating!.p2.after]);
    }
    // 同じ2人の2戦目は、連戦の重みの2つ目で縮める
    expect([first!.rating!.weight, second!.rating!.weight]).toEqual([def.rematchWeight.weights[0], def.rematchWeight.weights[1]]);
    expect(stepOf(second!, alice.pk).before).toEqual(stepOf(first!, alice.pk).after);
    expect(stepOf(second!, bob.pk).before).toEqual(stepOf(first!, bob.pk).after);
    const { rating, rd, volatility } = state.players[alice.pk]!;
    expect({ rating, rd, volatility }).toEqual(stepOf(second!, alice.pk).after);
  });

  test('the idle periods are recorded so the RD widening can be recomputed too', async () => {
    const later = T0 + 3 * def.rating.inactivityPeriodSec + 5;
    const evs = [...ids, ...(await p1Wins(alice, bob, T0)), ...(await p1Wins(alice, carol, later))];
    const { matches } = advanceRatings(def, s0(), evs, later + DAY);
    const m = rated(matches)[1]!;
    expect([stepOf(m, alice.pk).periods, stepOf(m, carol.pk).periods]).toEqual([3, 0]);
    const got = recomputeRating(def, m)!;
    expect([got.p1, got.p2]).toEqual([m.rating!.p1.after, m.rating!.p2.after]);
  });

  test('a record whose result was rewritten no longer recomputes to its after', async () => {
    const { matches } = advanceRatings(def, s0(), [...ids, ...(await p1Wins(alice, bob, T0))], T0 + DAY);
    const forged: EvaluatedMatch = { ...matches[0]!, result: 'p2' };
    expect(recomputeRating(def, forged)!.p1).not.toEqual(forged.rating!.p1.after);
  });
});
