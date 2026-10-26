import {
  currentSeason,
  initialState,
  KIND,
  Matchmaker,
  parseIdentities,
  parseProfile,
  parseSettings,
  seasonById,
  settingsD,
  toLocalView,
  type GameDefinition,
  type IdentityClaim,
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
import { syncRatings } from '../services/sync.js';
import type { EventStore } from '../storage/types.js';

export interface AppDeps {
  def: GameDefinition;
  relay: RelayClient;
  store: EventStore;
  fetchFn: typeof fetch;
  snapshotBase: string;
  now: () => number;
}

export type SignerKind = 'local' | 'nip07';
export type SettingsStatus = 'loading' | 'loaded' | 'failed';

export interface SearchState {
  waitingSince: number | null;
  /** 署名や公開の途中も含めて、検索を始めてから終わるまで true */
  busy: boolean;
  error: string | null;
}

export interface AppValue extends AppDeps {
  signer: Signer | null;
  signerKind: SignerKind | null;
  pubkey: Pubkey | null;
  setSigner(s: Signer | null, kind: SignerKind | null): Promise<void>;
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
  backedUp: boolean;
  setBackedUp(v: boolean): void;
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

export function displayName(app: Pick<AppValue, 'profiles'>, pk: Pubkey): string {
  return app.profiles[pk] || `${pk.slice(0, 8)}…`;
}

/** authors に一度に並べる数（大きいとリレーに拒否される） */
const AUTHORS_CHUNK = 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function AppProvider(props: {
  deps: AppDeps;
  initialSigner?: { signer: Signer; kind: SignerKind } | null;
  initialBackedUp?: boolean;
  children: ReactNode;
}) {
  const { deps } = props;
  const [signer, setSignerState] = useState<Signer | null>(props.initialSigner?.signer ?? null);
  const [signerKind, setSignerKind] = useState<SignerKind | null>(props.initialSigner?.kind ?? null);
  const [pubkey, setPubkey] = useState<Pubkey | null>(null);
  const [ratings, setRatings] = useState<RatingState>(() => emptyState(deps.def, deps.now()));
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<Pubkey, string>>({});
  const [identities, setIdentities] = useState<Record<Pubkey, IdentityClaim[]>>({});
  const [mySettings, setMySettings] = useState<Settings | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus>('loading');
  const [activeMatch, setActiveMatch] = useState<MatchRecord | null>(null);
  const [backedUp, setBackedUp] = useState(props.initialBackedUp ?? false);
  const [search, setSearch] = useState<SearchState>({ waitingSince: null, busy: false, error: null });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    (signer?.getPublicKey() ?? Promise.resolve(null)).then(
      (pk) => alive && setPubkey(pk),
      () => alive && setPubkey(null),
    );
    return () => {
      alive = false;
    };
  }, [signer]);

  const setSigner = useCallback(async (s: Signer | null, kind: SignerKind | null) => {
    const pk = s ? await s.getPublicKey() : null;
    setSignerState(s);
    setSignerKind(kind);
    setPubkey(pk);
  }, []);

  const loadPeople = useCallback(
    async (pks: Pubkey[]) => {
      const unique = [...new Set(pks)];
      const names: Record<Pubkey, string> = {};
      const ids: Record<Pubkey, IdentityClaim[]> = {};
      for (let i = 0; i < unique.length; i += AUTHORS_CHUNK) {
        const authors = unique.slice(i, i + AUTHORS_CHUNK);
        const evs = await deps.relay.query([{ kinds: [KIND.profile, KIND.identities], authors }]);
        for (const ev of [...evs].sort((a, b) => b.created_at - a.created_at)) {
          const p = parseProfile(ev);
          if (p && !(p.pubkey in names)) names[p.pubkey] = p.name;
          const c = parseIdentities(ev);
          if (c && !(c.pubkey in ids)) ids[c.pubkey] = c.claims;
        }
        // 主張が1つもない人は「なし」と分かったことを残す
        for (const pk of authors) ids[pk] ??= [];
      }
      setProfiles((prev) => ({ ...prev, ...names }));
      setIdentities((prev) => ({ ...prev, ...ids }));
    },
    [deps.relay],
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
      setSyncError(null);
      await loadPeople([...Object.keys(shown.players), ...(pubkey ? [pubkey] : [])]);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
      if (pubkey) await loadPeople([pubkey]).catch(() => undefined);
    } finally {
      setSyncing(false);
    }
  }, [deps, loadPeople, pubkey]);

  useEffect(() => {
    if (!pubkey) return;
    void refresh();
    setSettingsStatus('loading');
    deps.relay
      .query([{ kinds: [KIND.settings], authors: [pubkey], '#d': [settingsD(deps.def.id)] }])
      .then((evs) => {
        const latest = evs
          .map((e) => parseSettings(deps.def.id, e))
          .filter((s): s is Settings => s !== null && s.pubkey === pubkey)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (latest) setMySettings(latest);
        setSettingsStatus('loaded');
      })
      .catch(() => setSettingsStatus('failed'));
    // pubkey が変わったときだけ読み直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey]);

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
      if (!signer || abortRef.current) return null;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSearch({ waitingSince: null, busy: true, error: null });
      try {
        const params = await prepare();
        if (ctrl.signal.aborted) return null;
        setSearch({ waitingSince: deps.now(), busy: true, error: null });
        const mm = new Matchmaker({ relay: deps.relay, signer, def: deps.def, view, now: deps.now, sleep });
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
    [deps, signer, view],
  );

  const cancelSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSearch((s) => ({ ...s, busy: false, waitingSince: null }));
  }, []);

  const value: AppValue = {
    ...deps,
    signer,
    signerKind,
    pubkey,
    setSigner,
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
    backedUp,
    setBackedUp,
    rememberProfile: (pk, name) => setProfiles((prev) => ({ ...prev, [pk]: name })),
    rememberIdentities: (pk, claims) => setIdentities((prev) => ({ ...prev, [pk]: claims })),
    search,
    startSearch,
    cancelSearch,
  };
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
