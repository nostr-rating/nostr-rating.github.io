import {
  initialState,
  MemoryRelay,
  parseGameDefinition,
  serializeSnapshot,
  sha256Hex,
  buildAccountInfo,
  buildApplication,
  buildMatch,
  buildSettings,
  parseMatch,
  stateToSnapshot,
  type MatchRecord,
  type IdentityClaim,
  type RelayClient,
} from '@nostr-rating/core';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import rawDef from '../../../configs/smash_sp.json';
import { Account, memoryKeyStore } from '../src/account/account.js';
import { AppProvider, type AppDeps } from '../src/state/AppContext.js';
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
    keyStore: memoryKeyStore(),
  };
}

/**
 * 端末1台のアカウントを作る（WebCrypto の鍵、復活の言葉、今日の使い捨ての鍵）。
 * name か claims を渡すと、アカウントの公開情報も出す
 */
export async function newPlayer(
  relay: RelayClient,
  now: () => number,
  o: { name?: string; claims?: IdentityClaim[]; keepWords?: boolean } = {},
) {
  const keyStore = memoryKeyStore();
  // 1時間前に作ったことにする（テストは少し前の時刻のイベントを作るので、証明書の開始をそれより前にする）
  let offset = 3600;
  const clock = () => now() - offset;
  const { account, words } = await Account.create(keyStore, relay, clock, 'テスト端末');
  offset = 0;
  if (!o.keepWords) await account.confirmWords();
  const session = await account.session();
  if (o.claims || o.name) {
    await relay.publish(await session.signer.signEvent(buildAccountInfo('smash_sp', { pubkey: account.aid, name: o.name ?? '', claims: o.claims ?? [] }, now())));
  }
  return { account, keyStore, words, aid: account.aid, signer: session.signer, session };
}

export function renderWithApp(ui: ReactNode, o: { deps?: AppDeps; account?: Account | null } = {}) {
  const deps = o.deps ?? makeDeps();
  return { deps, ...render(<AppProvider deps={deps} initialAccount={o.account ?? null}>{ui}</AppProvider>) };
}

export type Player = Awaited<ReturnType<typeof newPlayer>>;

/** b が a の募集に申し込み、a がマッチを出した対戦（双方の対戦設定つき） */
export async function matchBetween(
  relay: RelayClient,
  a: Player,
  b: Player,
  o: { at?: number; bansA?: Record<string, string[]>; bansB?: Record<string, string[]> } = {},
): Promise<MatchRecord> {
  const t = o.at ?? Math.floor(Date.now() / 1000) - 30;
  const [sa, sb] = [await a.signer.getPublicKey(), await b.signer.getPublicKey()];
  const setA = await a.signer.signEvent(buildSettings('smash_sp', { stageBans: (o.bansA ?? { mario: ['final_destination'] }) as never, rangeChoice: null, rematchHours: 0 }, t - 10));
  const setB = await b.signer.signEvent(buildSettings('smash_sp', { stageBans: (o.bansB ?? {}) as never, rangeChoice: null, rematchHours: 0 }, t - 10));
  const app = await b.signer.signEvent(
    buildApplication('smash_sp', { recruiter: a.aid, recruiterSession: sa, firstFighter: 'mario', settingsId: setB.id, rangeChoice: null, rematchHours: 0, waitingSince: t - 5 }, t - 1),
  );
  const mev = await a.signer.signEvent(
    buildMatch('smash_sp', { p1: a.aid, p2: b.aid, p1Fighter: 'fox', p2Fighter: 'mario', p1SettingsId: setA.id, p2SettingsId: setB.id, applicationId: app.id, sessions: [sa, sb] }, t),
  );
  for (const e of [setA, setB, app, mev]) await relay.publish(e);
  return parseMatch('smash_sp', mev, a.aid)!;
}
