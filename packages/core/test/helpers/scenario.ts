import type { NostrEvent } from 'nostr-tools/pure';
import {
  buildApplication,
  buildAccountInfo,
  buildMatch,
  buildReport,
  type ReportResult,
} from '../../src/events/codec.js';
import { newUser } from './keys.js';
import { P1_SEED, P2_SEED, SEED_HASH } from './seeds.js';

export type User = ReturnType<typeof newUser>;

const G = 'smash_sp';
export const DAY = 86400;

export async function identity(u: User, at: number, proof = 'a0'): Promise<NostrEvent> {
  return u.signer.signEvent(buildAccountInfo({ pubkey: u.pk, name: '', claims: [{ platform: 'github', identity: u.pk.slice(0, 8), proof }] }, at));
}

/** p2 が p1 の募集に申し込んだイベント */
export async function application(p1: User, p2: User, at: number, game = G): Promise<NostrEvent> {
  return p2.signer.signEvent(
    buildApplication(
      game,
      { recruiter: p1.pk, recruiterSession: p1.sessionAt(at), firstFighter: 'fox', settingsId: '2'.repeat(64), rangeChoice: null, rematchHours: 0, waitingSince: at - 5, seedHash: SEED_HASH, seed: P2_SEED },
      at,
    ),
  );
}

export async function matchFor(p1: User, p2: User, app: NostrEvent, at: number, game = G): Promise<NostrEvent> {
  return p1.signer.signEvent(
    buildMatch(
      game,
      {
        p1: p1.pk,
        p2: p2.pk,
        p1Fighter: 'mario',
        p2Fighter: 'fox',
        p1SettingsId: '1'.repeat(64),
        p2SettingsId: '2'.repeat(64),
        applicationId: app.id,
        sessions: [p1.sessionAt(at), app.pubkey],
        seed: P1_SEED,
      },
      at,
    ),
  );
}

/** p2 の申し込み（at-1）→ p1 のマッチ（at）→ 双方の報告（at+delay, +1） */
export async function played(
  p1: User,
  p2: User,
  at: number,
  results: [ReportResult | null, ReportResult | null],
  reportDelay = 60,
  game = G,
): Promise<NostrEvent[]> {
  const app = await application(p1, p2, at - 1, game);
  const match = await matchFor(p1, p2, app, at, game);
  const out = [app, match];
  if (results[0]) out.push(await p1.signer.signEvent(buildReport(game, { matchId: match.id, opponent: p2.sessionAt(at), result: results[0] }, at + reportDelay)));
  if (results[1]) out.push(await p2.signer.signEvent(buildReport(game, { matchId: match.id, opponent: p1.sessionAt(at), result: results[1] }, at + reportDelay + 1)));
  return out;
}

/** p1 が勝って双方が報告した対戦 */
export const p1Wins = (p1: User, p2: User, at: number) => played(p1, p2, at, ['win', 'lose']);
