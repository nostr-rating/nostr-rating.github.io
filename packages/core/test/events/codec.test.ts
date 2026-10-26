import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import {
  buildApplication,
  buildIdentities,
  buildMatch,
  buildProfile,
  buildRecruitment,
  buildReport,
  buildSettings,
  parseApplication,
  parseIdentities,
  parseMatch,
  parseProfile,
  parseRecruitment,
  parseReport,
  parseSettings,
} from '../../src/events/codec.js';
import { KIND } from '../../src/events/kinds.js';
import { newUser } from '../helpers/keys.js';

const G = 'smash_sp';
const alice = newUser();
const bob = newUser();
const NOW = 1790800000;

describe('roundtrip build → sign → parse', () => {
  test('settings', async () => {
    const ev = await alice.signer.signEvent(
      buildSettings(G, { stageBans: { mario: ['smashville'] }, rangeChoice: 100, rematchHours: 3 }, NOW),
    );
    expect(ev.kind).toBe(KIND.settings);
    expect(parseSettings(G, ev)).toEqual({
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
    expect(parseRecruitment(G, ev)).toEqual({
      pubkey: alice.pk,
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
        { recruiter: alice.pk, firstFighter: 'fox', settingsId: 'b'.repeat(64), rangeChoice: 150, rematchHours: 5, waitingSince: NOW - 30 },
        NOW,
      ),
    );
    expect(parseApplication(G, ev)).toEqual({
      eventId: ev.id,
      pubkey: bob.pk,
      createdAt: NOW,
      recruiter: alice.pk,
      recruitmentAddr: `31751:${alice.pk}:smash_sp`,
      firstFighter: 'fox',
      settingsId: 'b'.repeat(64),
      rangeChoice: 150,
      rematchHours: 5,
      waitingSince: NOW - 30,
    });
  });

  test('match', async () => {
    const ev = await alice.signer.signEvent(
      buildMatch(
        G,
        { p1: alice.pk, p2: bob.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: 'a'.repeat(64), p2SettingsId: 'b'.repeat(64), applicationId: 'c'.repeat(64) },
        NOW,
      ),
    );
    expect(parseMatch(G, ev)).toEqual({
      id: ev.id,
      createdAt: NOW,
      p1: alice.pk,
      p2: bob.pk,
      p1Fighter: 'mario',
      p2Fighter: 'fox',
      p1SettingsId: 'a'.repeat(64),
      p2SettingsId: 'b'.repeat(64),
      applicationId: 'c'.repeat(64),
    });
  });

  test('report', async () => {
    const ev = await bob.signer.signEvent(buildReport(G, { matchId: 'd'.repeat(64), opponent: alice.pk, result: 'lose' }, NOW));
    expect(parseReport(G, ev)).toEqual({ id: ev.id, matchId: 'd'.repeat(64), reporter: bob.pk, result: 'lose', createdAt: NOW });
  });

  test('identities', async () => {
    const ev = await alice.signer.signEvent(
      buildIdentities([{ platform: 'github', identity: 'alice', proof: 'abc' }], NOW),
    );
    expect(ev.kind).toBe(10011);
    expect(parseIdentities(ev)).toEqual({
      pubkey: alice.pk,
      createdAt: NOW,
      claims: [{ platform: 'github', identity: 'alice', proof: 'abc' }],
    });
  });

  test('profile', async () => {
    const ev = await alice.signer.signEvent(buildProfile({ name: 'アリス' }, NOW));
    expect(parseProfile(ev)).toEqual({ pubkey: alice.pk, createdAt: NOW, name: 'アリス' });
  });
});

async function signRaw(kind: number, content: string, tags: string[][], signer = alice.signer): Promise<NostrEvent> {
  return signer.signEvent({ kind, content, tags, created_at: NOW });
}

describe('parsers reject malformed events', () => {
  const base = [['t', 'nostr-rating'], ['game', G]];

  test('broken JSON, other game, missing t tag', async () => {
    expect(parseReport(G, await signRaw(KIND.report, '{', [...base, ['e', 'd'.repeat(64)], ['p', bob.pk]]))).toBeNull();
    expect(
      parseReport(G, await signRaw(KIND.report, '{"result":"win"}', [['t', 'nostr-rating'], ['game', 'tekken'], ['e', 'd'.repeat(64)], ['p', bob.pk]])),
    ).toBeNull();
    expect(parseReport(G, await signRaw(KIND.report, '{"result":"win"}', [['game', G], ['e', 'd'.repeat(64)], ['p', bob.pk]]))).toBeNull();
  });

  test('unknown result value', async () => {
    expect(parseReport(G, await signRaw(KIND.report, '{"result":"draw"}', [...base, ['e', 'd'.repeat(64)], ['p', bob.pk]]))).toBeNull();
  });

  test('tampered signature even when the object keeps nostr-tools verified marker', async () => {
    const ev = await bob.signer.signEvent(buildReport(G, { matchId: 'd'.repeat(64), opponent: alice.pk, result: 'lose' }, NOW));
    expect(parseReport(G, { ...ev, content: '{"result":"win"}' })).toBeNull();
  });

  test('match signed by someone other than p1', async () => {
    const tmpl = buildMatch(
      G,
      { p1: alice.pk, p2: bob.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: 'a'.repeat(64), p2SettingsId: 'b'.repeat(64), applicationId: 'c'.repeat(64) },
      NOW,
    );
    expect(parseMatch(G, await bob.signer.signEvent(tmpl))).toBeNull();
  });

  test('match whose p tags do not name both players', async () => {
    const tmpl = buildMatch(
      G,
      { p1: alice.pk, p2: bob.pk, p1Fighter: 'mario', p2Fighter: 'fox', p1SettingsId: 'a'.repeat(64), p2SettingsId: 'b'.repeat(64), applicationId: 'c'.repeat(64) },
      NOW,
    );
    const hidden = { ...tmpl, tags: tmpl.tags.filter((t) => !(t[0] === 'p' && t[1] === bob.pk)) };
    expect(parseMatch(G, await alice.signer.signEvent(hidden))).toBeNull();
  });

  test('wrong kind', async () => {
    expect(parseSettings(G, await signRaw(1, '{}', base))).toBeNull();
  });

  test('settings with non-array bans', async () => {
    const ev = await signRaw(KIND.settings, '{"stageBans":{"mario":"smashville"},"rangeChoice":null,"rematchHours":0}', [
      ...base,
      ['d', 'nostr-rating:smash_sp:settings'],
    ]);
    expect(parseSettings(G, ev)).toBeNull();
  });

  test('null and garbage input do not throw', () => {
    expect(parseMatch(G, null as unknown as NostrEvent)).toBeNull();
    expect(parseIdentities({} as NostrEvent)).toBeNull();
  });
});
