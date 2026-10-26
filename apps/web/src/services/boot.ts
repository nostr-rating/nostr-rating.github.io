import { createNostrRelayClient } from '@nostr-rating/core';
import { openEventStore } from '../storage/db.js';
import type { AppDeps, SignerKind } from '../state/AppContext.js';
import { gameDefinition, relayUrls, snapshotBase } from './config.js';
import { isBackedUp, loadLocalSigner } from './signer-local.js';
import { nip07Signer } from './signer-nip07.js';
import type { Signer } from '@nostr-rating/core';

const SIGNER_KIND_KEY = 'nostr-rating:signer';

export function rememberSignerKind(kind: SignerKind | null): void {
  try {
    if (kind) localStorage.setItem(SIGNER_KIND_KEY, kind);
    else localStorage.removeItem(SIGNER_KIND_KEY);
  } catch {
    // 保存できなければ次回もアプリ内鍵を探す
  }
}

export async function boot(): Promise<{
  deps: AppDeps;
  signer: { signer: Signer; kind: SignerKind } | null;
  backedUp: boolean;
}> {
  const [store, urls] = await Promise.all([openEventStore(), relayUrls()]);
  const deps: AppDeps = {
    def: gameDefinition(),
    relay: createNostrRelayClient(urls),
    store,
    fetchFn: fetch.bind(globalThis),
    snapshotBase: snapshotBase(),
    now: () => Math.floor(Date.now() / 1000),
  };
  let kind: string | null = null;
  try {
    kind = localStorage.getItem(SIGNER_KIND_KEY);
  } catch {
    kind = null;
  }
  const nip07 = kind === 'nip07' ? nip07Signer() : null;
  if (nip07) return { deps, signer: { signer: nip07, kind: 'nip07' }, backedUp: true };
  const local = await loadLocalSigner();
  return { deps, signer: local ? { signer: local, kind: 'local' } : null, backedUp: await isBackedUp() };
}
