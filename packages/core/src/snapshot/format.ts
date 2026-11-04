import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { GameDefinition } from '../game/definition.js';
import { parseClaim } from '../identity/claims.js';
import type { KelRecords } from '../kel/book.js';
import type { AccountSummary, EvaluatedMatch, RatingState, RatingStep } from '../rating/pipeline.js';
import type { Pubkey } from '../types.js';

export interface SnapshotPlayer {
  rating: number;
  rd: number;
  volatility: number;
  peak_rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  manners: { no_report: number; cancel: number; mismatch: number };
  last_match_at: number | null;
  has_identity: boolean;
}

export interface SnapshotSeasonSummary {
  final_rating: number;
  peak_rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface SnapshotAccount {
  name: string;
  claims: { platform: string; identity: string; proof: string }[];
  event_id: string;
  created_at: number;
}

export interface SnapshotRating {
  rating: number;
  rd: number;
  volatility: number;
}

/** 対戦ごとの記録の、1人分の更新（RatingStep） */
export interface SnapshotRatingStep {
  before: SnapshotRating;
  periods: number;
  after: SnapshotRating;
}

/** 対戦ごとの記録（EvaluatedMatch。docs/adr/0014） */
export interface SnapshotMatch {
  id: string;
  created_at: number;
  p1: Pubkey;
  p2: Pubkey;
  result: EvaluatedMatch['result'];
  missing: Pubkey[];
  rating: { weight: number; p1: SnapshotRatingStep; p2: SnapshotRatingStep } | null;
}

/** この回に評価した対戦の記録。評価した順（マッチの (created_at, id) の昇順） */
export interface MatchesPart {
  matches: SnapshotMatch[];
}

/** リリースに置いた部品（docs/adr/0011）。リリースの中の名前は `<sha256>.json` */
export interface PartRef {
  sha256: string;
  /** バイト数 */
  size: number;
  /** 部品を置いたリリースのタグ。前の回と同じ部品は、最初に置いたリリースを指したままにする */
  release: string;
}

/** 配信のときに kels の部品から作り直す部品。リリースには置かない */
export interface DerivedRef {
  sha256: string;
  size: number;
}

/** docs/spec.md「スナップショット」の目次。キーは snake_case で、JSON とそのまま対応する */
export interface SnapshotToc {
  schema_version: 3;
  game: string;
  season: number;
  kind: 'rolling' | 'final';
  cutoff: number;
  previous: string | null;
  previous_sha256: string | null;
  /** 計算に使った設定値（ratingConfigHash）。シーズン途中で変わっていないかの確認に使う */
  config_sha256: string;
  inputs: { event_count: number; event_ids_sha256: string };
  /** 取り切れなかったので、この回はイベントを無視したアカウント（作り直して確かめるときに使う） */
  excluded: Pubkey[];
  parts: {
    /** PlayersPart */
    players: PartRef;
    /** aid の先頭1文字 → その aid たちの最新のアカウントの公開情報（aid → SnapshotAccount） */
    accounts: Record<string, PartRef>;
    /** aid の先頭1文字 → その aid たちの採用した KEL（aid → sn の順の KEL）。全員の「先に見た版」になる */
    kels: Record<string, PartRef>;
    /** この回に使ったイベントの id（昇順） */
    ids: PartRef;
    /** シーズン id → SeasonPart。終わったシーズンの部品は、それ以後変わらない */
    seasons: Record<string, PartRef>;
    /** MatchesPart。この部品を作る前の目次には無い */
    matches?: PartRef;
  };
  /** KelIndexPart */
  kel_index: DerivedRef;
}

/** そのシーズンの選手。クライアントは同期のたびにこれを読む */
export interface PlayersPart {
  /** キーは aid（docs/adr/0008） */
  players: Record<Pubkey, SnapshotPlayer>;
  recent_pairs: { a: Pubkey; b: Pubkey; settled_at: number }[];
  /** 選手の公開情報（ある人だけ） */
  accounts: Record<Pubkey, SnapshotAccount>;
  /** 選手の KEL の部品の sha256 */
  kels: Record<Pubkey, string>;
}

/** 終わったシーズンの成績と、その時点の選手の公開情報 */
export interface SeasonPart {
  summaries: Record<Pubkey, SnapshotSeasonSummary>;
  accounts: Record<Pubkey, SnapshotAccount>;
}

/** aid の先頭2文字 → KelPrefixPart */
export type KelIndexPart = Record<string, DerivedRef>;
/** aid → KEL の部品の sha256 */
export type KelPrefixPart = Record<Pubkey, string>;

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

/** レート計算の結果を左右する設定値だけのハッシュ（表示名などの変更では変わらない） */
export function ratingConfigHash(def: GameDefinition): string {
  return sha256Hex(
    JSON.stringify(
      sortKeys({
        id: def.id,
        rating: def.rating,
        rematchWeight: def.rematchWeight,
        report: def.report,
        results: def.results,
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

/** 誰が生成しても同じバイト列になる正規化 JSON（キー昇順、2スペース、末尾改行1つ）。目次はリポジトリで差分を読むのでこの形にする */
export function serializeToc(toc: SnapshotToc): string {
  return `${JSON.stringify(sortKeys(toc), null, 2)}\n`;
}

/** 部品の正規化 JSON（キー昇順、空白なし、末尾改行1つ） */
export function serializePart(v: unknown): string {
  return `${JSON.stringify(sortKeys(v))}\n`;
}

const refOf = (text: string) => ({ sha256: sha256Hex(text), size: utf8ToBytes(text).length });

/** 配信での部品の置き場所。名前が sha256 なので、ゲームの間で同じ部品（同じ KEL など）は1つにまとまる */
export const partPath = (sha256: string) => `snapshots/parts/${sha256}.json`;

/** 公開情報と KEL の部品を分ける単位（aid の先頭1文字）。1つの部品が大きくなりすぎないように分ける */
export const bulkShard = (aid: Pubkey) => aid.slice(0, 1);

function shards<T>(records: Record<Pubkey, T>): Map<string, Record<Pubkey, T>> {
  const out = new Map<string, Record<Pubkey, T>>();
  for (const aid of Object.keys(records).sort()) {
    const k = bulkShard(aid);
    const part = out.get(k) ?? {};
    part[aid] = records[aid]!;
    out.set(k, part);
  }
  return out;
}

/** KEL の索引を分ける単位（aid の先頭2文字） */
export const kelPrefix = (aid: Pubkey) => aid.slice(0, 2);

const toAccount = (a: AccountSummary): SnapshotAccount => ({ name: a.name, claims: a.claims, event_id: a.eventId, created_at: a.createdAt });
const fromAccount = (a: SnapshotAccount): AccountSummary => ({
  name: a.name,
  claims: a.claims.map((c) => parseClaim(c)).filter((c) => c !== null),
  eventId: a.event_id,
  createdAt: a.created_at,
});

function accountsOf(state: RatingState, aids: Iterable<Pubkey>): Record<Pubkey, SnapshotAccount> {
  const out: Record<Pubkey, SnapshotAccount> = {};
  for (const aid of aids) {
    const a = state.accounts[aid];
    if (a) out[aid] = toAccount(a);
  }
  return out;
}

/** KEL ごとの部品と、その索引（配信用）。誰が作っても同じバイト列になる */
export function kelParts(kels: KelRecords): { index: DerivedRef; kelSha: Map<Pubkey, string>; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const kelSha = new Map<Pubkey, string>();
  const prefixes = new Map<string, KelPrefixPart>();
  for (const [aid, kel] of Object.entries(kels)) {
    const text = serializePart(kel);
    const sha = sha256Hex(text);
    texts.set(sha, text);
    kelSha.set(aid, sha);
    const p = prefixes.get(kelPrefix(aid)) ?? {};
    p[aid] = sha;
    prefixes.set(kelPrefix(aid), p);
  }
  const index: KelIndexPart = {};
  for (const [prefix, part] of prefixes) {
    const text = serializePart(part);
    texts.set(sha256Hex(text), text);
    index[prefix] = refOf(text);
  }
  const text = serializePart(index);
  texts.set(sha256Hex(text), text);
  return { index: refOf(text), kelSha, texts };
}

/**
 * 状態から目次と部品を作る（docs/adr/0011）。texts は、この回に新しくリリースへ置く部品（sha256 → 本文）。
 * 前の回の目次と同じ部品は、前のリリースを指したままにする。終わったシーズンの部品は、前の目次にあればそのまま使う
 */
export function buildSnapshot(
  state: RatingState,
  meta: {
    game: string;
    previous: string | null;
    previousSha256: string | null;
    eventIds: string[];
    configSha256: string;
    kind?: SnapshotToc['kind'];
    excluded?: Pubkey[];
    /** この回の部品を置くリリースのタグ */
    release: string;
    prevToc?: SnapshotToc | null;
    /** この回に評価した対戦（advanceRatings の matches） */
    matches?: EvaluatedMatch[];
  },
): { toc: SnapshotToc; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const prev = meta.prevToc?.parts;
  const put = (text: string, before: PartRef | undefined): PartRef => {
    const ref = refOf(text);
    if (before?.sha256 === ref.sha256) return before;
    texts.set(ref.sha256, text);
    return { ...ref, release: meta.release };
  };
  const putShards = <T>(records: Record<Pubkey, T>, before: Record<string, PartRef> | undefined): Record<string, PartRef> =>
    Object.fromEntries([...shards(records)].map(([k, part]) => [k, put(serializePart(part), before?.[k])]));

  const kel = kelParts(state.kels);
  const aids = Object.keys(state.players);
  const players: PlayersPart = {
    players: Object.fromEntries(Object.entries(state.players).map(([pk, p]) => [pk, toPlayer(p)])),
    recent_pairs: state.recentPairs.map((p) => ({ a: p.a, b: p.b, settled_at: p.settledAt })),
    accounts: accountsOf(state, aids),
    kels: Object.fromEntries(aids.filter((aid) => kel.kelSha.has(aid)).map((aid) => [aid, kel.kelSha.get(aid)!])),
  };
  const seasons: Record<string, PartRef> = {};
  for (const [season, summaries] of Object.entries(state.seasonSummaries)) {
    const before = prev?.seasons[season];
    if (before) {
      seasons[season] = before;
      continue;
    }
    const part: SeasonPart = {
      summaries: Object.fromEntries(Object.entries(summaries).map(([pk, x]) => [pk, toSummary(x)])),
      accounts: accountsOf(state, Object.keys(summaries)),
    };
    seasons[season] = put(serializePart(part), undefined);
  }
  const ids = [...meta.eventIds].sort();
  const toc: SnapshotToc = {
    schema_version: 3,
    game: meta.game,
    season: state.season,
    kind: meta.kind ?? 'rolling',
    cutoff: state.cutoff,
    previous: meta.previous,
    previous_sha256: meta.previousSha256,
    config_sha256: meta.configSha256,
    inputs: { event_count: ids.length, event_ids_sha256: eventIdsHash(ids) },
    excluded: [...(meta.excluded ?? [])].sort(),
    parts: {
      players: put(serializePart(players), prev?.players),
      accounts: putShards(accountsOf(state, Object.keys(state.accounts)), prev?.accounts),
      kels: putShards(state.kels, prev?.kels),
      ids: put(serializePart(ids), prev?.ids),
      seasons,
      matches: put(serializePart(matchesPart(meta.matches ?? [])), prev?.matches),
    },
    kel_index: kel.index,
  };
  return { toc, texts };
}

const toRating = (p: { rating: number; rd: number; volatility: number }): SnapshotRating => ({ rating: p.rating, rd: p.rd, volatility: p.volatility });
const toStep = (s: RatingStep): SnapshotRatingStep => ({ before: toRating(s.before), periods: s.periods, after: toRating(s.after) });
const fromStep = (s: SnapshotRatingStep): RatingStep => ({ before: toRating(s.before), periods: s.periods, after: toRating(s.after) });

export function matchesPart(matches: EvaluatedMatch[]): MatchesPart {
  return {
    matches: matches.map((m) => ({
      id: m.id,
      created_at: m.createdAt,
      p1: m.p1,
      p2: m.p2,
      result: m.result,
      missing: m.missing,
      rating: m.rating && { weight: m.rating.weight, p1: toStep(m.rating.p1), p2: toStep(m.rating.p2) },
    })),
  };
}

/** 部品の記録を、recomputeRating に渡せる形にする */
export function fromSnapshotMatch(m: SnapshotMatch): EvaluatedMatch {
  return {
    id: m.id,
    createdAt: m.created_at,
    p1: m.p1,
    p2: m.p2,
    result: m.result,
    missing: m.missing,
    rating: m.rating && { weight: m.rating.weight, p1: fromStep(m.rating.p1), p2: fromStep(m.rating.p2) },
  };
}

/**
 * 配信（GitHub Pages）に置く部品（パス → 本文）。クライアントが読む players、シーズン、KEL の索引、KEL ごとの部品と、
 * 誰でも1つの対戦を確かめられるように置く対戦ごとの記録。
 * KEL の索引は kels の部品から作り直し、目次と同じになることを確かめる
 */
export function publishedFiles(
  toc: SnapshotToc,
  bulk: { players: string; seasons: Record<string, string>; kels: KelRecords; matches?: string },
): Map<string, string> {
  const kel = kelParts(bulk.kels);
  if (kel.index.sha256 !== toc.kel_index.sha256) throw new Error('the KELs do not match kel_index in the table of contents');
  const out = new Map<string, string>();
  const texts = [bulk.players, ...Object.values(bulk.seasons), ...kel.texts.values(), ...(bulk.matches === undefined ? [] : [bulk.matches])];
  for (const text of texts) out.set(partPath(sha256Hex(text)), text);
  return out;
}

/**
 * 部品から状態を作る。accounts と kels の部品を渡さないとき（クライアント）は、公開情報はそのシーズンの選手と
 * 終わったシーズンの選手の分だけになり、KEL は空になる（必要な分をあとから読む）
 */
export function stateFromParts(
  toc: SnapshotToc,
  parts: { players: PlayersPart; seasons: Record<string, SeasonPart>; accounts?: Record<Pubkey, SnapshotAccount>; kels?: KelRecords },
): RatingState {
  let accounts = parts.accounts;
  if (!accounts) {
    accounts = {};
    for (const s of Object.keys(parts.seasons).sort((a, b) => Number(a) - Number(b))) Object.assign(accounts, parts.seasons[s]!.accounts);
    Object.assign(accounts, parts.players.accounts);
  }
  return {
    season: toc.season,
    cutoff: toc.cutoff,
    players: Object.fromEntries(Object.entries(parts.players.players).map(([pk, p]) => [pk, fromPlayer(p)])),
    recentPairs: parts.players.recent_pairs.map((p) => ({ a: p.a, b: p.b, settledAt: p.settled_at })),
    seasonSummaries: Object.fromEntries(
      Object.entries(parts.seasons).map(([season, part]) => [season, Object.fromEntries(Object.entries(part.summaries).map(([pk, x]) => [pk, fromSummary(x)]))]),
    ),
    kels: parts.kels ?? {},
    accounts: Object.fromEntries(Object.entries(accounts).map(([aid, a]) => [aid, fromAccount(a)])),
  };
}

type Player = RatingState['players'][string];
type Summary = RatingState['seasonSummaries'][string][string];

const toPlayer = (p: Player): SnapshotPlayer => ({
  rating: p.rating,
  rd: p.rd,
  volatility: p.volatility,
  peak_rating: p.peakRating,
  matches: p.matches,
  wins: p.wins,
  losses: p.losses,
  draws: p.draws,
  manners: { no_report: p.manners.noReport, cancel: p.manners.cancel, mismatch: p.manners.mismatch },
  last_match_at: p.lastMatchAt,
  has_identity: p.hasIdentity,
});

const fromPlayer = (p: SnapshotPlayer): Player => ({
  rating: p.rating,
  rd: p.rd,
  volatility: p.volatility,
  peakRating: p.peak_rating,
  matches: p.matches,
  wins: p.wins,
  losses: p.losses,
  draws: p.draws,
  manners: { noReport: p.manners.no_report, cancel: p.manners.cancel, mismatch: p.manners.mismatch },
  lastMatchAt: p.last_match_at,
  hasIdentity: p.has_identity,
});

const toSummary = (x: Summary): SnapshotSeasonSummary => ({
  final_rating: x.finalRating,
  peak_rating: x.peakRating,
  matches: x.matches,
  wins: x.wins,
  losses: x.losses,
  draws: x.draws,
});

const fromSummary = (x: SnapshotSeasonSummary): Summary => ({
  finalRating: x.final_rating,
  peakRating: x.peak_rating,
  matches: x.matches,
  wins: x.wins,
  losses: x.losses,
  draws: x.draws,
});
