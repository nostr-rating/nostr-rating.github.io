import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildAccountInfo,
  buildApplication,
  buildMatch,
  buildReport,
  KIND,
  MemoryRelay,
  type Filter,
  type NostrEvent,
  type RelayClient,
} from '@nostr-rating/core';
import { runSnapshot } from '../src/run.js';
import { fixedAccount } from './account.js';

const REPO = resolve(__dirname, '../../..');
const FIXTURES = resolve(__dirname, 'fixtures');
const T0 = 1_790_800_000;
const DAY = 86400;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nr-snap-'));
  cpSync(join(REPO, 'configs'), join(root, 'configs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** リレーごとに返す順番が違っても結果が変わらないことを確かめるため、問い合わせ結果を逆順にする */
function reversed(inner: RelayClient): RelayClient {
  return { ...inner, query: async (f: Filter[]) => (await inner.query(f)).reverse(), subscribe: inner.subscribe.bind(inner), publish: inner.publish.bind(inner), close: () => inner.close() };
}

async function seededEvents(): Promise<NostrEvent[]> {
  const a = fixedAccount(1, T0 - DAY);
  const b = fixedAccount(2, T0 - DAY);
  const evs: NostrEvent[] = [a.kelEvent, b.kelEvent, a.certAnnouncement(T0), b.certAnnouncement(T0)];
  for (const [acc, proof] of [[a, 'a1'], [b, 'b1'], [b, 'b2']] as const) {
    evs.push(acc.sign(buildAccountInfo({ pubkey: acc.aid, name: '', claims: [{ platform: 'github', identity: proof, proof }] }, T0 - (proof === 'b2' ? 5 : 10))));
  }
  const app = b.sign(
    buildApplication(
      'smash_sp',
      { recruiter: a.aid, recruiterSession: a.session(T0), firstFighter: 'fox', settingsId: '2'.repeat(64), rangeChoice: null, rematchHours: 0, waitingSince: T0 - 30 },
      T0 - 1,
    ),
  );
  const m = a.sign(
    buildMatch(
      'smash_sp',
      { p1: a.aid, p2: b.aid, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: app.id, sessions: [a.session(T0), b.session(T0)] },
      T0,
    ),
  );
  evs.push(app, m);
  evs.push(a.sign(buildReport('smash_sp', { matchId: m.id, opponent: b.session(T0), result: 'win' }, T0 + 60)));
  evs.push(b.sign(buildReport('smash_sp', { matchId: m.id, opponent: a.session(T0), result: 'lose' }, T0 + 61)));
  return evs;
}

/** 置き換え可能イベントを1つのリレーに入れると古い版が消えるので、版ごとに別のリレーに置く */
async function relaysWith(evs: NostrEvent[]): Promise<RelayClient> {
  const r1 = new MemoryRelay(() => T0 + 10 * DAY);
  const r2 = new MemoryRelay(() => T0 + 10 * DAY);
  const isB2 = (e: NostrEvent) => e.kind === KIND.account && e.content.includes('"b2"');
  for (const e of evs) await (isB2(e) ? r2 : r1).publish(e);
  for (const e of evs) if (e.kind !== KIND.account) await r2.publish(e);
  return {
    publish: async (e) => r1.publish(e),
    query: async (f) => [...(await r1.query(f)), ...(await r2.query(f))],
    subscribe: (f, on) => r1.subscribe(f, on),
    close: () => undefined,
  };
}

const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('runSnapshot', () => {
  test('writes snapshot, ids and latest pointer that match the golden files', async () => {
    const relay = await relaysWith(await seededEvents());
    const out = await runSnapshot({ root, cutoff: T0 + DAY, relay });
    expect(out.path).toBe('snapshots/smash_sp/season_1/2026-10-02.json');
    expect(read(out.path)).toBe(readFileSync(join(FIXTURES, 'snapshot.json'), 'utf8'));
    expect(read('snapshots/smash_sp/season_1/2026-10-02.ids.txt')).toBe(readFileSync(join(FIXTURES, 'snapshot.ids.txt'), 'utf8'));
    expect(read('snapshots/smash_sp/latest.json')).toBe(readFileSync(join(FIXTURES, 'latest.json'), 'utf8'));
  });

  test('a relay that could not answer stops the snapshot without writing anything', async () => {
    const inner = await relaysWith(await seededEvents());
    let calls = 0;
    // 途中の問い合わせで失敗する（それまでの問い合わせは答えている）
    const flaky: RelayClient = { ...inner, query: async (f) => (++calls === 5 ? Promise.reject(new Error('wss://r.example: no EOSE within 10000ms')) : inner.query(f)) };
    await expect(runSnapshot({ root, cutoff: T0 + DAY, relay: flaky })).rejects.toThrow('wss://r.example: no EOSE within 10000ms');
    expect(existsSync(join(root, 'snapshots'))).toBe(false);
  });

  test('result does not depend on the order relays return events', async () => {
    const evs = await seededEvents();
    const first = await runSnapshot({ root, cutoff: T0 + DAY, relay: await relaysWith(evs) });
    const bytes = read(first.path);
    const ids = read('snapshots/smash_sp/season_1/2026-10-02.ids.txt');
    rmSync(join(root, 'snapshots'), { recursive: true });
    await runSnapshot({ root, cutoff: T0 + DAY, relay: reversed(await relaysWith([...evs].reverse())) });
    expect(read(first.path)).toBe(bytes);
    expect(read('snapshots/smash_sp/season_1/2026-10-02.ids.txt')).toBe(ids);
  });

  test('the loser cannot erase a loss by sending more events in one second than a page holds', async () => {
    const b = fixedAccount(2, T0 - DAY);
    const flood = Array.from({ length: 301 }, (_, i) => b.sign({ kind: KIND.report, created_at: T0 + 100, tags: [['e', 'f'.repeat(64)]], content: String(i) }));
    const relay = await relaysWith([...(await seededEvents()), ...flood]);
    // 紐づけは前の回に記録される（取り切れなかった回は、その回の紐づけを使わない）
    await runSnapshot({ root, cutoff: T0, relay });
    const out = await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const snap = JSON.parse(read(out.path));
    expect(snap.excluded).toEqual([b.aid]);
    expect(Object.entries(snap.players).map(([pk, p]: [string, any]) => [pk === b.aid ? 'b' : 'a', p.wins, p.losses]).sort()).toEqual([
      ['a', 1, 0],
      ['b', 0, 1],
    ]);
    // 300件を超える署名に時間がかかる
  }, 60_000);

  test('chains from the previous snapshot without double counting', async () => {
    const relay = await relaysWith(await seededEvents());
    await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const out = await runSnapshot({ root, cutoff: T0 + 3 * DAY, relay });
    const snap = JSON.parse(read(out.path));
    expect(snap.previous).toBe('snapshots/smash_sp/season_1/2026-10-02.json');
    expect(Object.values(snap.players).map((p: any) => p.matches)).toEqual([1, 1]);
    expect(snap.inputs.event_count).toBe(0);
  });

  test('rejects a previous snapshot whose hash does not match latest.json', async () => {
    const relay = await relaysWith(await seededEvents());
    const out = await runSnapshot({ root, cutoff: T0 + DAY, relay });
    writeFileSync(join(root, out.path), read(out.path).replace('"wins": 1', '"wins": 9'));
    await expect(runSnapshot({ root, cutoff: T0 + 3 * DAY, relay })).rejects.toThrow(
      'sha256 mismatch: snapshots/smash_sp/season_1/2026-10-02.json does not match snapshots/smash_sp/latest.json',
    );
  });

  test('rejects a change of rating settings in the middle of a season', async () => {
    const relay = await relaysWith(await seededEvents());
    await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const cfg = JSON.parse(read('configs/smash_sp.json'));
    cfg.rating.tau = 0.6;
    writeFileSync(join(root, 'configs/smash_sp.json'), JSON.stringify(cfg));
    await expect(runSnapshot({ root, cutoff: T0 + 3 * DAY, relay })).rejects.toThrow(
      'rating settings in configs changed since the previous snapshot; change them only at a season boundary',
    );
  });

  test('cutoff in the future is rejected', async () => {
    await expect(runSnapshot({ root, cutoff: T0 + DAY, relay: new MemoryRelay(() => 0), now: () => T0 })).rejects.toThrow(
      `cutoff ${T0 + DAY} is in the future; reports may still arrive`,
    );
  });

  test('the first run after a season ends writes only the final snapshot with summaries', async () => {
    const relay = await relaysWith(await seededEvents());
    await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const s2 = 1_798_729_200; // シーズン2の開始（2027-01-01 JST）
    const out = await runSnapshot({ root, cutoff: s2 + DAY, relay, now: () => s2 + 2 * DAY });
    expect(out.path).toBe('snapshots/smash_sp/season_1/final.json');
    const final = JSON.parse(read(out.path));
    expect([final.kind, final.season, final.cutoff, final.previous]).toEqual(['final', 1, s2, 'snapshots/smash_sp/season_1/2026-10-02.json']);
    expect(Object.values(final.season_summaries['1']).map((x: any) => [x.matches, x.wins, x.losses]).sort()).toEqual([[1, 0, 1], [1, 1, 0]]);
    expect(JSON.parse(read('snapshots/smash_sp/latest.json')).path).toBe('snapshots/smash_sp/season_1/final.json');
  });

  test('the next run starts the new season from zero and keeps the summaries', async () => {
    const relay = await relaysWith(await seededEvents());
    await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const s2 = 1_798_729_200;
    await runSnapshot({ root, cutoff: s2 + DAY, relay, now: () => s2 + 2 * DAY });
    const out = await runSnapshot({ root, cutoff: s2 + DAY, relay, now: () => s2 + 2 * DAY });
    expect(out.path).toBe('snapshots/smash_sp/season_2/2027-01-02.json');
    const next = JSON.parse(read(out.path));
    expect([next.season, next.previous, next.players]).toEqual([2, 'snapshots/smash_sp/season_1/final.json', {}]);
    expect(next.season_summaries).toEqual(JSON.parse(read('snapshots/smash_sp/season_1/final.json')).season_summaries);
  });

  test('rating settings may change between the final snapshot and the new season, but not later', async () => {
    const relay = await relaysWith(await seededEvents());
    await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const s2 = 1_798_729_200;
    await runSnapshot({ root, cutoff: s2 + DAY, relay, now: () => s2 + 2 * DAY });
    const cfg = JSON.parse(read('configs/smash_sp.json'));
    cfg.rating.tau = 0.6;
    writeFileSync(join(root, 'configs/smash_sp.json'), JSON.stringify(cfg));
    await runSnapshot({ root, cutoff: s2 + DAY, relay, now: () => s2 + 2 * DAY });
    cfg.rating.tau = 0.7;
    writeFileSync(join(root, 'configs/smash_sp.json'), JSON.stringify(cfg));
    await expect(runSnapshot({ root, cutoff: s2 + 3 * DAY, relay, now: () => s2 + 4 * DAY })).rejects.toThrow(
      'rating settings in configs changed since the previous snapshot; change them only at a season boundary',
    );
  });

  test('cutoff outside any season is rejected', async () => {
    await expect(runSnapshot({ root, cutoff: 1_700_000_000, relay: new MemoryRelay(() => 0) })).rejects.toThrow(
      'cutoff 1700000000 is before the first season',
    );
  });
});
