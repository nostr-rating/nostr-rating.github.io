import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { buildAccountInfo, buildApplication, buildMatch, buildReport } from '../../src/events/codec.js';
import { certTags, SESSION_LIFETIME_SEC, type SessionCert } from '../../src/kel/cert.js';
import { kelEventTemplate } from '../../src/kel/event.js';
import { digestOf, type KelEntry } from '../../src/kel/kel.js';
import { advanceRatings, initialState } from '../../src/rating/pipeline.js';
import { def } from '../helpers/def.js';
import { icp, ixn, newDevice, newNextKey, signed } from '../helpers/kel.js';

const G = 'smash_sp';
const DAY = 86400;
const T0 = 1_790_800_000;

/** KEL を手で組み立てるアカウント（端末の取り消しなどを試す） */
function account(at: number) {
  const d1 = newDevice(at - DAY);
  const d2 = newDevice(at - DAY);
  const next = newNextKey();
  const body = icp([d1.record, d2.record], { keys: [next.pub], threshold: 1 }, Math.random().toString(36));
  const aid = digestOf(body);
  const entries: { entry: KelEntry; at: number }[] = [{ entry: signed(body, [d1, d2]), at: at - DAY }];
  const sessions = new Map<string, { sk: Uint8Array; cert: SessionCert }>();
  const session = (dev: typeof d1, from: number) => {
    const key = `${dev.record.id}:${from}`;
    let s = sessions.get(key);
    if (!s) {
      const sk = generateSecretKey();
      s = { sk, cert: { v: 1, aid, device: dev.record.id, publisher: dev.record.publisher, session: getPublicKey(sk), tip: '', from, until: from + SESSION_LIFETIME_SEC } };
      sessions.set(key, s);
    }
    return s;
  };
  const sign = async (dev: typeof d1, from: number, t: EventTemplate): Promise<NostrEvent> => {
    const { sk, cert } = session(dev, from);
    return finalizeEvent({ ...t, tags: [...t.tags, ...certTags({ cert, sig: dev.sign(digestOf(cert)) })] }, sk);
  };
  const revoke = (dev: typeof d1, by: typeof d1, t: number) => {
    const last = entries[entries.length - 1]!.entry.body;
    entries.push({ entry: signed(ixn(aid, last.sn + 1, digestOf(last), { revoke: [dev.record.id] }), [by]), at: t });
  };
  const kelEvents = () => entries.map((e) => finalizeEvent(kelEventTemplate(e.entry, e.at), d1.publisherSk));
  return { aid, d1, d2, sign, revoke, kelEvents, entries, sessionKey: (dev: typeof d1, from: number) => session(dev, from).cert.session };
}

async function playedBy(p1: ReturnType<typeof account>, p2: ReturnType<typeof account>, at: number, from = at - 3600) {
  const claim = (a: typeof p1) => a.sign(a.d2, from, buildAccountInfo(G, { pubkey: a.aid, name: '', claims: [{ platform: 'github', identity: 'x', proof: 'a' }] }, at - 50));
  const recruiterSession = p1.sessionKey(p1.d1, from);
  const app = await p2.sign(p2.d2, from, buildApplication(G, { recruiter: p1.aid, recruiterSession, firstFighter: 'fox', settingsId: '2'.repeat(64), rangeChoice: null, rematchHours: 0, waitingSince: at - 5 }, at - 1));
  const m = await p1.sign(p1.d1, from, buildMatch(G, { p1: p1.aid, p2: p2.aid, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: app.id, sessions: [recruiterSession, app.pubkey] }, at));
  const r1 = await p1.sign(p1.d1, from, buildReport(G, { matchId: m.id, opponent: app.pubkey, result: 'win' }, at + 60));
  const r2 = await p2.sign(p2.d2, from, buildReport(G, { matchId: m.id, opponent: recruiterSession, result: 'lose' }, at + 61));
  return [await claim(p1), await claim(p2), app, m, r1, r2];
}

describe('advanceRatings with key event logs', () => {
  test('accepts new accounts from KEL events in the input and records them', async () => {
    const a = account(T0);
    const b = account(T0);
    const evs = [...a.kelEvents(), ...b.kelEvents(), ...(await playedBy(a, b, T0))];
    const { state, usedEventIds } = advanceRatings(def, initialState(def, 1, T0 - 100), evs, T0 + DAY);
    expect(state.players[a.aid]!.wins).toBe(1);
    expect(Object.keys(state.kels).sort()).toEqual([a.aid, b.aid].sort());
    for (const e of [...a.kelEvents(), ...b.kelEvents()]) expect(usedEventIds).toContain(e.id);
  });

  test('ignores events whose session certificate does not chain to the account', async () => {
    const a = account(T0);
    const b = account(T0);
    const evs = await playedBy(a, b, T0);
    // KEL が無ければ、だれのイベントか分からない
    const { state } = advanceRatings(def, initialState(def, 1, T0 - 100), evs, T0 + DAY);
    expect(state.players[a.aid]).toBeUndefined();
  });

  test('a device revoked before the certificate period cannot sign results', async () => {
    const a = account(T0);
    const b = account(T0);
    // a の端末1を、対戦の前に端末2で取り消す
    a.revoke(a.d1, a.d2, T0 - 3600);
    const evs = [...a.kelEvents(), ...b.kelEvents(), ...(await playedBy(a, b, T0))];
    const { state } = advanceRatings(def, initialState(def, 1, T0 - 100), evs, T0 + DAY);
    expect(state.players[a.aid]?.matches ?? 0).toBe(0);
  });

  test('a certificate issued before the revocation still counts until it expires', async () => {
    const a = account(T0);
    const b = account(T0);
    a.revoke(a.d1, a.d2, T0 - 10);
    const evs = [...a.kelEvents(), ...b.kelEvents(), ...(await playedBy(a, b, T0, T0 - 3600))];
    const { state } = advanceRatings(def, initialState(def, 1, T0 - 100), evs, T0 + DAY);
    expect(state.players[a.aid]!.wins).toBe(1);
  });

  test('excluded accounts are treated as if they had published nothing', async () => {
    const a = account(T0);
    const b = account(T0);
    const evs = [...a.kelEvents(), ...b.kelEvents(), ...(await playedBy(a, b, T0))];
    const { state } = advanceRatings(def, initialState(def, 1, T0 - 100), evs, T0 + DAY, { exclude: new Set([a.aid]) });
    expect(state.players[a.aid]).toBeUndefined();
    expect(state.players[b.aid]?.matches ?? 0).toBe(0);
  });

  test('a backdated KEL event for a recorded account is ignored', async () => {
    const a = account(T0);
    const b = account(T0);
    const first = advanceRatings(def, initialState(def, 1, T0 - 100), [...a.kelEvents(), ...b.kelEvents()], T0 + DAY).state;
    // 前回の締め切りより幅（24時間）以上前の日付で、端末1を取り消す
    a.revoke(a.d1, a.d2, T0 - 2 * DAY + 10);
    const second = advanceRatings(def, first, a.kelEvents(), T0 + 2 * DAY).state;
    expect(second.kels[a.aid]).toHaveLength(1);
  });
});
