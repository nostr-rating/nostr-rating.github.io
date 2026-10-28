import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { GameDefinition } from '../game/definition.js';
import { parseClaim } from '../identity/claims.js';
import type { KelRecords } from '../kel/book.js';
import type { RatingState } from '../rating/pipeline.js';
import type { Pubkey } from '../types.js';

export interface SnapshotPlayer {
  rating: number;
  rd: number;
  volatility: number;
  peak_rating: number;
  matches: number;
  wins: number;
  losses: number;
  manners: { no_report: number; cancel: number; mismatch: number };
  last_match_at: number | null;
  has_identity: boolean;
}

/** docs/protocol.md「スナップショット」。キーは snake_case で、JSON とそのまま対応する */
export interface Snapshot {
  schema_version: 2;
  game: string;
  season: number;
  kind: 'rolling' | 'final';
  cutoff: number;
  previous: string | null;
  previous_sha256: string | null;
  /** 計算に使った設定値（ratingConfigHash）。シーズン途中で変わっていないかの確認に使う */
  config_sha256: string;
  inputs: { event_count: number; event_ids_sha256: string };
  /** キーは aid（docs/adr/0008） */
  players: Record<Pubkey, SnapshotPlayer>;
  recent_pairs: { a: Pubkey; b: Pubkey; settled_at: number }[];
  /** シーズン id → aid → 成績 */
  season_summaries: Record<string, Record<Pubkey, SnapshotSeasonSummary>>;
  /** aid → 採用した KEL（sn の順）。全員の「先に見た版」になる */
  kels: KelRecords;
  /** 取り切れなかったので、この回はイベントを無視したアカウント（作り直して確かめるときに使う） */
  excluded: Pubkey[];
  /** aid → 最新のアカウントの公開情報 */
  accounts: Record<Pubkey, { name: string; claims: { platform: string; identity: string; proof: string }[]; event_id: string; created_at: number }>;
}

export interface SnapshotSeasonSummary {
  final_rating: number;
  peak_rating: number;
  matches: number;
  wins: number;
  losses: number;
}

export interface LatestPointer {
  path: string;
  sha256: string;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function eventIdsHash(ids: string[]): string {
  return sha256Hex([...ids].sort().join('\n'));
}

export function stateToSnapshot(
  state: RatingState,
  meta: {
    game: string;
    previous: string | null;
    previousSha256: string | null;
    eventIds: string[];
    configSha256: string;
    kind?: Snapshot['kind'];
    excluded?: Pubkey[];
  },
): Snapshot {
  const players: Record<Pubkey, SnapshotPlayer> = {};
  for (const [pk, p] of Object.entries(state.players)) {
    players[pk] = {
      rating: p.rating,
      rd: p.rd,
      volatility: p.volatility,
      peak_rating: p.peakRating,
      matches: p.matches,
      wins: p.wins,
      losses: p.losses,
      manners: { no_report: p.manners.noReport, cancel: p.manners.cancel, mismatch: p.manners.mismatch },
      last_match_at: p.lastMatchAt,
      has_identity: p.hasIdentity,
    };
  }
  return {
    schema_version: 2,
    game: meta.game,
    season: state.season,
    kind: meta.kind ?? 'rolling',
    cutoff: state.cutoff,
    previous: meta.previous,
    previous_sha256: meta.previousSha256,
    config_sha256: meta.configSha256,
    inputs: { event_count: meta.eventIds.length, event_ids_sha256: eventIdsHash(meta.eventIds) },
    players,
    recent_pairs: state.recentPairs.map((p) => ({ a: p.a, b: p.b, settled_at: p.settledAt })),
    season_summaries: Object.fromEntries(
      Object.entries(state.seasonSummaries).map(([season, players]) => [
        season,
        Object.fromEntries(
          Object.entries(players).map(([pk, x]) => [
            pk,
            { final_rating: x.finalRating, peak_rating: x.peakRating, matches: x.matches, wins: x.wins, losses: x.losses },
          ]),
        ),
      ]),
    ),
    kels: state.kels,
    excluded: [...(meta.excluded ?? [])].sort(),
    accounts: Object.fromEntries(
      Object.entries(state.accounts).map(([aid, a]) => [aid, { name: a.name, claims: a.claims, event_id: a.eventId, created_at: a.createdAt }]),
    ),
  };
}

export function snapshotToState(s: Snapshot): RatingState {
  const players: RatingState['players'] = {};
  for (const [pk, p] of Object.entries(s.players)) {
    players[pk] = {
      rating: p.rating,
      rd: p.rd,
      volatility: p.volatility,
      peakRating: p.peak_rating,
      matches: p.matches,
      wins: p.wins,
      losses: p.losses,
      manners: { noReport: p.manners.no_report, cancel: p.manners.cancel, mismatch: p.manners.mismatch },
      lastMatchAt: p.last_match_at,
      hasIdentity: p.has_identity,
    };
  }
  return {
    season: s.season,
    cutoff: s.cutoff,
    players,
    recentPairs: s.recent_pairs.map((p) => ({ a: p.a, b: p.b, settledAt: p.settled_at })),
    seasonSummaries: Object.fromEntries(
      Object.entries(s.season_summaries ?? {}).map(([season, players]) => [
        season,
        Object.fromEntries(
          Object.entries(players).map(([pk, x]) => [
            pk,
            { finalRating: x.final_rating, peakRating: x.peak_rating, matches: x.matches, wins: x.wins, losses: x.losses },
          ]),
        ),
      ]),
    ),
    kels: s.kels ?? {},
    accounts: Object.fromEntries(
      Object.entries(s.accounts ?? {}).map(([aid, a]) => [
        aid,
        { name: a.name, claims: a.claims.map((c) => parseClaim(c)).filter((c) => c !== null), eventId: a.event_id, createdAt: a.created_at },
      ]),
    ),
  };
}

/** レート計算の結果を左右する設定値だけのハッシュ（表示名などの変更では変わらない） */
export function ratingConfigHash(def: GameDefinition): string {
  return sha256Hex(
    JSON.stringify(
      sortKeys({
        id: def.id,
        rating: def.rating,
        rematchWeight: def.rematchWeight,
        report: def.report,
        applicationTimeoutSec: def.matching.applicationTimeoutSec,
        rematchHourChoices: def.matching.rematchHourChoices,
        seasons: def.seasons,
      }),
    ),
  );
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** 誰が生成しても同じバイト列になる正規化 JSON（キー昇順、2スペース、末尾改行1つ） */
export function serializeSnapshot(s: Snapshot): string {
  return `${JSON.stringify(sortKeys(s), null, 2)}\n`;
}
