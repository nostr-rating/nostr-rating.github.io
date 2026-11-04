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
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Account, type KeyStore } from '../account/account.js';
import { AUTHORS_CHUNK, Resolver } from '../account/resolver.js';
import { rememberedGame, rememberGame } from '../services/config.js';
import { coalesce } from '../services/coalesce.js';
import type { ClientSnapshot } from '../services/snapshot.js';
import { syncRatings } from '../services/sync.js';
import type { EventStore } from '../storage/types.js';

export interface AppDeps {
  /** 選べるゲーム（一覧の順） */
  games: GameDefinition[];
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
  /** 選んでいるゲーム */
  def: GameDefinition;
  setGame(id: string): void;
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
  /** 今のゲームの最初の同期が終わったか（失敗も含む）。それまでのレートと紐づけは初期値 */
  loaded: boolean;
  syncError: string | null;
  refresh(): Promise<void>;
  profiles: Record<Pubkey, string>;
  identities: Record<Pubkey, IdentityClaim[]>;
  /** 名前と SNS の主張をリレーから読み込む（初めて見る相手にも使う） */
  /** 公開情報をリレーから読む。since を渡すと、それより新しい版だけを聞く */
  loadPeople(pks: Pubkey[], since?: number): Promise<void>;
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

/** 公開情報の問い合わせを同時に流す数 */
const PEOPLE_PARALLEL = 4;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function AppProvider(props: { deps: AppDeps; initialAccount?: Account | null; children: ReactNode }) {
  const { deps } = props;
  const [account, setAccountState] = useState<Account | null>(props.initialAccount ?? null);
  const [session, setSession] = useState<Awaited<ReturnType<Account['session']>> | null>(null);
  const [mySessions, setMySessions] = useState<Pubkey[]>([]);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [unknownDevices, setUnknownDevices] = useState<DeviceRecord[]>([]);
  const pubkey = account?.aid ?? null;
  const [def, setDef] = useState<GameDefinition>(() => rememberedGame(deps.games));
  /** 今のゲーム。切り替える前に始めた読み込みが遅れて終わっても、その結果を捨てるために使う */
  const gameRef = useRef(def.id);
  const [ratings, setRatings] = useState<RatingState>(() => emptyState(def, deps.now()));
  const [syncing, setSyncing] = useState(false);
  const [loadedGame, setLoadedGame] = useState<string | null>(null);
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
    setUnknownDevices(a.unknownDevices);
    if (!a.active) {
      setSession(null);
      setAccountError('この端末の登録は取り消されたか、期限が切れています。ほかの端末から登録し直すか、復活の言葉で復元してください。');
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

  const acknowledgeDevices = useCallback(async () => {
    await account?.acknowledgeDevices();
    setUnknownDevices([]);
  }, [account]);

  const loadPeople = useCallback(
    async (pks: Pubkey[], since?: number) => {
      const unique = [...new Set(pks)];
      const latest: Record<Pubkey, { at: number; name: string; claims: IdentityClaim[] }> = {};
      const chunks: Pubkey[][] = [];
      for (let i = 0; i < unique.length; i += AUTHORS_CHUNK) chunks.push(unique.slice(i, i + AUTHORS_CHUNK));
      // 問い合わせは PEOPLE_PARALLEL 本ずつ並べて流す。結び付けは問い合わせごとにまとめて行う
      for (let i = 0; i < chunks.length; i += PEOPLE_PARALLEL) {
        await Promise.all(
          chunks.slice(i, i + PEOPLE_PARALLEL).map(async (d) => {
            const evs = await deps.relay.query([{ kinds: [KIND.account], '#d': d, ...(since !== undefined ? { since } : {}) }]);
            const authors = await resolver.authorAll(evs);
            for (const [j, ev] of evs.entries()) {
              const a = parseAccountInfo(ev, authors[j]!);
              if (a && (!latest[a.pubkey] || latest[a.pubkey]!.at < a.createdAt)) latest[a.pubkey] = { at: a.createdAt, name: a.name, claims: a.claims };
            }
          }),
        );
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
    [deps.relay, resolver],
  );

  const snapshotCache = useMemo(() => new Map<string, { sha256: string; snapshot: ClientSnapshot }>(), []);
  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const { shown, loadKels, snapshotCutoff } = await syncRatings({
        def,
        relay: deps.relay,
        store: deps.store,
        fetchFn: deps.fetchFn,
        base: deps.snapshotBase,
        now: deps.now,
        snapshotCache,
      });
      if (gameRef.current !== def.id) return;
      setRatings(shown);
      resolver.setKnown({ ...shown.kels, ...(account ? { [account.aid]: account.kel } : {}) }, loadKels);
      // スナップショットにある名前と紐づけを先に出す（リレーの最新はこのあと読む）
      setProfiles((prev) => ({ ...Object.fromEntries(Object.entries(shown.accounts).filter(([, a]) => a.name).map(([pk, a]) => [pk, a.name])), ...prev }));
      setIdentities((prev) => ({
        ...prev,
        ...Object.fromEntries(Object.entries(shown.accounts).filter(([pk]) => !(prev[pk]?.length)).map(([pk, a]) => [pk, a.claims])),
      }));
      setSyncError(null);
      // スナップショットに公開情報がある選手は、それより新しい版だけをリレーに聞く（docs/adr/0011）
      const recorded = Object.keys(shown.players).filter((pk) => shown.accounts[pk] && pk !== pubkey);
      const rest = [...Object.keys(shown.players).filter((pk) => !shown.accounts[pk]), ...(pubkey ? [pubkey] : [])];
      await Promise.all([
        loadPeople(recorded, snapshotCutoff !== null ? snapshotCutoff - def.report.deadlineSec : undefined),
        loadPeople(rest),
      ]);
    } catch (e) {
      if (gameRef.current !== def.id) return;
      setSyncError(e instanceof Error ? e.message : String(e));
      if (pubkey) await loadPeople([pubkey]).catch(() => undefined);
    } finally {
      if (gameRef.current === def.id) {
        setSyncing(false);
        setLoadedGame(def.id);
      }
    }
  }, [account, def, deps, loadPeople, pubkey, resolver, snapshotCache]);
  // 同期はゲームごとに同時に1本だけ走らせ、走っている間に頼まれた分は終わったあとに1回だけ、そのときの値でやり直す。
  // ゲームを切り替えたときは、前のゲームの同期の終わりを待たない（前のゲームの結果は gameRef で捨てる）
  const syncs = useRef(new Map<string, { latest: () => Promise<void>; run: () => Promise<void> }>());
  const slot = syncs.current.get(def.id) ?? { latest: syncNow, run: async () => undefined };
  if (!syncs.current.has(def.id)) {
    slot.run = coalesce(() => slot.latest());
    syncs.current.set(def.id, slot);
  }
  // 最新の syncNow は、確定した render のあとで差し替える（捨てられた render の値を使わない）
  useLayoutEffect(() => {
    slot.latest = syncNow;
  }, [slot, syncNow]);
  const refresh = slot.run;

  useEffect(() => {
    if (!pubkey || mySessions.length === 0) return;
    void refresh();
    setSettingsStatus('loading');
    let alive = true;
    // 対戦設定は使い捨ての鍵ごとの置き換え可能イベントなので、手元に残した鍵と手元の控えから最新を探す
    void (async () => {
      try {
        const evs = [
          ...(await deps.relay.query([{ kinds: [KIND.settings], authors: mySessions, '#d': [settingsD(def.id)] }])),
          ...(await deps.store.query({ kinds: [KIND.settings] })),
        ];
        const mine: Settings[] = [];
        for (const e of evs) {
          const st = parseSettings(def.id, e, await resolver.author(e));
          if (st && st.pubkey === pubkey) mine.push(st);
        }
        const latest = mine.sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!alive) return;
        if (latest) setMySettings(latest);
        setSettingsStatus('loaded');
      } catch {
        if (alive) setSettingsStatus('failed');
      }
    })();
    return () => {
      alive = false;
    };
    // 自分のアカウントか使い捨ての鍵が変わったときだけ読み直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, mySessions.join(), def.id]);

  // スマホで画面に戻ったときに、止まっていた間の対戦を読み直す
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && pubkey) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pubkey, refresh]);

  const view = useMemo(() => toLocalView(def, ratings), [def, ratings]);

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
        const mm = new Matchmaker({ relay: deps.relay, identity: session.identity, author: resolver.author, def, view, now: deps.now, sleep });
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
    [def, deps, resolver, session, view],
  );

  /** ゲームを切り替える。レート・対戦設定・進行中の検索はゲームごとなので、いったん空にする */
  const setGame = useCallback(
    (id: string) => {
      const next = deps.games.find((g) => g.id === id);
      if (!next || next.id === def.id) return;
      abortRef.current?.abort();
      abortRef.current = null;
      setSearch({ waitingSince: null, busy: false, error: null });
      rememberGame(next.id);
      gameRef.current = next.id;
      setDef(next);
      setRatings(emptyState(next, deps.now()));
      setMySettings(null);
      setSettingsStatus('loading');
      setActiveMatch(null);
    },
    [def.id, deps],
  );

  const cancelSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSearch((s) => ({ ...s, busy: false, waitingSince: null }));
  }, []);

  const value: AppValue = {
    ...deps,
    def,
    setGame,
    account,
    signer: session?.signer ?? null,
    sessionSigners: session?.sessionSigners ?? [],
    mySessions,
    pubkey,
    setAccount,
    author: resolver.author,
    unknownDevices,
    acknowledgeDevices,
    reloadAccount,
    accountError,
    ratings,
    view,
    syncing,
    loaded: loadedGame === def.id,
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
