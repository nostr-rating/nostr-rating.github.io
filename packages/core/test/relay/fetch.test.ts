import { describe, expect, test } from 'vitest';
import { buildReport } from '../../src/events/codec.js';
import { fetchRatingEvents } from '../../src/relay/fetch.js';
import { MemoryRelay } from '../../src/relay/memory.js';
import { def } from '../helpers/def.js';
import { newUser } from '../helpers/keys.js';
import { identity, p1Wins } from '../helpers/scenario.js';

const T0 = 1_790_800_000;

describe('fetchRatingEvents', () => {
  test('collects matches, the linked applications, reports and identities', async () => {
    const relay = new MemoryRelay(() => T0 + 10_000);
    const a = newUser();
    const b = newUser();
    const evs = [await identity(a, T0 - 10), await identity(b, T0 - 10), ...(await p1Wins(a, b, T0))];
    for (const e of evs) await relay.publish(e);
    const got = await fetchRatingEvents(relay, def, T0 - 100, T0 + 1000);
    expect(got.map((e) => e.id).sort()).toEqual(evs.map((e) => e.id).sort());
  });

  test('pages through relays that cap the number of results', async () => {
    const relay = new MemoryRelay(() => T0 + 10_000);
    const a = newUser();
    const b = newUser();
    const evs = [...(await p1Wins(a, b, T0))];
    // 同じ秒に3件ずつ（内容を変えて ID が重ならないようにする）
    const results = ['win', 'lose', 'cancel'] as const;
    for (let i = 0; i < 25; i++) {
      evs.push(await a.signer.signEvent(buildReport('smash_sp', { matchId: evs[1]!.id, opponent: b.pk, result: results[i % 3]! }, T0 + 100 + Math.floor(i / 3))));
    }
    for (const e of evs) await relay.publish(e);
    const got = await fetchRatingEvents(relay, def, T0 - 100, T0 + 1000, { pageSize: 10 });
    expect(got.map((e) => e.id).sort()).toEqual(evs.map((e) => e.id).sort());
  });
});
