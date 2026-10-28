import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import {
  buildAccountInfo,
  buildApplication,
  buildMatch,
  buildRecruitment,
  buildReport,
  buildSettings,
  parseAccountInfo,
  parseApplication,
  parseMatch,
  parseRecruitment,
  parseReport,
  parseSettings,
} from '../../src/events/codec.js';
import { KIND } from '../../src/events/kinds.js';
import { attributor, buildKelBook } from '../../src/kel/book.js';
import { newUser, registeredKels } from '../helpers/keys.js';

const G = 'smash_sp';
const alice = newUser();
const bob = newUser();
const NOW = 1790800000;
/** 証明書から求めた aid（パイプラインと同じ方法） */
const by = (ev: NostrEvent) => attributor(buildKelBook(registeredKels(), [], -Infinity, Infinity).states)(ev);
const M = { p1: '', p2: '', p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: 'a'.repeat(64), p2SettingsId: 'b'.repeat(64), applicationId: 'c'.repeat(64) };

describe('roundtrip build → sign → parse', () => {
  test('settings', async () => {
    const ev = await alice.signer.signEvent(
      buildSettings(G, { stageBans: { mario: ['smashville'] }, rangeChoice: 100, rematchHours: 3 }, NOW),
    );
    expect(ev.kind).toBe(KIND.settings);
    expect(parseSettings(G, ev, by(ev))).toEqual({
      pubkey: alice.pk,
      eventId: ev.id,
      createdAt: NOW,
      stageBans: { mario: ['smashville'] },
      rangeChoice: 100,
      rematchHours: 3,
    });
  });

  test('recruitment', async () => {
    const ev = await alice.signer.signEvent(
      buildRecruitment(
        G,
        { firstFighter: 'mario', rating: 1500, rangeChoice: null, rematchHours: 0, settingsId: 'a'.repeat(64), waitingSince: NOW, status: 'open' },
        NOW,
        120,
      ),
    );
    expect(parseRecruitment(G, ev, by(ev))).toEqual({
      pubkey: alice.pk,
      session: alice.sessionAt(NOW),
      eventId: ev.id,
      createdAt: NOW,
      firstFighter: 'mario',
      rating: 1500,
      rangeChoice: null,
      rematchHours: 0,
      settingsId: 'a'.repeat(64),
      waitingSince: NOW,
      status: 'open',
      expiresAt: NOW + 120,
    });
  });

  test('application', async () => {
    const ev = await bob.signer.signEvent(
      buildApplication(
        G,
        { recruiter: alice.pk, recruiterSession: alice.sessionAt(NOW), firstFighter: 'fox', settingsId: 'b'.repeat(64), rangeChoice: 150, rematchHours: 5, waitingSince: NOW - 30 },
        NOW,
      ),
    );
    expect(parseApplication(G, ev, by(ev))).toEqual({
      eventId: ev.id,
      pubkey: bob.pk,
      session: bob.sessionAt(NOW),
      createdAt: NOW,
      recruiter: alice.pk,
      recruiterSession: alice.sessionAt(NOW),
      recruitmentAddr: `31751:${alice.sessionAt(NOW)}:smash_sp`,
      firstFighter: 'fox',
      settingsId: 'b'.repeat(64),
      rangeChoice: 150,
      rematchHours: 5,
      waitingSince: NOW - 30,
    });
  });

  test('match', async () => {
    const ev = await alice.signer.signEvent(
      buildMatch(G, { ...M, p1: alice.pk, p2: bob.pk, sessions: [alice.sessionAt(NOW), bob.sessionAt(NOW)] }, NOW),
    );
    expect(parseMatch(G, ev, by(ev))).toEqual({
      id: ev.id,
      createdAt: NOW,
      p1: alice.pk,
      p2: bob.pk,
      p1Fighter: 'mario',
      p2Fighter: 'fox',
      p1SettingsId: 'a'.repeat(64),
      p2SettingsId: 'b'.repeat(64),
      applicationId: 'c'.repeat(64),
      sessions: [alice.sessionAt(NOW), bob.sessionAt(NOW)],
    });
  });

  test('report', async () => {
    const ev = await bob.signer.signEvent(buildReport(G, { matchId: 'd'.repeat(64), opponent: alice.sessionAt(NOW), result: 'lose' }, NOW));
    expect(parseReport(G, ev, by(ev))).toEqual({ id: ev.id, matchId: 'd'.repeat(64), reporter: bob.pk, result: 'lose', createdAt: NOW });
  });

  test('account info', async () => {
    const claims = [{ platform: 'github' as const, identity: 'alice', proof: 'abc' }];
    const ev = await alice.signer.signEvent(buildAccountInfo(G, { pubkey: alice.pk, name: 'アリス', claims }, NOW));
    expect(ev.kind).toBe(KIND.account);
    expect(parseAccountInfo(G, ev, by(ev))).toEqual({ pubkey: alice.pk, eventId: ev.id, createdAt: NOW, name: 'アリス', claims });
    // d が署名したアカウントと違えば読まない
    const other = await bob.signer.signEvent(buildAccountInfo(G, { pubkey: alice.pk, name: 'x', claims }, NOW));
    expect(parseAccountInfo(G, other, by(other))).toBeNull();
  });

  test('events without a valid certificate have no author', async () => {
    const ev = await alice.signer.signEvent(buildReport(G, { matchId: 'd'.repeat(64), opponent: bob.sessionAt(NOW), result: 'win' }, NOW));
    expect(by({ ...ev, tags: ev.tags.filter((t) => t[0] !== 'cert') })).toBeNull();
    // 証明書の期間の外で署名したイベント
    const late = await bob.signer.signEvent(buildReport(G, { matchId: 'd'.repeat(64), opponent: alice.sessionAt(NOW), result: 'win' }, NOW));
    const forged = await signRawWith(late, NOW + 2 * 86400);
    expect(by(forged)).toBeNull();
  });
});

/** 同じ使い捨ての鍵と証明書のまま、時刻だけを変えたイベント（署名は作り直せないので別の鍵で試す） */
async function signRawWith(ev: NostrEvent, at: number): Promise<NostrEvent> {
  const { finalizeEvent, generateSecretKey } = await import('nostr-tools/pure');
  return finalizeEvent({ kind: ev.kind, content: ev.content, tags: ev.tags, created_at: at }, generateSecretKey());
}

async function signRaw(kind: number, content: string, tags: string[][], signer = alice.signer): Promise<NostrEvent> {
  return signer.signEvent({ kind, content, tags, created_at: NOW });
}

describe('parsers reject malformed events', () => {
  const base = [['t', 'nostr-rating'], ['game', G]];

  test('broken JSON, other game, missing t tag', async () => {
    expect(parseReport(G, await signRaw(KIND.report, '{', [...base, ['e', 'd'.repeat(64)], ['p', bob.pk]]), alice.pk)).toBeNull();
    expect(
      parseReport(G, await signRaw(KIND.report, '{"result":"win"}', [['t', 'nostr-rating'], ['game', 'tekken'], ['e', 'd'.repeat(64)], ['p', bob.pk]]), alice.pk),
    ).toBeNull();
    expect(parseReport(G, await signRaw(KIND.report, '{"result":"win"}', [['game', G], ['e', 'd'.repeat(64)], ['p', bob.pk]]), alice.pk)).toBeNull();
  });

  test('unknown result value', async () => {
    expect(parseReport(G, await signRaw(KIND.report, '{"result":"draw"}', [...base, ['e', 'd'.repeat(64)], ['p', bob.pk]]), alice.pk)).toBeNull();
  });

  test('tampered signature even when the object keeps nostr-tools verified marker', async () => {
    const ev = await bob.signer.signEvent(buildReport(G, { matchId: 'd'.repeat(64), opponent: alice.pk, result: 'lose' }, NOW));
    expect(parseReport(G, { ...ev, content: '{"result":"win"}' }, bob.pk)).toBeNull();
  });

  test('match signed by someone other than p1', async () => {
    const tmpl = buildMatch(G, { ...M, p1: alice.pk, p2: bob.pk, sessions: [alice.sessionAt(NOW), bob.sessionAt(NOW)] }, NOW);
    const ev = await bob.signer.signEvent(tmpl);
    expect(parseMatch(G, ev, by(ev))).toBeNull();
  });

  test('match whose p tags do not name both sessions', async () => {
    const tmpl = buildMatch(G, { ...M, p1: alice.pk, p2: bob.pk, sessions: [alice.sessionAt(NOW)] }, NOW);
    const ev = await alice.signer.signEvent(tmpl);
    expect(parseMatch(G, ev, by(ev))).toBeNull();
  });

  test('wrong kind', async () => {
    expect(parseSettings(G, await signRaw(1, '{}', base), alice.pk)).toBeNull();
  });

  test('settings with non-array bans', async () => {
    const ev = await signRaw(KIND.settings, '{"stageBans":{"mario":"smashville"},"rangeChoice":null,"rematchHours":0}', [
      ...base,
      ['d', 'nostr-rating:smash_sp:settings'],
    ]);
    expect(parseSettings(G, ev, alice.pk)).toBeNull();
  });

  test('null and garbage input do not throw', () => {
    expect(parseMatch(G, null as unknown as NostrEvent, alice.pk)).toBeNull();
    expect(parseAccountInfo(G, {} as NostrEvent, alice.pk)).toBeNull();
    expect(by({} as NostrEvent)).toBeNull();
  });
});
