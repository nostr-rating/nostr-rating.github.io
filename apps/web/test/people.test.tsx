import { initialState, KIND, MemoryRelay, type Filter } from '@nostr-rating/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Ranking } from '../src/pages/Ranking.js';
import { BASE, def, makeDeps, newPlayer, renderWithApp, SNAP_CUTOFF } from './helpers.js';
import { snapshotRoutes } from './snapshot.js';

afterEach(cleanup);
const realNow = () => Math.floor(Date.now() / 1000);

describe('names and links of players', () => {
  test('asks relays only for account info newer than the snapshot for players the snapshot already has', { timeout: 15_000 }, async () => {
    const relay = new MemoryRelay(realNow);
    const me = await newPlayer(relay, realNow);
    const known = 'a'.repeat(64);
    const player = { rating: 1600, rd: 200, volatility: 0.06, peakRating: 1600, matches: 3, wins: 2, losses: 1, draws: 0, manners: { noReport: 0, cancel: 0, mismatch: 0 }, lastMatchAt: 1, hasIdentity: true };
    const state = {
      ...initialState(def, 2, SNAP_CUTOFF),
      players: { [known]: player },
      accounts: { [known]: { name: 'しってる', claims: [{ platform: 'github' as const, identity: 'k', proof: 'p1' }], eventId: 'e'.repeat(64), createdAt: 1 } },
    };
    const query = vi.spyOn(relay, 'query');
    renderWithApp(<Ranking />, { deps: makeDeps({ relay, now: realNow, routes: snapshotRoutes(BASE, 'smash_sp', state, 'snapshots/smash_sp/season_2/x.json') }), account: me.account });
    expect(await screen.findByText('しってる', {}, { timeout: 5000 })).toBeTruthy();
    await vi.waitFor(() => expect(query.mock.calls.some(([fs]) => fs.some((f: Filter) => f['#d']?.includes(known)))).toBe(true));
    const accountFilters = query.mock.calls.flatMap(([fs]) => fs).filter((f: Filter) => f.kinds?.includes(KIND.account) && f['#d']);
    // 同期は1回とは限らないので、どの回の問い合わせもこの形であることを見る
    const forKnown = accountFilters.filter((f) => f['#d']!.includes(known));
    expect(forKnown.length).toBeGreaterThan(0);
    for (const f of forKnown) expect(f).toEqual({ kinds: [KIND.account], '#d': [known], since: SNAP_CUTOFF - def.report.deadlineSec });
    expect(accountFilters.filter((f) => f['#d']!.includes(me.aid)).every((f) => f.since === undefined)).toBe(true);
  });
});
