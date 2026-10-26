import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { buildMatch, buildReport } from '../../src/events/codec.js';
import { isValidEvent } from '../../src/events/kinds.js';
import type { RelayClient } from '../../src/relay/client.js';
import { fetchRatingEvents } from '../../src/relay/fetch.js';
import { MemoryRelay } from '../../src/relay/memory.js';
import { def } from '../helpers/def.js';
import { newUser } from '../helpers/keys.js';
import { p1Wins } from '../helpers/scenario.js';

const T0 = 1_790_800_000;
const now = () => T0 + 10_000;

/** 複数のリレーを束ねた RelayClient（perRelay で個別に問い合わせられる） */
function multi(relays: RelayClient[]): RelayClient {
  return {
    publish: async (e) => void (await Promise.all(relays.map((r) => r.publish(e)))),
    query: async (f) => (await Promise.all(relays.map((r) => r.query(f)))).flat(),
    subscribe: (f, on) => {
      const subs = relays.map((r) => r.subscribe(f, on));
      return () => subs.forEach((s) => s());
    },
    close: () => undefined,
    perRelay: () => relays,
  };
}

const ids = (evs: NostrEvent[]) => evs.map((e) => e.id).sort();

/** 同じ秒の中では攻撃者のイベントを先に返すリレー（攻撃者は id を選んで並び順を操れる） */
function spamFirst(inner: MemoryRelay, spammer: string): RelayClient {
  return {
    publish: (e) => inner.publish(e),
    query: async (filters) => {
      const out: NostrEvent[] = [];
      for (const f of filters) {
        const { limit, ...rest } = f;
        const all = (await inner.query([rest])).sort(
          (a, b) => b.created_at - a.created_at || Number(b.pubkey === spammer) - Number(a.pubkey === spammer),
        );
        out.push(...(limit === undefined ? all : all.slice(0, limit)));
      }
      return out;
    },
    subscribe: (f, on) => inner.subscribe(f, on),
    close: () => undefined,
  };
}

describe('fetchRatingEvents against hostile relays and spam', () => {
  test('a flood of foreign reports in the same second does not hide a real report', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    for (const e of evs) await relay.publish(e);
    const winReport = evs[2]!;
    const spammer = newUser();
    const results = ['win', 'lose', 'cancel'] as const;
    for (let i = 0; i < 15; i++) {
      await relay.publish(
        await spammer.signer.signEvent(buildReport('smash_sp', { matchId: evs[1]!.id, opponent: a.pk, result: results[i % 3]! }, winReport.created_at)),
      );
    }
    const got = await fetchRatingEvents(spamFirst(relay, spammer.pk), def, T0 - 100, T0 + 1000, { pageSize: 10 });
    expect(got.map((e) => e.id)).toContain(winReport.id);
    expect(got.map((e) => e.id)).toContain(evs[3]!.id);
  });

  test('a flood of matches in the same second does not hide a known player match', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    for (const e of evs) await relay.publish(e);
    const spammer = newUser();
    for (let i = 0; i < 15; i++) {
      await relay.publish(
        await spammer.signer.signEvent(
          buildMatch(
            'smash_sp',
            { p1: spammer.pk, p2: b.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: i.toString(16).padStart(64, '0') },
            T0,
          ),
        ),
      );
    }
    const got = await fetchRatingEvents(spamFirst(relay, spammer.pk), def, T0 - 100, T0 + 1000, { pageSize: 10, knownPlayers: [a.pk] });
    expect(got.map((e) => e.id)).toContain(evs[1]!.id);
  });

  test('strict mode fails loudly when one second holds more events than a page', async () => {
    const relay = new MemoryRelay(now);
    const spammer = newUser();
    for (let i = 0; i < 15; i++) {
      await relay.publish(
        await spammer.signer.signEvent(
          buildMatch(
            'smash_sp',
            { p1: spammer.pk, p2: newUser().pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: i.toString(16).padStart(64, '0') },
            T0,
          ),
        ),
      );
    }
    await expect(fetchRatingEvents(relay, def, T0 - 100, T0 + 1000, { pageSize: 10, strict: true })).rejects.toThrow(
      `a relay returned more than 10 events created at ${T0}; refusing to build a snapshot from a truncated result`,
    );
  });

  test('pages through each relay separately so a shallower relay does not hide events', async () => {
    const r1 = new MemoryRelay(now);
    const r2 = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const old = await p1Wins(a, b, T0);
    const recent: NostrEvent[] = [];
    for (let i = 0; i < 6; i++) recent.push(...(await p1Wins(a, b, T0 + 1000 + i * 100)));
    for (const e of old) await r1.publish(e);
    for (const e of recent) await r2.publish(e);
    // r1 には古い対戦だけ、r2 には新しい対戦だけがある。r2 の古い側にも取りこぼしがないこと
    for (const e of recent.slice(0, 4)) await r1.publish(e);
    const got = await fetchRatingEvents(multi([r1, r2]), def, T0 - 100, T0 + 5000, { pageSize: 5 });
    expect(ids(got)).toEqual(ids([...old, ...recent]));
  });

  test('a relay that returns a forged copy with the same id does not hide the real event', async () => {
    const honest = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    for (const e of evs) await honest.publish(e);
    const poisoned: RelayClient = {
      publish: async () => undefined,
      query: async (f) => (await honest.query(f)).map((e) => ({ ...e, content: '{"result":"cancel"}' })),
      subscribe: () => () => undefined,
      close: () => undefined,
    };
    const got = await fetchRatingEvents(multi([poisoned, honest]), def, T0 - 100, T0 + 1000);
    expect(ids(got)).toEqual(ids(evs));
    expect(got.every((e) => isValidEvent(e))).toBe(true);
  });
});

describe('isValidEvent cache', () => {
  test('detects an in-place mutation after the event was verified once', async () => {
    const a = newUser();
    const ev = await a.signer.signEvent({ kind: 1, content: 'x', tags: [], created_at: T0 });
    expect(isValidEvent(ev)).toBe(true);
    (ev as { content: string }).content = 'y';
    expect(isValidEvent(ev)).toBe(false);
  });
});
