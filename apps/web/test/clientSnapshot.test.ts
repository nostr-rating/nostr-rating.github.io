import { initialState, MemoryRelay } from '@nostr-rating/core';
import { describe, expect, test } from 'vitest';
import { fetchLatest, loadClientSnapshot } from '../src/services/snapshot.js';
import { BASE, def, newPlayer, SNAP_CUTOFF, stubFetch } from './helpers.js';
import { snapshotRoutes } from './snapshot.js';

const now = () => SNAP_CUTOFF + 3600;

describe('client snapshot', () => {
  test('reads the KEL index again after a failed read instead of keeping the failure', async () => {
    const p = await newPlayer(new MemoryRelay(now), now);
    // 選手ではないアカウントの KEL は、索引から探す
    const state = { ...initialState(def, 1, SNAP_CUTOFF), kels: { [p.aid]: p.account.kel } };
    const routes = snapshotRoutes(BASE, 'smash_sp', state, 'snapshots/smash_sp/season_1/x.json');
    const ok = stubFetch(routes);
    let failing = false;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => (failing ? new Response('busy', { status: 503 }) : ok(input, init))) as typeof fetch;
    const snapshot = await loadClientSnapshot(fetchFn, BASE, 'smash_sp', (await fetchLatest(fetchFn, BASE, 'smash_sp'))!);
    failing = true;
    await expect(snapshot.loadKels([p.aid])).rejects.toThrow(new Error(`${BASE}snapshots/smash_sp/parts/${JSON.parse(routes[`${BASE}snapshots/smash_sp/season_1/x.json`]!).kel_index.sha256}.json: HTTP 503`));
    failing = false;
    expect(await snapshot.loadKels([p.aid])).toEqual({ [p.aid]: p.account.kel });
  });
});
