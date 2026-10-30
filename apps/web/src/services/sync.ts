import {
  advanceRatings,
  aidsIn,
  currentSeason,
  fetchRatingEvents,
  initialState,
  seasonById,
  KIND,
  provisionalRatings,
  type GameDefinition,
  type KelRecords,
  type Pubkey,
  type RatingState,
  type RelayClient,
  warmKelSignatures,
} from '@nostr-rating/core';
import type { EventStore } from '../storage/types.js';
import { fetchLatest, loadClientSnapshot, type ClientSnapshot } from './snapshot.js';

export interface SyncDeps {
  def: GameDefinition;
  relay: RelayClient;
  store: EventStore;
  fetchFn: typeof fetch;
  /** snapshots/<game>/latest.json を持つ取得元（末尾 /） */
  base: string;
  now: () => number;
  /** ゲーム → 最後に読んだスナップショットと、それを指した latest.json の sha256。指す先が同じ間は取り直さない */
  snapshotCache?: Map<string, { sha256: string; snapshot: ClientSnapshot }>;
}

/**
 * 最新スナップショットを取得して sha256 を確かめ、
 * それ以降のイベントをリレーと手元のキャッシュから集めて、現在時刻まで計算を進める。
 * スナップショットがまだ無ければ（latest.json が 404）、今のシーズンの最初から計算する。
 * KEL は、イベントに出てきたアカウントの分だけをスナップショットから読む（docs/adr/0011）。
 * state は締め切りを迎えた対戦までの確定値、shown はそれに締め切り前の確定済み対戦を
 * 上乗せした表示用の値。snapshotCutoff はスナップショットが無ければ null。
 * loadKels は、ほかのアカウントの記録済みの KEL をあとから読むのに使う。
 */
export async function syncRatings(
  deps: SyncDeps,
): Promise<{ state: RatingState; shown: RatingState; snapshotCutoff: number | null; loadKels: (aids: Pubkey[]) => Promise<KelRecords> }> {
  const { def, relay, store, fetchFn, base, now } = deps;
  const pointer = await fetchLatest(fetchFn, base, def.id);
  let snapshot: ClientSnapshot | null = null;
  if (pointer) {
    const hit = deps.snapshotCache?.get(def.id);
    snapshot = hit?.sha256 === pointer.sha256 ? hit.snapshot : await loadClientSnapshot(fetchFn, base, def.id, pointer);
    // ゲームごとに最新の1つだけを残す
    deps.snapshotCache?.set(def.id, { sha256: pointer.sha256, snapshot });
  }
  const t = now();
  // スナップショットが前のシーズンのものなら、今のシーズンを初期値から始める（成績のサマリーだけ引き継ぐ）
  const season = currentSeason(def, t) ?? seasonById(def, 1);
  const from = snapshot?.state;
  // 前のシーズンの最終版がまだ無いときは、前のシーズンの最後のスナップショットの時点から計算を始める。
  // シーズンの始まりからにすると、そのあいだの KEL のイベント（端末の追加や入れ替え）を受け付けなくなる
  const start = !from
    ? initialState(def, season.id, season.startsAt)
    : from.season < season.id
      ? initialState(def, season.id, snapshot!.kind === 'final' ? season.startsAt : Math.min(from.cutoff, season.startsAt), from.seasonSummaries, {}, from.accounts)
      : from;

  const kels: KelRecords = {};
  /** スナップショットの部品を読めなかったときの失敗。リレーの失敗とは分けて、同期の失敗にする */
  let partError: unknown = null;
  const loadKels = async (aids: Pubkey[]): Promise<KelRecords> => {
    const want = aids.filter((aid) => !kels[aid]);
    if (!snapshot || want.length === 0) return {};
    try {
      const got = await snapshot.loadKels(want);
      Object.assign(kels, got);
      return got;
    } catch (e) {
      partError ??= e;
      throw e;
    }
  };

  const since = start.cutoff - def.report.deadlineSec;
  let fresh: Awaited<ReturnType<typeof fetchRatingEvents>>['events'] = [];
  try {
    fresh = (await fetchRatingEvents(relay, def, {}, since, t, { loadKels })).events;
  } catch (e) {
    if (partError) throw partError;
    console.warn('relay query failed; using cached events only', e);
  }
  await store.put(fresh);
  // 申し込みは対戦より少し前に出る
  const windowed = [
    ...(await store.query({ kinds: [KIND.match, KIND.report], since })),
    ...(await store.query({ kinds: [KIND.application], since: since - def.matching.applicationTimeoutSec })),
  ];
  // 公開情報と KEL は古くても有効なので since で絞らず、この幅のイベントに出てくるアカウントの分だけを使う
  const active = aidsIn(windowed);
  const lasting = (await store.query({ kinds: [KIND.account, KIND.kel] })).filter((ev) => [...aidsIn([ev])].some((aid) => active.has(aid)));
  const cached = [...windowed, ...lasting];
  // 手元のキャッシュにだけあるイベントのアカウントの KEL も読む
  await loadKels([...active]);
  const withKels = { ...start, kels: { ...start.kels, ...kels } };
  // 計算は同期で KEL を評価するので、出てくるアカウントの署名を先に速い実装で確かめておく
  await warmKelSignatures(withKels.kels, aidsIn(cached), cached);
  const { state } = advanceRatings(def, withKels, cached, t);
  const shown = provisionalRatings(def, state, cached, t);

  // 現在と直前のシーズンの生イベントだけを残す
  if (currentSeason(def, t)) {
    const keepFrom = seasonById(def, Math.max(1, season.id - 1)).startsAt;
    await store.purgeBefore(keepFrom, [KIND.match, KIND.report, KIND.application]);
  }

  return { state, shown, snapshotCutoff: from?.cutoff ?? null, loadKels: snapshot ? snapshot.loadKels : noKels };
}

/** スナップショットが無いときの loadKels。Resolver が同じものかを見分けられるよう、毎回同じ関数を返す */
const noKels = async (): Promise<KelRecords> => ({});
