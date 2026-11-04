import { createNostrRelayClient, initFastVerify } from '@nostr-rating/core';
import { Account } from '../account/account.js';
import { idbKeyStore } from '../account/idb-store.js';
import { openEventStore } from '../storage/db.js';
import type { AppDeps } from '../state/AppContext.js';
import { gameDefinitions, relayUrls, snapshotBase } from './config.js';

/** onInUse: キャッシュから戻ったときに、別のタブが保存先を開いていた（起動のときは StorageInUseError で失敗する） */
export async function boot(onInUse: () => void): Promise<{ deps: AppDeps; account: Account | null }> {
  const [store, urls] = await Promise.all([openEventStore(onInUse), relayUrls(), initFastVerify()]);
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
