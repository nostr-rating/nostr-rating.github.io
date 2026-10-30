import { initialState, MemoryRelay, verificationText } from '@nostr-rating/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Player } from '../src/pages/Ranking.js';
import { BASE, def, makeDeps, newPlayer, renderWithApp, SNAP_CUTOFF } from './helpers.js';
import { snapshotRoutes } from './snapshot.js';

afterEach(cleanup);
const realNow = () => Math.floor(Date.now() / 1000);

/** old（前のシーズンの成績あり）と me が、同じ GitHub を紐づけたスナップショット */
function routesFor(me: string, old: string, oldOwner: string): Record<string, unknown> {
  const base = initialState(def, 2, SNAP_CUTOFF);
  // 紐づけのあるアカウントは、対戦していなくてもそのシーズンの選手に 0 戦で入る
  const player = { rating: 1500, rd: 350, volatility: 0.06, peakRating: 1500, matches: 0, wins: 0, losses: 0, draws: 0, manners: { noReport: 0, cancel: 0, mismatch: 0 }, lastMatchAt: null, hasIdentity: true };
  const state = {
    ...base,
    players: { [me]: player },
    seasonSummaries: { '1': { [old]: { finalRating: 1712, peakRating: 1780, matches: 30, wins: 20, losses: 10, draws: 0 } } },
    accounts: {
      [old]: { name: 'むかし', claims: [{ platform: 'github' as const, identity: 'Alice', proof: 'aa1' }], eventId: 'e'.repeat(64), createdAt: 1 },
      [me]: { name: 'いま', claims: [{ platform: 'github' as const, identity: 'alice', proof: 'bb2' }], eventId: 'f'.repeat(64), createdAt: 2 },
    },
  };
  const gist = (owner: string, aid: string) => ({ owner: { login: owner }, files: { f: { content: verificationText(aid) } } });
  return {
    ...snapshotRoutes(BASE, 'smash_sp', state, 'snapshots/smash_sp/season_2/x.json'),
    'https://api.github.com/gists/aa1': gist(oldOwner, old),
    'https://api.github.com/gists/bb2': gist('alice', me),
  };
}

describe('linked accounts on the player page', () => {
  test('shows past seasons of an older account that linked the same GitHub account', { timeout: 15_000 }, async () => {
    const relay = new MemoryRelay(realNow);
    const me = await newPlayer(relay, realNow);
    const old = 'a'.repeat(64);
    renderWithApp(<Player pubkey={me.aid} />, { deps: makeDeps({ relay, now: realNow, routes: routesFor(me.aid, old, 'alice') }), account: me.account });
    expect((await screen.findByTestId('linked-accounts', {}, { timeout: 5000 })).textContent).toBe(
      '以前のアカウントの成績シーズン 1: 最終レート 1712（最高 1780）・20勝 10敗（むかし、同じ GitHub: alice を紐づけ）',
    );
  });

  test('does not link an account whose proof is not by the same GitHub user', async () => {
    const relay = new MemoryRelay(realNow);
    const me = await newPlayer(relay, realNow);
    renderWithApp(<Player pubkey={me.aid} />, { deps: makeDeps({ relay, now: realNow, routes: routesFor(me.aid, 'a'.repeat(64), 'mallory') }), account: me.account });
    await new Promise((r) => setTimeout(r, 1500));
    expect(screen.queryByTestId('linked-accounts')).toBeNull();
  });
});
