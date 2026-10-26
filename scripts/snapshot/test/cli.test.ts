import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildApplication,
  buildIdentities,
  buildMatch,
  buildReport,
  LocalSigner,
  MemoryRelay,
  type Filter,
  type NostrEvent,
  type RelayClient,
} from '@nostr-rating/core';
import { runSnapshot } from '../src/run.js';

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

/** 固定の鍵（golden を作れるように） */
const signer = (n: number) => new LocalSigner(new Uint8Array(32).fill(n));

/** リレーごとに返す順番が違っても結果が変わらないことを確かめるため、問い合わせ結果を逆順にする */
function reversed(inner: RelayClient): RelayClient {
  return { ...inner, query: async (f: Filter[]) => (await inner.query(f)).reverse(), subscribe: inner.subscribe.bind(inner), publish: inner.publish.bind(inner), close: () => inner.close() };
}

async function seededEvents(): Promise<NostrEvent[]> {
  const a = signer(1);
  const b = signer(2);
  const [pa, pb] = [await a.getPublicKey(), await b.getPublicKey()];
  const evs: NostrEvent[] = [];
  for (const [s, proof] of [[a, 'a1'], [b, 'b1'], [b, 'b2']] as const) {
    evs.push(await s.signEvent(buildIdentities([{ platform: 'github', identity: proof, proof }], T0 - (proof === 'b2' ? 5 : 10))));
  }
  const app = await b.signEvent(
    buildApplication('smash_sp', { recruiter: pa, firstFighter: 'fox', settingsId: '2'.repeat(64), rangeChoice: null, rematchHours: 0, waitingSince: T0 - 30 }, T0 - 1),
  );
  const m = await a.signEvent(
    buildMatch('smash_sp', { p1: pa, p2: pb, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: app.id }, T0),
  );
  evs.push(app, m);
  evs.push(await a.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: pb, result: 'win' }, T0 + 60)));
  evs.push(await b.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: pa, result: 'lose' }, T0 + 61)));
  return evs;
}

/** 置き換え可能イベントを1つのリレーに入れると古い版が消えるので、版ごとに別のリレーに置く */
async function relaysWith(evs: NostrEvent[]): Promise<RelayClient> {
  const r1 = new MemoryRelay(() => T0 + 10 * DAY);
  const r2 = new MemoryRelay(() => T0 + 10 * DAY);
  for (const e of evs) await (e.content === '' && e.tags[0]?.[2] === 'b2' ? r2 : r1).publish(e);
  for (const e of evs) if (e.kind !== 10011) await r2.publish(e);
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
    expect(out.path).toBe('snapshots/season_1/2026-10-02.json');
    expect(read(out.path)).toBe(readFileSync(join(FIXTURES, 'snapshot.json'), 'utf8'));
    expect(read('snapshots/season_1/2026-10-02.ids.txt')).toBe(readFileSync(join(FIXTURES, 'snapshot.ids.txt'), 'utf8'));
    expect(read('snapshots/latest.json')).toBe(readFileSync(join(FIXTURES, 'latest.json'), 'utf8'));
  });

  test('result does not depend on the order relays return events', async () => {
    const evs = await seededEvents();
    const first = await runSnapshot({ root, cutoff: T0 + DAY, relay: await relaysWith(evs) });
    const bytes = read(first.path);
    const ids = read('snapshots/season_1/2026-10-02.ids.txt');
    rmSync(join(root, 'snapshots'), { recursive: true });
    await runSnapshot({ root, cutoff: T0 + DAY, relay: reversed(await relaysWith([...evs].reverse())) });
    expect(read(first.path)).toBe(bytes);
    expect(read('snapshots/season_1/2026-10-02.ids.txt')).toBe(ids);
  });

  test('chains from the previous snapshot without double counting', async () => {
    const relay = await relaysWith(await seededEvents());
    await runSnapshot({ root, cutoff: T0 + DAY, relay });
    const out = await runSnapshot({ root, cutoff: T0 + 3 * DAY, relay });
    const snap = JSON.parse(read(out.path));
    expect(snap.previous).toBe('snapshots/season_1/2026-10-02.json');
    expect(Object.values(snap.players).map((p: any) => p.matches)).toEqual([1, 1]);
    expect(snap.inputs.event_count).toBe(0);
  });

  test('rejects a previous snapshot whose hash does not match latest.json', async () => {
    const relay = await relaysWith(await seededEvents());
    const out = await runSnapshot({ root, cutoff: T0 + DAY, relay });
    writeFileSync(join(root, out.path), read(out.path).replace('"wins": 1', '"wins": 9'));
    await expect(runSnapshot({ root, cutoff: T0 + 3 * DAY, relay })).rejects.toThrow(
      'sha256 mismatch: snapshots/season_1/2026-10-02.json does not match snapshots/latest.json',
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

  test('cutoff outside any season is rejected', async () => {
    await expect(runSnapshot({ root, cutoff: 1_700_000_000, relay: new MemoryRelay(() => 0) })).rejects.toThrow(
      'cutoff 1700000000 is not inside any season',
    );
  });
});
