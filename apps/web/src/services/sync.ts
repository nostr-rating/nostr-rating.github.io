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
  /** latest.json の sha256 → 読んだスナップショット。指す先が同じ間は取り直さない */
  snapshotCache?: Map<string, ClientSnapshot>;
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
    snapshot = deps.snapshotCache?.get(pointer.sha256) ?? (await loadClientSnapshot(fetchFn, base, def.id, pointer));
    deps.snapshotCache?.set(pointer.sha256, snapshot);
  }
  const t = now();
  // スナップショットが前のシーズンのものなら、今のシーズンを初期値から始める（成績のサマリーだけ引き継ぐ）
  const season = currentSeason(def, t) ?? seasonById(def, 1);
  const from = snapshot?.state;
  const start = !from
    ? initialState(def, season.id, season.startsAt)
    : from.season < season.id
      ? initialState(def, season.id, season.startsAt, from.seasonSummaries, {}, from.accounts)
      : from;

  const kels: KelRecords = {};
  const loadKels = async (aids: Pubkey[]): Promise<KelRecords> => {
    const want = aids.filter((aid) => !kels[aid]);
    if (!snapshot || want.length === 0) return {};
    const got = await snapshot.loadKels(want);
    Object.assign(kels, got);
    return got;
  };

  const since = start.cutoff - def.report.deadlineSec;
  let fresh: Awaited<ReturnType<typeof fetchRatingEvents>>['events'] = [];
  try {
    fresh = (await fetchRatingEvents(relay, def, {}, since, t, { loadKels })).events;
  } catch (e) {
    console.warn('relay query failed; using cached events only', e);
  }
  await store.put(fresh);
  // 申し込みは対戦より少し前、公開情報と KEL は古くても有効なので、since で絞らない
  const cached = [
    ...(await store.query({ kinds: [KIND.match, KIND.report], since })),
    ...(await store.query({ kinds: [KIND.application, KIND.account, KIND.kel] })),
  ];
  // 手元のキャッシュにだけあるイベントのアカウントの KEL も読む
  await loadKels([...aidsIn(cached)]);
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

  return { state, shown, snapshotCutoff: from?.cutoff ?? null, loadKels: async (aids) => (snapshot ? snapshot.loadKels(aids) : {}) };
}
