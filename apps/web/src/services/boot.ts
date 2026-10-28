import { createNostrRelayClient } from '@nostr-rating/core';
import { Account } from '../account/account.js';
import { idbKeyStore } from '../account/idb-store.js';
import { openEventStore } from '../storage/db.js';
import type { AppDeps } from '../state/AppContext.js';
import { gameDefinitions, relayUrls, snapshotBase } from './config.js';

export async function boot(): Promise<{ deps: AppDeps; account: Account | null }> {
  const [store, urls] = await Promise.all([openEventStore(), relayUrls()]);
  const deps: AppDeps = {
    games: gameDefinitions(),
    relay: createNostrRelayClient(urls),
    store,
    fetchFn: fetch.bind(globalThis),
    snapshotBase: snapshotBase(),
    now: () => Math.floor(Date.now() / 1000),
    keyStore: idbKeyStore,
  };
  return { deps, account: await Account.load(deps.keyStore, deps.relay, deps.now) };
}
