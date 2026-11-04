import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildAccountInfo, buildApplication, buildMatch, buildReport, type ReportResult } from '../../src/events/codec.js';
import { parseGameDefinition } from '../../src/game/definition.js';
import { advanceRatings } from '../../src/rating/pipeline.js';
import { newUser } from '../helpers/keys.js';
import { initialState } from '../helpers/state.js';
import { P1_SEED, P2_SEED, SEED_HASH } from '../helpers/seeds.js';

const chess = parseGameDefinition(JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/chess.json'), 'utf8')));
const G = 'chess';
const T0 = 1_790_800_000;
const DAY = 86400;

/** キャラのないゲームの対戦（キャラの欄は空） */
async function game(results: [ReportResult, ReportResult]) {
  const [a, b] = [newUser(), newUser()];
  const claim = (u: typeof a) => u.signer.signEvent(buildAccountInfo({ pubkey: u.pk, name: '', claims: [{ platform: 'github', identity: u.pk.slice(0, 6), proof: 'ab' }] }, T0 - 10));
  const app = await b.signer.signEvent(
    buildApplication(G, { recruiter: a.pk, recruiterSession: a.sessionAt(T0), firstFighter: '', settingsId: '2'.repeat(64), rangeChoice: null, rematchHours: 0, waitingSince: T0 - 5, seedHash: SEED_HASH, seed: P2_SEED }, T0 - 1),
  );
  const m = await a.signer.signEvent(
    buildMatch(G, { p1: a.pk, p2: b.pk, p1Fighter: '', p2Fighter: '', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: app.id, sessions: [a.sessionAt(T0), b.sessionAt(T0)], seed: P1_SEED }, T0),
  );
  const r1 = await a.signer.signEvent(buildReport(G, { matchId: m.id, opponent: b.sessionAt(T0), result: results[0] }, T0 + 60));
  const r2 = await b.signer.signEvent(buildReport(G, { matchId: m.id, opponent: a.sessionAt(T0), result: results[1] }, T0 + 61));
  return { a, b, evs: [await claim(a), await claim(b), app, m, r1, r2] };
}

describe('chess', () => {
  test('a draw moves both ratings toward each other and is counted as a draw', async () => {
    const { a, b, evs } = await game(['draw', 'draw']);
    const { state } = advanceRatings(chess, initialState(chess, 1, T0 - 100), evs, T0 + DAY);
    const [pa, pb] = [state.players[a.pk]!, state.players[b.pk]!];
    expect([pa.matches, pa.wins, pa.losses, pa.draws]).toEqual([1, 0, 0, 1]);
    expect([pb.matches, pb.wins, pb.losses, pb.draws]).toEqual([1, 0, 0, 1]);
    // 同じ初期値どうしの引き分けなので、レートは動かず RD だけが縮む
    expect(pa.rating).toBe(1500);
    expect(pa.rd).toBeLessThan(350);
  });

  test('a win in a game without characters counts like any other', async () => {
    const { a, b, evs } = await game(['win', 'lose']);
    const { state } = advanceRatings(chess, initialState(chess, 1, T0 - 100), evs, T0 + DAY);
    expect(state.players[a.pk]!.wins).toBe(1);
    expect(state.players[b.pk]!.losses).toBe(1);
  });

  test('events of another game are ignored', async () => {
    const { a, evs } = await game(['win', 'lose']);
    const smash = parseGameDefinition(JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/smash_sp.json'), 'utf8')));
    const { state } = advanceRatings(smash, initialState(smash, 1, T0 - 100), evs, T0 + DAY);
    expect(state.players[a.pk]?.matches ?? 0).toBe(0);
  });
});
