import {
  initialState,
  MemoryRelay,
  parseGameDefinition,
  serializeSnapshot,
  sha256Hex,
  stateToSnapshot,
  type Signer,
} from '@nostr-rating/core';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import rawDef from '../../../configs/smash_sp.json';
import { AppProvider, type AppDeps, type SignerKind } from '../src/state/AppContext.js';
import { MemoryEventStore } from '../src/storage/memory.js';

export const def = parseGameDefinition(rawDef);
export const BASE = 'https://example.test/';
export const SNAP_CUTOFF = 1_793_026_800;

export function snapshotRoutes(): Record<string, unknown> {
  const text = serializeSnapshot(
    stateToSnapshot(initialState(def, 1, SNAP_CUTOFF), { game: 'smash_sp', previous: null, previousSha256: null, eventIds: [], configSha256: 'x' }),
  );
  const path = 'snapshots/season_1/2026-10-27.json';
  return {
    [`${BASE}snapshots/latest.json`]: { path, sha256: sha256Hex(text) },
    [`${BASE}${path}`]: text,
  };
}

/** routes の値が文字列ならそのまま、それ以外は JSON で返す */
export function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!(url in routes)) return new Response('not found', { status: 404 });
    const v = routes[url];
    return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
  }) as typeof fetch;
}

export function makeDeps(o: { relay?: MemoryRelay; routes?: Record<string, unknown>; now?: () => number } = {}): AppDeps {
  const now = o.now ?? (() => SNAP_CUTOFF + 3600);
  return {
    def,
    relay: o.relay ?? new MemoryRelay(now),
    store: new MemoryEventStore(),
    // routes は後から追加できるよう、渡されたオブジェクトをそのまま使う
    fetchFn: stubFetch(Object.assign(o.routes ?? {}, snapshotRoutes(), { ...o.routes })),
    snapshotBase: BASE,
    now,
  };
}

export function renderWithApp(
  ui: ReactNode,
  o: { deps?: AppDeps; signer?: { signer: Signer; kind: SignerKind } | null; backedUp?: boolean } = {},
) {
  const deps = o.deps ?? makeDeps();
  return { deps, ...render(<AppProvider deps={deps} initialSigner={o.signer ?? null} initialBackedUp={o.backedUp ?? false}>{ui}</AppProvider>) };
}
