import {
  currentSeason,
  initialState,
  KIND,
  Matchmaker,
  parseAccountInfo,
  parseSettings,
  seasonById,
  settingsD,
  toLocalView,
  type DeviceRecord,
  type GameDefinition,
  type IdentityClaim,
  type NostrEvent,
  type LocalView,
  type MatchRecord,
  type Pubkey,
  type RatingState,
  type RelayClient,
  type SearchParams,
  type Settings,
  type Signer,
} from '@nostr-rating/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Account, type KeyStore } from '../account/account.js';
import { Resolver } from '../account/resolver.js';
import { syncRatings } from '../services/sync.js';
import type { EventStore } from '../storage/types.js';

export interface AppDeps {
  def: GameDefinition;
  relay: RelayClient;
  store: EventStore;
  fetchFn: typeof fetch;
  snapshotBase: string;
  now: () => number;
  keyStore: KeyStore;
}

export type SettingsStatus = 'loading' | 'loaded' | 'failed';

export interface SearchState {
  waitingSince: number | null;
  /** 署名や公開の途中も含めて、検索を始めてから終わるまで true */
  busy: boolean;
  error: string | null;
}

export interface AppValue extends AppDeps {
  /** この端末のアカウント。まだなければ null */
  account: Account | null;
  /** アプリのイベントに署名する（使い捨ての鍵＋証明書）。アカウントがなければ null */
  signer: Signer | null;
  /** DM の暗号化と復号に使う使い捨ての鍵（新しい順） */
  sessionSigners: Signer[];
  /** 自分の使い捨ての公開鍵（新しい順）。#p で自分宛てを探すのに使う */
  mySessions: Pubkey[];
  /** 自分の aid */
  pubkey: Pubkey | null;
  setAccount(a: Account | null): Promise<void>;
  /** 他人のイベントを aid に結び付ける（知らないアカウントは KEL を取りに行く） */
  author(ev: NostrEvent): Promise<Pubkey | null>;
  /** 書き写したと確かめていない復活の言葉 */
  pendingWords: string | null;
  confirmWords(): Promise<void>;
  /** 書き写す前の復活の言葉を3枚に分ける（2枚あれば戻せる） */
  splitWords(): Promise<void>;
  /** 有効な端末のうち、利用者がまだ知らないもの */
  unknownDevices: DeviceRecord[];
  acknowledgeDevices(): Promise<void>;
  /** KEL を読み直し、端末の一覧と使い捨ての鍵を新しくする */
  reloadAccount(): Promise<void>;
  /** この端末で続けられない理由（取り消し・期限切れ） */
  accountError: string | null;
  ratings: RatingState;
  view: LocalView;
  syncing: boolean;
  syncError: string | null;
  refresh(): Promise<void>;
  profiles: Record<Pubkey, string>;
  identities: Record<Pubkey, IdentityClaim[]>;
  /** 名前と SNS の主張をリレーから読み込む（初めて見る相手にも使う） */
  loadPeople(pks: Pubkey[]): Promise<void>;
  mySettings: Settings | null;
  settingsStatus: SettingsStatus;
  setMySettings(s: Settings): void;
  activeMatch: MatchRecord | null;
  setActiveMatch(m: MatchRecord | null): void;
  rememberProfile(pk: Pubkey, name: string): void;
  rememberIdentities(pk: Pubkey, claims: IdentityClaim[]): void;
  search: SearchState;
  /** 成立したマッチを返す。やめたときは null */
  startSearch(prepare: () => Promise<SearchParams>): Promise<MatchRecord | null>;
  cancelSearch(): void;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider がありません');
  return v;
}

function emptyState(def: GameDefinition, now: number): RatingState {
  const season = currentSeason(def, now) ?? seasonById(def, 1);
  return initialState(def, season.id, season.startsAt);
}

/** イベントを aid に結び付けてから読む（結び付かないものは捨てる） */
export async function parseEach<T>(app: Pick<AppValue, 'author'>, evs: NostrEvent[], parse: (ev: NostrEvent, by: Pubkey | null) => T | null): Promise<T[]> {
  const out: T[] = [];
  for (const ev of evs) {
    const v = parse(ev, await app.author(ev));
    if (v !== null) out.push(v);
  }
  return out;
}

export function displayName(app: Pick<AppValue, 'profiles'>, pk: Pubkey): string {
  return app.profiles[pk] || `${pk.slice(0, 8)}…`;
}

/** authors に一度に並べる数（大きいとリレーに拒否される） */
const AUTHORS_CHUNK = 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function AppProvider(props: { deps: AppDeps; initialAccount?: Account | null; children: ReactNode }) {
  const { deps } = props;
  const [account, setAccountState] = useState<Account | null>(props.initialAccount ?? null);
  const [session, setSession] = useState<Awaited<ReturnType<Account['session']>> | null>(null);
  const [mySessions, setMySessions] = useState<Pubkey[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [pendingWords, setPendingWords] = useState<string | null>(props.initialAccount?.pendingWords ?? null);
  const [unknownDevices, setUnknownDevices] = useState<DeviceRecord[]>([]);
  const pubkey = account?.aid ?? null;
  const [ratings, setRatings] = useState<RatingState>(() => emptyState(deps.def, deps.now()));
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<Pubkey, string>>({});
  const [identities, setIdentities] = useState<Record<Pubkey, IdentityClaim[]>>({});
  const [mySettings, setMySettings] = useState<Settings | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus>('loading');
  const [activeMatch, setActiveMatch] = useState<MatchRecord | null>(null);
  const [search, setSearch] = useState<SearchState>({ waitingSince: null, busy: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  const resolver = useMemo(() => new Resolver(deps.relay), [deps.relay]);

  /** KEL を読み直し、延長が要れば延長し、今日の使い捨ての鍵を用意する */
  const prepare = useCallback(async (a: Account) => {
    try {
      await a.refreshKel();
      await a.renewIfNeeded();
    } catch (e) {
      // リレーに届かなくても、手元の KEL で続ける
      console.warn('could not refresh the key event log', e);
    }
    resolver.setKnown({ [a.aid]: a.kel });
    setPendingWords(a.pendingWords);
    setUnknownDevices(a.unknownDevices);
    if (!a.active) {
      setSession(null);
      setAccountError('この端末の登録は取り消されたか、期限が切れています。ほかの端末から登録し直すか、復活の言葉で戻してください。');
      return;
    }
    const s = await a.session();
    setSession(s);
    setMySessions(await Promise.all(s.sessionSigners.map((x) => x.getPublicKey())));
    setAccountError(null);
  }, [resolver]);

  useEffect(() => {
    if (account) void prepare(account);
  }, [account, prepare]);

  const setAccount = useCallback(async (a: Account | null) => {
    setAccountState(a);
    if (!a) {
      setSession(null);
      setMySessions([]);
    }
  }, []);

  const reloadAccount = useCallback(async () => {
    if (account) await prepare(account);
  }, [account, prepare]);

  const confirmWords = useCallback(async () => {
    await account?.confirmWords();
    setPendingWords(null);
  }, [account]);

  const splitWords = useCallback(async () => {
    if (!account) return;
    await account.splitWords();
    setPendingWords(account.pendingWords);
  }, [account]);

  const acknowledgeDevices = useCallback(async () => {
    await account?.acknowledgeDevices();
    setUnknownDevices([]);
  }, [account]);

  const loadPeople = useCallback(
    async (pks: Pubkey[]) => {
      const unique = [...new Set(pks)];
      const latest: Record<Pubkey, { at: number; name: string; claims: IdentityClaim[] }> = {};
      for (let i = 0; i < unique.length; i += AUTHORS_CHUNK) {
        const d = unique.slice(i, i + AUTHORS_CHUNK);
        const evs = await deps.relay.query([{ kinds: [KIND.account], '#d': d }]);
        for (const ev of evs) {
          const a = parseAccountInfo(deps.def.id, ev, await resolver.author(ev));
          if (a && (!latest[a.pubkey] || latest[a.pubkey]!.at < a.createdAt)) latest[a.pubkey] = { at: a.createdAt, name: a.name, claims: a.claims };
        }
      }
      const names: Record<Pubkey, string> = {};
      const ids: Record<Pubkey, IdentityClaim[]> = {};
      for (const pk of unique) {
        const a = latest[pk];
        if (a?.name) names[pk] = a.name;
        if (a) ids[pk] = a.claims;
      }
      setProfiles((prev) => ({ ...prev, ...names }));
      // リレーで見つからなかった人は、手元の値（スナップショットの値など）を残す。何もなければ「なし」と分かったことを残す
      setIdentities((prev) => ({ ...Object.fromEntries(unique.map((pk) => [pk, prev[pk] ?? []])), ...prev, ...ids }));
    },
    [deps.def.id, deps.relay, resolver],
  );

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const { shown } = await syncRatings({
        def: deps.def,
        relay: deps.relay,
        store: deps.store,
        fetchFn: deps.fetchFn,
        base: deps.snapshotBase,
        now: deps.now,
      });
      setRatings(shown);
      resolver.setKnown({ ...shown.kels, ...(account ? { [account.aid]: account.kel } : {}) });
      // スナップショットにある名前と紐づけを先に出す（リレーの最新はこのあと読む）
      setProfiles((prev) => ({ ...Object.fromEntries(Object.entries(shown.accounts).filter(([, a]) => a.name).map(([pk, a]) => [pk, a.name])), ...prev }));
      setIdentities((prev) => ({
        ...prev,
        ...Object.fromEntries(Object.entries(shown.accounts).filter(([pk]) => !(prev[pk]?.length)).map(([pk, a]) => [pk, a.claims])),
      }));
      setSyncError(null);
      await loadPeople([...Object.keys(shown.players), ...(pubkey ? [pubkey] : [])]);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
      if (pubkey) await loadPeople([pubkey]).catch(() => undefined);
    } finally {
      setSyncing(false);
    }
  }, [account, deps, loadPeople, pubkey, resolver]);

  useEffect(() => {
    if (!pubkey || mySessions.length === 0) return;
    void refresh();
    setSettingsStatus('loading');
    // 対戦設定は使い捨ての鍵ごとの置き換え可能イベントなので、手元に残した鍵と手元の控えから最新を探す
    void (async () => {
      try {
        const evs = [
          ...(await deps.relay.query([{ kinds: [KIND.settings], authors: mySessions, '#d': [settingsD(deps.def.id)] }])),
          ...(await deps.store.query({ kinds: [KIND.settings] })),
        ];
        const mine: Settings[] = [];
        for (const e of evs) {
          const st = parseSettings(deps.def.id, e, await resolver.author(e));
          if (st && st.pubkey === pubkey) mine.push(st);
        }
        const latest = mine.sort((a, b) => b.createdAt - a.createdAt)[0];
        if (latest) setMySettings(latest);
        setSettingsStatus('loaded');
      } catch {
        setSettingsStatus('failed');
      }
    })();
    // 自分のアカウントか使い捨ての鍵が変わったときだけ読み直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, mySessions.join()]);

  // スマホで画面に戻ったときに、止まっていた間の対戦を読み直す
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && pubkey) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pubkey, refresh]);

  const view = useMemo(() => toLocalView(deps.def, ratings), [deps.def, ratings]);

  const startSearch = useCallback(
    async (prepare: () => Promise<SearchParams>): Promise<MatchRecord | null> => {
      if (!session || abortRef.current) return null;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSearch({ waitingSince: null, busy: true, error: null });
      try {
        const params = await prepare();
        if (ctrl.signal.aborted) return null;
        setSearch({ waitingSince: deps.now(), busy: true, error: null });
        const mm = new Matchmaker({ relay: deps.relay, identity: session.identity, author: resolver.author, def: deps.def, view, now: deps.now, sleep });
        const m = await mm.search(params, ctrl.signal);
        setActiveMatch(m);
        setSearch({ waitingSince: null, busy: false, error: null });
        return m;
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        // やめたあとに新しい検索が始まっていれば、その状態を上書きしない
        if (aborted && abortRef.current !== ctrl) return null;
        setSearch({ waitingSince: null, busy: false, error: aborted ? null : `マッチングに失敗しました: ${e instanceof Error ? e.message : String(e)}` });
        return null;
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [deps, resolver, session, view],
  );

  const cancelSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSearch((s) => ({ ...s, busy: false, waitingSince: null }));
  }, []);

  const value: AppValue = {
    ...deps,
    account,
    signer: session?.signer ?? null,
    sessionSigners: session?.sessionSigners ?? [],
    mySessions,
    pubkey,
    setAccount,
    author: resolver.author,
    pendingWords,
    confirmWords,
    splitWords,
    unknownDevices,
    acknowledgeDevices,
    reloadAccount,
    accountError,
    ratings,
    view,
    syncing,
    syncError,
    refresh,
    profiles,
    identities,
    loadPeople,
    mySettings,
    settingsStatus,
    setMySettings,
    activeMatch,
    setActiveMatch,
    rememberProfile: (pk, name) => setProfiles((prev) => ({ ...prev, [pk]: name })),
    rememberIdentities: (pk, claims) => setIdentities((prev) => ({ ...prev, [pk]: claims })),
    search,
    startSearch,
    cancelSearch,
  };
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
