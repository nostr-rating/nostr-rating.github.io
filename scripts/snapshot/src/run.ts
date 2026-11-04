import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  advanceRatings,
  buildSnapshot,
  currentSeason,
  fetchRatingEvents,
  initialState,
  KelBook,
  warmKelSignatures,
  parseGameDefinition,
  ratingConfigHash,
  seasonById,
  serializeToc,
  sha256Hex,
  summarizeSeason,
  type GameDefinition,
  type LatestPointer,
  type RatingState,
  type RelayClient,
  type SnapshotToc,
} from '@nostr-rating/core';
import { latestOf, loadSnapshot, type PartStore } from './parts.js';

export interface RunOptions {
  /** リポジトリのルート（configs/ と snapshots/ がある場所） */
  root: string;
  cutoff: number;
  relay: RelayClient;
  /** 部品の置き場（docs/adr/0011） */
  parts: PartStore;
  game?: string;
  now?: () => number;
}

export interface RunResult {
  path: string;
  toc: SnapshotToc;
  /** この回の部品を置くリリースのタグ */
  release: string;
  /** そのリリースに新しく上げる部品の数 */
  uploads: number;
}

/** cutoff の JST の日付（YYYY-MM-DD） */
function jstDate(unix: number): string {
  return new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

/** 目次のパスから決まるリリースのタグ（snapshots/smash_sp/season_1/2026-10-02.json → snapshot-smash_sp-season_1-2026-10-02） */
export const releaseOf = (path: string) => `snapshot-${path.replace(/^snapshots\//, '').replace(/\.json$/, '').replaceAll('/', '-')}`;

/**
 * スナップショットは取りこぼしが永久に残るので、アカウントごとに取り切る。
 * 取り切れなかったアカウントは、その回は報告と公開情報を使わずに対戦を相手の報告に合わせて確定し、スナップショットに残す
 */
async function advance(def: GameDefinition, relay: RelayClient, prev: RatingState, cutoff: number) {
  // 前回のスナップショットの KEL は信じずに、1回の実行で全員分を1回だけ確かめる（docs/adr/0011）
  await warmKelSignatures(prev.kels, Object.keys(prev.kels));
  new KelBook(prev.kels, -Infinity, Infinity).verifyRecorded();
  const { events, incomplete, incompleteKel } = await fetchRatingEvents(relay, def, prev.kels, prev.cutoff - def.report.deadlineSec, cutoff, { strict: true });
  const excluded = [...incomplete].sort();
  return { ...advanceRatings(def, prev, events, cutoff, { exclude: incomplete, excludeKel: incompleteKel }), excluded };
}

/** 部品を先に置いてから、目次と latest.json を書く */
function write(root: string, parts: PartStore, path: string, built: ReturnType<typeof buildSnapshot>): RunResult {
  const release = releaseOf(path);
  for (const [sha, text] of built.texts) parts.put(release, sha, text);
  const text = serializeToc(built.toc);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  const pointer: LatestPointer = { path, sha256: sha256Hex(text) };
  writeFileSync(join(root, latestOf(built.toc.game)), `${JSON.stringify(pointer, null, 2)}\n`);
  return { path, toc: built.toc, release, uploads: built.texts.size };
}

/**
 * 前回のスナップショットに続けて、cutoff までに締め切りを迎えた対戦を処理し、
 * 部品を置き場に書き、目次 snapshots/<game>/season_<N>/<日付>.json を書き、latest.json を更新する。
 *
 * 前回のスナップショットが終わったシーズンのものなら、そのシーズンの終わりまでを処理した
 * 最終スナップショット（snapshots/season_<N>/final.json、成績のサマリー付き）だけを書いて止まる。
 * 次の実行から新しいシーズンが始まる。その間にだけ、レート計算に関わる設定を変えてよい。
 */
export async function runSnapshot(opts: RunOptions): Promise<RunResult> {
  const def = parseGameDefinition(
    JSON.parse(readFileSync(join(opts.root, 'configs', `${opts.game ?? 'smash_sp'}.json`), 'utf8')),
  );
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  if (opts.cutoff > now) throw new Error(`cutoff ${opts.cutoff} is in the future; reports may still arrive`);
  const season = currentSeason(def, opts.cutoff);
  if (!season) throw new Error(`cutoff ${opts.cutoff} is before the first season`);

  const loaded = await loadSnapshot(opts.root, def.id, opts.parts);
  const prev = loaded && { state: loaded.state, path: loaded.pointer.path, sha256: loaded.pointer.sha256, configSha256: loaded.toc.config_sha256, kind: loaded.toc.kind };
  const configSha256 = ratingConfigHash(def);
  const meta = (path: string, eventIds: string[], kind: SnapshotToc['kind'], excluded: string[]) => ({
    game: def.id,
    excluded,
    previous: prev?.path ?? null,
    previousSha256: prev?.sha256 ?? null,
    eventIds,
    configSha256,
    kind,
    release: releaseOf(path),
    prevToc: loaded?.toc ?? null,
  });

  if (prev && prev.kind !== 'final' && prev.configSha256 !== configSha256) {
    throw new Error('rating settings in configs changed since the previous snapshot; change them only at a season boundary');
  }

  // 前のシーズンが終わっていれば、まずその最終スナップショットだけを作る
  if (prev && prev.kind !== 'final' && prev.state.season < season.id) {
    const ended = seasonById(def, prev.state.season);
    const { state, usedEventIds, excluded, matches } = await advance(def, opts.relay, prev.state, ended.endsAt);
    const finalState = { ...state, seasonSummaries: summarizeSeason(state) };
    const path = `snapshots/${def.id}/season_${ended.id}/final.json`;
    return write(opts.root, opts.parts, path, buildSnapshot(finalState, { ...meta(path, usedEventIds, 'final', excluded), matches }));
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

  const { state, usedEventIds, excluded, matches } = await advance(def, opts.relay, start, opts.cutoff);
  const path = `snapshots/${def.id}/season_${season.id}/${jstDate(opts.cutoff)}.json`;
  if (prev?.path === path) throw new Error(`${path} is the previous snapshot; use a cutoff on a later date`);
  return write(opts.root, opts.parts, path, buildSnapshot(state, { ...meta(path, usedEventIds, 'rolling', excluded), matches }));
}

/**
 * ゲームごとに run を呼ぶ。1つのゲームが失敗しても、ほかのゲームは続ける（そのゲームの原因が残っても、
 * ほかのゲームのスナップショットが止まらないように）。失敗したゲームとその理由を返す
 */
export async function eachGame(games: string[], run: (game: string) => Promise<void>): Promise<{ game: string; error: unknown }[]> {
  const failed: { game: string; error: unknown }[] = [];
  for (const game of games) {
    try {
      await run(game);
    } catch (error) {
      failed.push({ game, error });
    }
  }
  return failed;
}

/** configs/games.json にあるゲームの id */
export function listGames(root: string): string[] {
  const j = JSON.parse(readFileSync(join(root, 'configs/games.json'), 'utf8')) as { games?: unknown };
  if (!Array.isArray(j.games) || !j.games.every((g) => typeof g === 'string' && /^[a-z0-9_]{1,32}$/.test(g))) {
    throw new Error('configs/games.json must be { "games": ["<id>", ...] }');
  }
  return j.games as string[];
}
