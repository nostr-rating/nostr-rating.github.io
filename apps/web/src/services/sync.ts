import {
  advanceRatings,
  currentSeason,
  fetchRatingEvents,
  initialState,
  seasonById,
  KIND,
  provisionalRatings,
  sha256Hex,
  snapshotToState,
  type GameDefinition,
  type LatestPointer,
  type RatingState,
  type RelayClient,
  type Snapshot,
} from '@nostr-rating/core';
import type { EventStore } from '../storage/types.js';

export interface SyncDeps {
  def: GameDefinition;
  relay: RelayClient;
  store: EventStore;
  fetchFn: typeof fetch;
  /** snapshots/latest.json を持つ取得元（末尾 /） */
  base: string;
  now: () => number;
}

async function fetchText(fetchFn: typeof fetch, url: string): Promise<string> {
  const res = await fetchFn(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/**
 * 最新スナップショットを取得して sha256 を確かめ、
 * それ以降のイベントをリレーと手元のキャッシュから集めて、現在時刻まで計算を進める。
 * state は締め切りを迎えた対戦までの確定値、shown はそれに締め切り前の確定済み対戦を
 * 上乗せした表示用の値。
 */
export async function syncRatings(
  deps: SyncDeps,
): Promise<{ state: RatingState; shown: RatingState; snapshotCutoff: number }> {
  const { def, relay, store, fetchFn, base, now } = deps;
  const pointer = JSON.parse(await fetchText(fetchFn, `${base}snapshots/latest.json`)) as LatestPointer;
  const text = await fetchText(fetchFn, `${base}${pointer.path}`);
  if (sha256Hex(text) !== pointer.sha256) throw new Error(`sha256 mismatch: ${pointer.path}`);
  const snapshot = JSON.parse(text) as Snapshot;
  const t = now();
  const fromSnapshot = snapshotToState(snapshot);
  // スナップショットが前のシーズンのものなら、今のシーズンを初期値から始める（成績のサマリーだけ引き継ぐ）
  const season = currentSeason(def, t);
  const start =
    season && fromSnapshot.season < season.id
      ? initialState(def, season.id, season.startsAt, fromSnapshot.seasonSummaries)
      : fromSnapshot;

  const since = start.cutoff - def.report.deadlineSec;
  let fresh: Awaited<ReturnType<typeof fetchRatingEvents>> = [];
  try {
    fresh = await fetchRatingEvents(relay, def, since, t, { knownPlayers: Object.keys(start.players) });
  } catch (e) {
    console.warn('relay query failed; using cached events only', e);
  }
  await store.put(fresh);
  // 申し込みは対戦より少し前、NIP-39 は古くても有効なので、どちらも since で絞らない
  const cached = [
    ...(await store.query({ kinds: [KIND.match, KIND.report], since })),
    ...(await store.query({ kinds: [KIND.application, KIND.identities] })),
  ];
  const { state } = advanceRatings(def, start, cached, t);
  const shown = provisionalRatings(def, state, cached, t);

  // 現在と直前のシーズンの生イベントだけを残す
  if (season) {
    const keepFrom = seasonById(def, Math.max(1, season.id - 1)).startsAt;
    await store.purgeBefore(keepFrom, [KIND.match, KIND.report, KIND.application]);
  }

  return { state, shown, snapshotCutoff: fromSnapshot.cutoff };
}
