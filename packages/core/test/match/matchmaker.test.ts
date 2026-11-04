import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildAccountInfo, buildMatch, buildRecruitment, parseApplication, type MatchRecord } from '../../src/events/codec.js';
import { KIND } from '../../src/events/kinds.js';
import type { LocalView } from '../../src/match/conditions.js';
import { Matchmaker } from '../../src/match/matchmaker.js';
import { MemoryRelay } from '../../src/relay/memory.js';
import { def } from '../helpers/def.js';
import { newUser } from '../helpers/keys.js';
import { authorOf } from '../helpers/state.js';

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function flatView(ratings: Record<string, number> = {}): LocalView {
  return {
    ratingOf: (pk) => ratings[pk] ?? 1500,
    mannersTotalOf: () => 0,
    lastMatchBetween: () => null,
    hasIdentity: () => false,
  };
}

type U = ReturnType<typeof newUser>;
const claimFor = (u: U, at: number) =>
  u.signer.signEvent(buildAccountInfo({ pubkey: u.pk, name: '', claims: [{ platform: 'github', identity: u.pk.slice(0, 6), proof: 'abc' }] }, at));

/** 紐づけをリレーに出したユーザー（手元の view はまだ知らない状態） */
function maker(relay: MemoryRelay, view: LocalView = flatView(), withIdentity = true) {
  const u = newUser();
  if (withIdentity) void claimFor(u, now() - 100).then((e) => relay.publish(e));
  const author = async (ev: Parameters<typeof authorOf>[0]) => authorOf(ev);
  const mm = new Matchmaker({ relay, identity: u.identityAt(now()), author, def, view, now, sleep });
  return { ...u, mm };
}

async function settle<T>(p: Promise<T>, ctrl: AbortController, ms: number): Promise<T | string> {
  const guarded = p.catch((e: Error) => e.name);
  await vi.advanceTimersByTimeAsync(ms);
  ctrl.abort();
  await vi.advanceTimersByTimeAsync(2000);
  return guarded;
}

const params = (firstFighter: string) => ({
  firstFighter,
  rangeChoice: null,
  rematchHours: 0,
  settingsId: 'a'.repeat(64),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_790_800_000_000));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Matchmaker', () => {
  test('seeker applies to an open recruitment and both get the same MatchRecord', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const b = maker(relay);
    const pa = a.mm.search(params('mario'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    const pb = b.mm.search(params('fox'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000);
    const [ma, mb] = await Promise.all([pa, pb]);
    expect(ma).toEqual(mb);
    expect(ma.p1).toBe(a.pk);
    expect(ma.p2).toBe(b.pk);
    expect(ma.p1Fighter).toBe('mario');
    expect(ma.p2Fighter).toBe('fox');
  });

  test('two simultaneous seekers end up in exactly one match', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const b = maker(relay);
    const ctrl = new AbortController();
    const pa = a.mm.search(params('mario'), ctrl.signal);
    const pb = b.mm.search(params('fox'), ctrl.signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const [ma, mb] = await Promise.all([pa, pb]);
    expect(ma.id).toBe(mb.id);
    expect(relay.all().filter((e) => e.kind === KIND.match)).toHaveLength(1);
  });

  test('three seekers: two match and one keeps waiting', async () => {
    const relay = new MemoryRelay(now);
    const users = [maker(relay), maker(relay), maker(relay)];
    const ctrl = new AbortController();
    const results: (MatchRecord | 'aborted')[] = [];
    const ps = users.map((u, i) =>
      u.mm.search(params(['mario', 'fox', 'link'][i]!), ctrl.signal).then(
        (m) => void results.push(m),
        () => void results.push('aborted'),
      ),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(ps);
    const matches = results.filter((r): r is MatchRecord => r !== 'aborted');
    expect(matches).toHaveLength(2);
    expect(matches[0]!.id).toBe(matches[1]!.id);
    expect(results.filter((r) => r === 'aborted')).toHaveLength(1);
    expect(relay.all().filter((e) => e.kind === KIND.match)).toHaveLength(1);
  });

  test('rating gap outside range does not match', async () => {
    const relay = new MemoryRelay(now);
    const view = flatView();
    const a = maker(relay, view);
    const b = maker(relay, view);
    const ratings: Record<string, number> = { [a.pk]: 1500, [b.pk]: 1800 };
    view.ratingOf = (pk) => ratings[pk] ?? 1500;
    const ctrl = new AbortController();
    const pa = a.mm.search({ ...params('mario'), rangeChoice: 100 }, ctrl.signal).catch((e: Error) => e.name);
    const pb = b.mm.search({ ...params('fox'), rangeChoice: 100 }, ctrl.signal).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(30_000);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await Promise.all([pa, pb])).toEqual(['AbortError', 'AbortError']);
  });

  test('abort closes the recruitment', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const ctrl = new AbortController();
    const pa = a.mm.search(params('mario'), ctrl.signal).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(3000);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pa).toBe('AbortError');
    const recs = await relay.query([{ kinds: [KIND.recruitment], authors: [a.sessionAt(now())] }]);
    expect(recs.map((e) => JSON.parse(e.content).status)).toEqual(['closed']);
  });

  test('ignores a match injected by a third party for my application', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const b = maker(relay);
    const mallory = newUser();
    relay.subscribe([{ kinds: [KIND.application] }], (ev) => {
      const app = parseApplication('smash_sp', ev, authorOf(ev))!;
      void mallory.signer
        .signEvent(
          buildMatch(
            'smash_sp',
            { p1: mallory.pk, p2: app.pubkey, p1Fighter: 'mario', p2Fighter: app.firstFighter, p1SettingsId: 'a'.repeat(64), p2SettingsId: app.settingsId, applicationId: app.eventId, sessions: [mallory.sessionAt(now()), app.session] },
            now(),
          ),
        )
        .then((m) => relay.publish(m));
    });
    const pa = a.mm.search(params('mario'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    const pb = b.mm.search(params('fox'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000);
    const [ma, mb] = await Promise.all([pa, pb]);
    expect(mb.p1).toBe(a.pk);
    expect(mb.id).toBe(ma.id);
  });

  test('rejects a match whose created_at is far from my application', async () => {
    const relay = new MemoryRelay(now);
    const b = maker(relay);
    const mallory = newUser();
    await relay.publish(
      await mallory.signer.signEvent(
        buildRecruitment('smash_sp', { firstFighter: 'mario', rating: 1500, rangeChoice: null, rematchHours: 0, settingsId: 'a'.repeat(64), waitingSince: now(), status: 'open' }, now(), 600),
      ),
    );
    await relay.publish(await claimFor(mallory, now() - 100));
    relay.subscribe([{ kinds: [KIND.application], '#p': [mallory.sessionAt(now())] }], (ev) => {
      const app = parseApplication('smash_sp', ev, authorOf(ev))!;
      void mallory.signer
        .signEvent(
          buildMatch(
            'smash_sp',
            { p1: mallory.pk, p2: app.pubkey, p1Fighter: 'mario', p2Fighter: app.firstFighter, p1SettingsId: 'a'.repeat(64), p2SettingsId: app.settingsId, applicationId: app.eventId, sessions: [mallory.sessionAt(now()), app.session] },
            now() + 3600,
          ),
        )
        .then((m) => relay.publish(m));
    });
    const ctrl = new AbortController();
    expect(await settle(b.mm.search(params('fox'), ctrl.signal), ctrl, 20_000)).toBe('AbortError');
  });

  test('does not apply to recruitments with an implausible waitingSince', async () => {
    const relay = new MemoryRelay(now);
    const b = maker(relay);
    const spammer = newUser();
    await relay.publish(await claimFor(spammer, now() - 100));
    await relay.publish(
      await spammer.signer.signEvent(
        buildRecruitment('smash_sp', { firstFighter: 'mario', rating: 1500, rangeChoice: null, rematchHours: 0, settingsId: 'a'.repeat(64), waitingSince: 0, status: 'open' }, now(), 120),
      ),
    );
    const ctrl = new AbortController();
    await settle(b.mm.search(params('fox'), ctrl.signal), ctrl, 15_000);
    expect(relay.all().filter((e) => e.kind === KIND.application)).toHaveLength(0);
  });

  test('does not match a counterpart without an identity claim', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const b = maker(relay, flatView(), false);
    const ctrl = new AbortController();
    const pa = a.mm.search(params('mario'), ctrl.signal).catch((e: Error) => e.name);
    const pb = b.mm.search(params('fox'), ctrl.signal).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(20_000);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all([pa, pb])).toEqual(['AbortError', 'AbortError']);
  });

  test('avoids a rematch with an opponent from a match still on the relay', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const b = maker(relay);
    await relay.publish(
      await a.signer.signEvent(
        buildMatch(
          'smash_sp',
          { p1: a.pk, p2: b.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: 'a'.repeat(64), p2SettingsId: 'b'.repeat(64), applicationId: 'c'.repeat(64), sessions: [a.sessionAt(now()), b.sessionAt(now())] },
          now() - 3600,
        ),
      ),
    );
    const ctrl = new AbortController();
    const pa = a.mm.search({ ...params('mario'), rematchHours: 3 }, ctrl.signal).catch((e: Error) => e.name);
    const pb = b.mm.search(params('fox'), ctrl.signal).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(20_000);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all([pa, pb])).toEqual(['AbortError', 'AbortError']);
  });

  test('searches in the last hour of the season', async () => {
    vi.setSystemTime(new Date((1_798_729_200 - 3600) * 1000)); // シーズン1の終わりの1時間前
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const ctrl = new AbortController();
    const pa = a.mm.search(params('mario'), ctrl.signal).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(relay.all().filter((e) => e.kind === KIND.recruitment)).toHaveLength(1);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await pa;
  });

  test('refuses to search before the first season starts', async () => {
    vi.setSystemTime(new Date((1_790_780_400 - 3600) * 1000)); // シーズン1の始まりの1時間前
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    await expect(a.mm.search(params('mario'), new AbortController().signal)).rejects.toThrow(
      'new matches are not accepted until the next season starts',
    );
    expect(relay.all().filter((e) => e.kind === KIND.recruitment)).toHaveLength(0);
  });

  test('recruitment is refreshed every heartbeat', async () => {
    const relay = new MemoryRelay(now);
    const a = maker(relay);
    const ctrl = new AbortController();
    const pa = a.mm.search(params('mario'), ctrl.signal).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    const first = (await relay.query([{ kinds: [KIND.recruitment] }]))[0]!.created_at;
    await vi.advanceTimersByTimeAsync(61_000);
    const second = (await relay.query([{ kinds: [KIND.recruitment] }]))[0]!.created_at;
    expect(second - first).toBeGreaterThanOrEqual(60);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await pa;
  });
});
