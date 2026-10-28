import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { buildMatch, buildReport } from '../../src/events/codec.js';
import { isValidEvent } from '../../src/events/kinds.js';
import type { RelayClient } from '../../src/relay/client.js';
import { fetchRatingEvents } from '../../src/relay/fetch.js';
import { MemoryRelay } from '../../src/relay/memory.js';
import { def } from '../helpers/def.js';
import { newUser, registeredKels } from '../helpers/keys.js';
import { identity, p1Wins } from '../helpers/scenario.js';

const T0 = 1_790_800_000;
const now = () => T0 + 10_000;
const ids = (evs: NostrEvent[]) => evs.map((e) => e.id).sort();
const has = (evs: NostrEvent[], ev: NostrEvent) => evs.some((e) => e.id === ev.id);

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

/** 同じ秒の中では攻撃者のイベントを先に返すリレー（攻撃者は id を選んで並び順を操れる） */
function spamFirst(inner: MemoryRelay, spammerKeys: Set<string>): RelayClient {
  return {
    publish: (e) => inner.publish(e),
    query: async (filters) => {
      const out: NostrEvent[] = [];
      for (const f of filters) {
        const { limit, ...rest } = f;
        const all = (await inner.query([rest])).sort(
          (a, b) => b.created_at - a.created_at || Number(spammerKeys.has(b.pubkey)) - Number(spammerKeys.has(a.pubkey)),
        );
        out.push(...(limit === undefined ? all : all.slice(0, limit)));
      }
      return out;
    },
    subscribe: (f, on) => inner.subscribe(f, on),
    close: () => undefined,
  };
}

async function publishAll(relay: RelayClient, evs: NostrEvent[]) {
  for (const e of evs) await relay.publish(e);
}

const spamMatch = (spammer: ReturnType<typeof newUser>, p2: ReturnType<typeof newUser>, i: number) =>
  spammer.signer.signEvent(
    buildMatch(
      'smash_sp',
      {
        p1: spammer.pk,
        p2: p2.pk,
        p1Fighter: 'mario',
        p2Fighter: 'fox',
        p1SettingsId: '1'.repeat(64),
        p2SettingsId: '2'.repeat(64),
        applicationId: i.toString(16).padStart(64, '0'),
        sessions: [spammer.sessionAt(T0), p2.sessionAt(T0)],
      },
      T0,
    ),
  );

describe('fetchRatingEvents', () => {
  test('collects matches, the linked applications, reports and account info', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = [await identity(a, T0 - 10), await identity(b, T0 - 10), ...(await p1Wins(a, b, T0))];
    await publishAll(relay, evs);
    const got = await fetchRatingEvents(relay, def, registeredKels(), T0 - 100, T0 + 1000);
    expect(ids(got.events)).toEqual(ids(evs));
    expect(got.incomplete.size).toBe(0);
  });

  test('finds a new account from its KEL events', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    await publishAll(relay, [...a.kelEvents(), ...b.kelEvents(), ...evs]);
    // 記録済みの KEL を渡さない（どちらも新しいアカウント）。KEL は作成から時間がたっていても見つかる
    const got = await fetchRatingEvents(relay, def, {}, T0 - 100, T0 + 1000);
    for (const e of evs) expect(has(got.events, e)).toBe(true);
  });

  test('pages through relays that cap the number of results', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = [...(await p1Wins(a, b, T0))];
    const results = ['win', 'lose', 'cancel'] as const;
    for (let i = 0; i < 25; i++) {
      evs.push(await a.signer.signEvent(buildReport('smash_sp', { matchId: evs[1]!.id, opponent: b.sessionAt(T0), result: results[i % 3]! }, T0 + 100 + Math.floor(i / 3))));
    }
    await publishAll(relay, evs);
    const got = await fetchRatingEvents(relay, def, registeredKels(), T0 - 100, T0 + 1000, { pageSize: 10 });
    expect(ids(got.events)).toEqual(ids(evs));
  });

  test('a flood of foreign reports in the same second does not hide a real report', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    await publishAll(relay, evs);
    const winReport = evs[2]!;
    const spammer = newUser();
    for (let i = 0; i < 15; i++) {
      await relay.publish(
        await spammer.signer.signEvent(
          buildReport('smash_sp', { matchId: evs[1]!.id, opponent: a.sessionAt(T0), result: (['win', 'lose', 'cancel'] as const)[i % 3]! }, winReport.created_at),
        ),
      );
    }
    const got = await fetchRatingEvents(spamFirst(relay, new Set([spammer.sessionAt(T0)])), def, registeredKels(), T0 - 100, T0 + 1000, {
      pageSize: 10,
      strict: true,
    });
    expect(has(got.events, winReport)).toBe(true);
    expect(has(got.events, evs[3]!)).toBe(true);
  });

  test('a flood of matches tagged for everyone does not hide a known player match', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    // 既知のアカウントは、証明書のお知らせから使い捨ての鍵を知り、作成者で取り切る
    await publishAll(relay, [...evs, a.certAnnouncement(T0), b.certAnnouncement(T0)]);
    const spammer = newUser();
    for (let i = 0; i < 15; i++) await relay.publish(await spamMatch(spammer, b, i));
    const got = await fetchRatingEvents(spamFirst(relay, new Set([spammer.sessionAt(T0)])), def, registeredKels(), T0 - 100, T0 + 1000, {
      pageSize: 10,
      strict: true,
    });
    expect(has(got.events, evs[1]!)).toBe(true);
  });

  test('strict mode marks only the flooding account as incomplete', async () => {
    const relay = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    const spammer = newUser();
    await publishAll(relay, [...evs, a.certAnnouncement(T0), b.certAnnouncement(T0), spammer.certAnnouncement(T0)]);
    for (let i = 0; i < 15; i++) await relay.publish(await spamMatch(spammer, a, i));
    const got = await fetchRatingEvents(relay, def, registeredKels(), T0 - 100, T0 + 1000, { pageSize: 10, strict: true });
    expect([...got.incomplete]).toEqual([spammer.pk]);
    for (const e of evs) expect(has(got.events, e)).toBe(true);
  });

  test('pages through each relay separately so a shallower relay does not hide events', async () => {
    const r1 = new MemoryRelay(now);
    const r2 = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const old = await p1Wins(a, b, T0);
    const recent: NostrEvent[] = [];
    for (let i = 0; i < 6; i++) recent.push(...(await p1Wins(a, b, T0 + 1000 + i * 100)));
    await publishAll(r1, old);
    await publishAll(r2, recent);
    // r1 には古い対戦だけ、r2 には新しい対戦だけがある。r2 の古い側にも取りこぼしがないこと
    await publishAll(r1, recent.slice(0, 4));
    const got = await fetchRatingEvents(multi([r1, r2]), def, registeredKels(), T0 - 100, T0 + 5000, { pageSize: 5 });
    expect(ids(got.events)).toEqual(ids([...old, ...recent]));
  });

  test('a relay that returns a forged copy with the same id does not hide the real event', async () => {
    const honest = new MemoryRelay(now);
    const a = newUser();
    const b = newUser();
    const evs = await p1Wins(a, b, T0);
    await publishAll(honest, evs);
    const poisoned: RelayClient = {
      publish: async () => undefined,
      query: async (f) => (await honest.query(f)).map((e) => ({ ...e, content: '{"result":"cancel"}' })),
      subscribe: () => () => undefined,
      close: () => undefined,
    };
    const got = await fetchRatingEvents(multi([poisoned, honest]), def, registeredKels(), T0 - 100, T0 + 1000);
    expect(ids(got.events)).toEqual(ids(evs));
    expect(got.events.every((e) => isValidEvent(e))).toBe(true);
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
