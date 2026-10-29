import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  advanceRatings,
  currentSeason,
  fetchRatingEvents,
  initialState,
  KelBook,
  parseGameDefinition,
  ratingConfigHash,
  seasonById,
  serializeSnapshot,
  sha256Hex,
  snapshotToState,
  stateToSnapshot,
  summarizeSeason,
  type GameDefinition,
  type LatestPointer,
  type RatingState,
  type RelayClient,
  type Snapshot,
} from '@nostr-rating/core';

export interface RunOptions {
  /** リポジトリのルート（configs/ と snapshots/ がある場所） */
  root: string;
  cutoff: number;
  relay: RelayClient;
  game?: string;
  now?: () => number;
}

/** ゲームごとに snapshots/<game>/ の下に置く（docs/adr/0010） */
const latestOf = (game: string) => `snapshots/${game}/latest.json`;

/** cutoff の JST の日付（YYYY-MM-DD） */
function jstDate(unix: number): string {
  return new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

interface Previous {
  state: RatingState;
  path: string;
  sha256: string;
  configSha256: string;
  kind: Snapshot['kind'];
}

function loadPrevious(root: string, game: string): Previous | null {
  const latestPath = join(root, latestOf(game));
  if (!existsSync(latestPath)) return null;
  const pointer = JSON.parse(readFileSync(latestPath, 'utf8')) as LatestPointer;
  const text = readFileSync(join(root, pointer.path), 'utf8');
  if (sha256Hex(text) !== pointer.sha256) throw new Error(`sha256 mismatch: ${pointer.path} does not match ${latestOf(game)}`);
  const snapshot = JSON.parse(text) as Snapshot;
  return {
    state: snapshotToState(snapshot),
    path: pointer.path,
    sha256: pointer.sha256,
    configSha256: snapshot.config_sha256,
    kind: snapshot.kind,
  };
}

/**
 * スナップショットは取りこぼしが永久に残るので、アカウントごとに取り切る。
 * 取り切れなかったアカウントは、その回は報告と公開情報を使わずに対戦を相手の報告に合わせて確定し、スナップショットに残す
 */
async function advance(def: GameDefinition, relay: RelayClient, prev: RatingState, cutoff: number) {
  // 前回のスナップショットの KEL は信じずに、1回の実行で全員分を1回だけ確かめる（docs/adr/0011）
  new KelBook(prev.kels, -Infinity, Infinity).verifyRecorded();
  const { events, incomplete, incompleteKel } = await fetchRatingEvents(relay, def, prev.kels, prev.cutoff - def.report.deadlineSec, cutoff, { strict: true });
  const excluded = [...incomplete].sort();
  return { ...advanceRatings(def, prev, events, cutoff, { exclude: incomplete, excludeKel: incompleteKel }), excluded };
}

function write(root: string, game: string, path: string, snapshot: Snapshot, usedEventIds: string[]): void {
  const text = serializeSnapshot(snapshot);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  writeFileSync(join(root, path.replace(/\.json$/, '.ids.txt')), usedEventIds.map((id) => `${id}\n`).join(''));
  const pointer: LatestPointer = { path, sha256: sha256Hex(text) };
  writeFileSync(join(root, latestOf(game)), `${JSON.stringify(pointer, null, 2)}\n`);
}

/**
 * 前回のスナップショットに続けて、cutoff までに締め切りを迎えた対戦を処理し、
 * snapshots/season_<N>/<日付>.json と .ids.txt を書き、latest.json を更新する。
 *
 * 前回のスナップショットが終わったシーズンのものなら、そのシーズンの終わりまでを処理した
 * 最終スナップショット（snapshots/season_<N>/final.json、成績のサマリー付き）だけを書いて止まる。
 * 次の実行から新しいシーズンが始まる。その間にだけ、レート計算に関わる設定を変えてよい。
 */
export async function runSnapshot(opts: RunOptions): Promise<{ path: string; snapshot: Snapshot }> {
  const def = parseGameDefinition(
    JSON.parse(readFileSync(join(opts.root, 'configs', `${opts.game ?? 'smash_sp'}.json`), 'utf8')),
  );
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  if (opts.cutoff > now) throw new Error(`cutoff ${opts.cutoff} is in the future; reports may still arrive`);
  const season = currentSeason(def, opts.cutoff);
  if (!season) throw new Error(`cutoff ${opts.cutoff} is before the first season`);

  const prev = loadPrevious(opts.root, def.id);
  const configSha256 = ratingConfigHash(def);
  const meta = (eventIds: string[], kind: Snapshot['kind'], excluded: string[]) => ({
    game: def.id,
    excluded,
    previous: prev?.path ?? null,
    previousSha256: prev?.sha256 ?? null,
    eventIds,
    configSha256,
    kind,
  });

  if (prev && prev.kind !== 'final' && prev.configSha256 !== configSha256) {
    throw new Error('rating settings in configs changed since the previous snapshot; change them only at a season boundary');
  }

  // 前のシーズンが終わっていれば、まずその最終スナップショットだけを作る
  if (prev && prev.kind !== 'final' && prev.state.season < season.id) {
    const ended = seasonById(def, prev.state.season);
    const { state, usedEventIds, excluded } = await advance(def, opts.relay, prev.state, ended.endsAt);
    const finalState = { ...state, seasonSummaries: summarizeSeason(state) };
    const path = `snapshots/${def.id}/season_${ended.id}/final.json`;
    const snapshot = stateToSnapshot(finalState, meta(usedEventIds, 'final', excluded));
    write(opts.root, def.id, path, snapshot, usedEventIds);
    return { path, snapshot };
  }

  let start: RatingState;
  if (!prev) {
    start = initialState(def, season.id, season.startsAt);
  } else if (prev.state.season < season.id) {
    // 新しいシーズンは全員が初期値から。過去のシーズンの成績だけを引き継ぐ
    start = initialState(def, season.id, season.startsAt, prev.state.seasonSummaries, prev.state.kels, prev.state.accounts);
  } else {
    if (prev.state.cutoff >= opts.cutoff) throw new Error(`cutoff must be after the previous one (${prev.state.cutoff})`);
    start = prev.state;
  }

  const { state, usedEventIds, excluded } = await advance(def, opts.relay, start, opts.cutoff);
  const path = `snapshots/${def.id}/season_${season.id}/${jstDate(opts.cutoff)}.json`;
  if (prev?.path === path) throw new Error(`${path} is the previous snapshot; use a cutoff on a later date`);
  const snapshot = stateToSnapshot(state, meta(usedEventIds, 'rolling', excluded));
  write(opts.root, def.id, path, snapshot, usedEventIds);
  return { path, snapshot };
}

/** configs/games.json にあるゲームの id */
export function listGames(root: string): string[] {
  const j = JSON.parse(readFileSync(join(root, 'configs/games.json'), 'utf8')) as { games?: unknown };
  if (!Array.isArray(j.games) || !j.games.every((g) => typeof g === 'string' && /^[a-z0-9_]{1,32}$/.test(g))) {
    throw new Error('configs/games.json must be { "games": ["<id>", ...] }');
  }
  return j.games as string[];
}
