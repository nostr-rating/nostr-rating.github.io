import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  advanceRatings,
  currentSeason,
  fetchRatingEvents,
  initialState,
  parseGameDefinition,
  ratingConfigHash,
  serializeSnapshot,
  sha256Hex,
  snapshotToState,
  stateToSnapshot,
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

const LATEST = 'snapshots/latest.json';

/** cutoff の JST の日付（YYYY-MM-DD） */
function jstDate(unix: number): string {
  return new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

function loadPrevious(root: string): { state: RatingState; path: string; sha256: string; configSha256: string } | null {
  const latestPath = join(root, LATEST);
  if (!existsSync(latestPath)) return null;
  const pointer = JSON.parse(readFileSync(latestPath, 'utf8')) as LatestPointer;
  const text = readFileSync(join(root, pointer.path), 'utf8');
  if (sha256Hex(text) !== pointer.sha256) throw new Error(`sha256 mismatch: ${pointer.path} does not match ${LATEST}`);
  const snapshot = JSON.parse(text) as Snapshot;
  return { state: snapshotToState(snapshot), path: pointer.path, sha256: pointer.sha256, configSha256: snapshot.config_sha256 };
}

/**
 * 前回のスナップショットに続けて、cutoff までに締め切りを迎えた対戦を処理し、
 * snapshots/season_<N>/<日付>.json と .ids.txt を書き、latest.json を更新する。
 */
export async function runSnapshot(opts: RunOptions): Promise<{ path: string; snapshot: Snapshot }> {
  const def = parseGameDefinition(
    JSON.parse(readFileSync(join(opts.root, 'configs', `${opts.game ?? 'smash_sp'}.json`), 'utf8')),
  );
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  if (opts.cutoff > now) throw new Error(`cutoff ${opts.cutoff} is in the future; reports may still arrive`);
  const season = currentSeason(def, opts.cutoff);
  if (!season) throw new Error(`cutoff ${opts.cutoff} is not inside any season`);

  const prev = loadPrevious(opts.root);
  const configSha256 = ratingConfigHash(def);
  if (prev && prev.state.season !== season.id) throw new Error('season rollover is not supported yet');
  if (prev && prev.configSha256 !== configSha256) {
    throw new Error('rating settings in configs changed since the previous snapshot; change them only at a season boundary');
  }
  if (prev && prev.state.cutoff >= opts.cutoff) throw new Error(`cutoff must be after the previous one (${prev.state.cutoff})`);
  const prevState = prev?.state ?? initialState(def, season.id, season.startsAt);

  // スナップショットは取りこぼしが永久に残るので、プレイヤー1人ずつ問い合わせ、取り切れなければ失敗させる
  const events = await fetchRatingEvents(opts.relay, def, prevState.cutoff - def.report.deadlineSec, opts.cutoff, {
    strict: true,
    knownPlayers: Object.keys(prevState.players),
    authorsPerQuery: 1,
  });
  const { state, usedEventIds } = advanceRatings(def, prevState, events, opts.cutoff);
  const snapshot = stateToSnapshot(state, {
    game: def.id,
    previous: prev?.path ?? null,
    previousSha256: prev?.sha256 ?? null,
    eventIds: usedEventIds,
    configSha256,
  });

  const path = `snapshots/season_${season.id}/${jstDate(opts.cutoff)}.json`;
  if (prev?.path === path) throw new Error(`${path} is the previous snapshot; use a cutoff on a later date`);
  const text = serializeSnapshot(snapshot);
  mkdirSync(dirname(join(opts.root, path)), { recursive: true });
  writeFileSync(join(opts.root, path), text);
  writeFileSync(join(opts.root, path.replace(/\.json$/, '.ids.txt')), usedEventIds.map((id) => `${id}\n`).join(''));
  const pointer: LatestPointer = { path, sha256: sha256Hex(text) };
  writeFileSync(join(opts.root, LATEST), `${JSON.stringify(pointer, null, 2)}\n`);
  return { path, snapshot };
}
