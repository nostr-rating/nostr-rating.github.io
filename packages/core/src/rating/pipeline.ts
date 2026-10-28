import type { NostrEvent } from 'nostr-tools/pure';
import {
  parseAccountInfo,
  parseApplication,
  parseMatch,
  parseReport,
  type AccountInfo,
  type Application,
  type MatchRecord,
  type ResultReport,
} from '../events/codec.js';
import { isValidEvent } from '../events/kinds.js';
import { attributor, buildKelBook, type Attributor, type KelRecords } from '../kel/book.js';
import { seasonById, type GameDefinition } from '../game/definition.js';
import type { LocalView } from '../match/conditions.js';
import { mannersDelta, settleMatch, type MannersCount, type Settlement } from '../match/settle.js';
import { dedupeById } from '../relay/client.js';
import type { Pubkey } from '../types.js';
import { applyWeight, glicko2Update, inflateRd, type PlayerRating } from './glicko2.js';

export interface PlayerState extends PlayerRating {
  peakRating: number;
  matches: number;
  wins: number;
  losses: number;
  manners: MannersCount;
  lastMatchAt: number | null;
  hasIdentity: boolean;
}

export interface RecentPair {
  /** a < b で正規化 */
  a: Pubkey;
  b: Pubkey;
  /** 対戦の作成時刻 */
  settledAt: number;
}

/** 終わったシーズンの成績。生のイベントを消しても過去の成績を見せられるよう、スナップショットに残す */
export interface SeasonSummary {
  finalRating: number;
  peakRating: number;
  matches: number;
  wins: number;
  losses: number;
}

export interface RatingState {
  season: number;
  /** この時刻までに締め切りを迎えた対戦を処理済み */
  cutoff: number;
  players: Record<Pubkey, PlayerState>;
  recentPairs: RecentPair[];
  /** シーズン id → aid → 成績 */
  seasonSummaries: Record<string, Record<Pubkey, SeasonSummary>>;
  /** aid → 採用した KEL（docs/adr/0008）。シーズンをまたいで引き継ぐ */
  kels: KelRecords;
  /** aid → 最新のアカウントの公開情報（表示名と紐づけ）。選手ページと公開 API に使う */
  accounts: Record<Pubkey, AccountSummary>;
}

export interface AccountSummary {
  name: string;
  claims: AccountInfo['claims'];
  eventId: string;
  createdAt: number;
}

export function initialState(
  _def: GameDefinition,
  season: number,
  cutoff: number,
  seasonSummaries: RatingState['seasonSummaries'] = {},
  kels: KelRecords = {},
  accounts: RatingState['accounts'] = {},
): RatingState {
  return { season, cutoff, players: {}, recentPairs: [], seasonSummaries, kels, accounts };
}

/** シーズンを締めくくり、レートを持つプレイヤーの成績をサマリーに加える */
export function summarizeSeason(state: RatingState): RatingState['seasonSummaries'] {
  const summary: Record<Pubkey, SeasonSummary> = {};
  for (const [pk, p] of Object.entries(state.players)) {
    if (p.matches === 0) continue;
    summary[pk] = { finalRating: p.rating, peakRating: p.peakRating, matches: p.matches, wins: p.wins, losses: p.losses };
  }
  return { ...state.seasonSummaries, [String(state.season)]: summary };
}

function initialPlayer(def: GameDefinition): PlayerState {
  return {
    rating: def.rating.initialRating,
    rd: def.rating.initialRd,
    volatility: def.rating.initialVolatility,
    peakRating: def.rating.initialRating,
    matches: 0,
    wins: 0,
    losses: 0,
    manners: { noReport: 0, cancel: 0, mismatch: 0 },
    lastMatchAt: null,
    hasIdentity: false,
  };
}

const pairKey = (x: Pubkey, y: Pubkey): [Pubkey, Pubkey] => (x < y ? [x, y] : [y, x]);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * マッチが、p2 が署名して p1 の募集を指した申し込みに、成立待ちの時間内に応えたものか。
 * レート計算と画面の両方で、第三者が勝手に作った対戦を除くのに使う。
 */
export function isLinkedMatch(def: GameDefinition, m: MatchRecord, app: Application | null | undefined): app is Application {
  if (!app || app.eventId !== m.applicationId) return false;
  const gap = m.createdAt - app.createdAt;
  return (
    app.pubkey === m.p2 &&
    app.recruiter === m.p1 &&
    app.firstFighter === m.p2Fighter &&
    app.settingsId === m.p2SettingsId &&
    gap >= 0 &&
    gap <= def.matching.applicationTimeoutSec
  );
}
const byTimeThenId = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
  a.createdAt - b.createdAt || byId(a.id, b.id);

/** 連戦の重みと「連戦を避ける」設定の両方に使うので、長いほうの期間だけ残す */
function pairRetentionSec(def: GameDefinition): number {
  return Math.max(def.rematchWeight.windowSec, ...def.matching.rematchHourChoices.map((h) => h * 3600));
}

interface Linked {
  match: MatchRecord;
  application: Application;
  reports: ResultReport[];
}

interface Inputs {
  /** aid ごとの、紐づけが1つ以上あるアカウントの公開情報のうち (created_at, id) が最小のもの */
  identities: Map<Pubkey, string>;
  /** p2 の申し込みに結び付いた対戦（作成時刻順） */
  linked: Linked[];
  /** aid ごとの、until 以前で (created_at, id) が最大のアカウントの公開情報 */
  latest: Map<Pubkey, AccountInfo>;
}

/**
 * 署名を確かめてから重複を除き、対戦を申し込みに結び付ける。
 * 対戦が有効なのは、p2 が署名して p1 の募集を指した申し込みに、成立待ちの時間内に応えたものだけ。
 * 1つの申し込みには最小 id の対戦だけを結び付ける。
 */
function collect(def: GameDefinition, season: number, events: NostrEvent[], author: Attributor, until: number): Inputs {
  const unique = dedupeById(events.filter((e) => isValidEvent(e)));
  const { startsAt, endsAt } = seasonById(def, season);

  const identities = new Map<Pubkey, { id: string; createdAt: number }>();
  const latest = new Map<Pubkey, AccountInfo>();
  const applications = new Map<string, Application>();
  const matches: MatchRecord[] = [];
  const reports = new Map<string, ResultReport[]>();
  for (const ev of unique) {
    const by = author(ev);
    if (!by) continue;
    const ids = parseAccountInfo(def.id, ev, by);
    if (ids) {
      const last = latest.get(ids.pubkey);
      if (ids.createdAt <= until && (!last || byTimeThenId({ createdAt: last.createdAt, id: last.eventId }, { createdAt: ids.createdAt, id: ids.eventId }) < 0)) {
        latest.set(ids.pubkey, ids);
      }
      if (ids.claims.length === 0) continue;
      const cur = identities.get(ids.pubkey);
      if (!cur || byTimeThenId({ createdAt: ev.created_at, id: ev.id }, cur) < 0) {
        identities.set(ids.pubkey, { id: ev.id, createdAt: ev.created_at });
      }
      continue;
    }
    const app = parseApplication(def.id, ev, by);
    if (app) {
      applications.set(app.eventId, app);
      continue;
    }
    const m = parseMatch(def.id, ev, by);
    if (m) {
      matches.push(m);
      continue;
    }
    const r = parseReport(def.id, ev, by);
    if (r) reports.set(r.matchId, [...(reports.get(r.matchId) ?? []), r]);
  }

  const byApplication = new Map<string, Linked>();
  for (const m of matches) {
    const app = applications.get(m.applicationId);
    // シーズンの境目をまたぐ対戦（締め切りが次のシーズンに入るもの）は、どちらのシーズンでも数えない
    if (m.createdAt < startsAt || m.createdAt + def.report.deadlineSec > endsAt || !isLinkedMatch(def, m, app)) continue;
    const cur = byApplication.get(app.eventId);
    if (!cur || byId(m.id, cur.match.id) < 0) byApplication.set(app.eventId, { match: m, application: app, reports: reports.get(m.id) ?? [] });
  }

  return {
    identities: new Map([...identities].map(([pk, v]) => [pk, v.id])),
    linked: [...byApplication.values()].sort((a, b) => byTimeThenId(a.match, b.match)),
    latest,
  };
}

/** 前の状態に、それより新しい公開情報だけを重ねる */
function mergeAccounts(prev: RatingState['accounts'], latest: Map<Pubkey, AccountInfo>): RatingState['accounts'] {
  const out = { ...prev };
  for (const [aid, a] of latest) {
    const cur = out[aid];
    if (cur && byTimeThenId({ createdAt: cur.createdAt, id: cur.eventId }, { createdAt: a.createdAt, id: a.eventId }) >= 0) continue;
    out[aid] = { name: a.name, claims: a.claims, eventId: a.eventId, createdAt: a.createdAt };
  }
  return out;
}

class Applier {
  readonly players: Record<Pubkey, PlayerState>;
  recentPairs: RecentPair[];
  readonly used = new Set<string>();

  constructor(
    private readonly def: GameDefinition,
    prev: RatingState,
  ) {
    this.players = structuredClone(prev.players);
    this.recentPairs = [...prev.recentPairs];
  }

  player(pk: Pubkey): PlayerState {
    return (this.players[pk] ??= initialPlayer(this.def));
  }

  markIdentities(identities: Map<Pubkey, string>): void {
    for (const [pk, id] of identities) {
      const p = this.player(pk);
      if (!p.hasIdentity) {
        p.hasIdentity = true;
        this.used.add(id);
      }
    }
  }

  apply({ match: m, application, reports }: Linked, s: Exclude<Settlement, { status: 'pending' }>, mannersToo: boolean): void {
    const deadline = m.createdAt + this.def.report.deadlineSec;
    const markUsed = () => {
      this.used.add(m.id).add(application.eventId);
      for (const r of reports) if (r.createdAt <= deadline) this.used.add(r.id);
    };

    if (s.status !== 'confirmed') {
      if (!mannersToo) return;
      for (const [pk, d] of Object.entries(mannersDelta(m, s))) {
        const p = this.player(pk);
        p.manners = { noReport: p.manners.noReport + d.noReport, cancel: p.manners.cancel + d.cancel, mismatch: p.manners.mismatch + d.mismatch };
      }
      markUsed();
      return;
    }

    const w = this.player(s.winner);
    const l = this.player(s.loser);
    if (!w.hasIdentity || !l.hasIdentity) return;

    const { def } = this;
    const t = m.createdAt;
    const idle = (p: PlayerState) => (p.lastMatchAt === null ? 0 : Math.floor((t - p.lastMatchAt) / def.rating.inactivityPeriodSec));
    const w0 = inflateRd(w, idle(w), def.rating.initialRd);
    const l0 = inflateRd(l, idle(l), def.rating.initialRd);
    const w1 = glicko2Update(w0, [{ opponent: l0, score: 1 }], def.rating.tau);
    const l1 = glicko2Update(l0, [{ opponent: w0, score: 0 }], def.rating.tau);

    const [a, b] = pairKey(s.winner, s.loser);
    const n = this.recentPairs.filter((p) => p.a === a && p.b === b && t - p.settledAt < def.rematchWeight.windowSec).length;
    const weights = def.rematchWeight.weights;
    const weight = weights[Math.min(n, weights.length - 1)]!;

    const update = (p: PlayerState, before: PlayerRating, after: PlayerRating, won: boolean) => {
      Object.assign(p, applyWeight(before, after, weight));
      p.matches += 1;
      if (won) p.wins += 1;
      else p.losses += 1;
      p.peakRating = Math.max(p.peakRating, p.rating);
      p.lastMatchAt = t;
    };
    update(w, w0, w1, true);
    update(l, l0, l1, false);
    this.recentPairs.push({ a, b, settledAt: t });
    markUsed();
  }
}

export interface AdvanceOptions {
  /** 取り切れなかったアカウント。その回は、これらが署名したイベントをすべて無視する（docs/adr/0008） */
  exclude?: ReadonlySet<string>;
}

/**
 * docs/protocol.md「レート計算」。締め切り（作成時刻 + deadlineSec）が (prev.cutoff, cutoff] に入る対戦を、
 * (作成時刻, 対戦 ID) の昇順に1件ずつ、1回だけ評価する。締め切り後に評価するので、
 * 遅れて届いた報告も取りこぼさず、日時を遡った報告で処理の窓を逃れることもできない。
 * 入力の順番、重複、スナップショットの区切り方に結果は左右されない。
 */
export function advanceRatings(
  def: GameDefinition,
  prev: RatingState,
  events: NostrEvent[],
  cutoff: number,
  opts: AdvanceOptions = {},
): { state: RatingState; usedEventIds: string[] } {
  const book = buildKelBook(prev.kels, events, prev.cutoff - def.report.deadlineSec, cutoff);
  const author = attributor(book.states, opts.exclude);
  const { identities, linked, latest } = collect(def, prev.season, events, author, cutoff);
  const ap = new Applier(def, prev);
  ap.markIdentities(identities);
  const accounts = mergeAccounts(prev.accounts, latest);
  for (const [aid, a] of Object.entries(accounts)) if (a !== prev.accounts[aid]) ap.used.add(a.eventId);

  for (const l of linked) {
    const deadline = l.match.createdAt + def.report.deadlineSec;
    if (deadline <= prev.cutoff || deadline > cutoff) continue;
    const s = settleMatch(l.match, l.reports, deadline, def.report.deadlineSec);
    if (s.status !== 'pending') ap.apply(l, s, true);
  }

  const keep = pairRetentionSec(def);
  return {
    state: {
      season: prev.season,
      cutoff,
      players: ap.players,
      recentPairs: ap.recentPairs.filter((p) => cutoff - p.settledAt < keep),
      seasonSummaries: prev.seasonSummaries,
      kels: book.records,
      accounts,
    },
    usedEventIds: [...ap.used, ...book.usedEventIds].sort(byId),
  };
}

/**
 * 画面表示用。締め切り前でも、すでに確定した対戦を作成時刻順に上乗せする。
 * 確定した結果は後から覆らないので、締め切り後の advanceRatings と同じ値になる。
 * マナーの回数は締め切りまで決まらないので加えない。保存や共有には使わない。
 */
export function provisionalRatings(def: GameDefinition, state: RatingState, events: NostrEvent[], now: number): RatingState {
  const book = buildKelBook(state.kels, events, state.cutoff - def.report.deadlineSec, now);
  const { identities, linked, latest } = collect(def, state.season, events, attributor(book.states), now);
  const ap = new Applier(def, state);
  ap.markIdentities(identities);
  for (const l of linked) {
    if (l.match.createdAt + def.report.deadlineSec <= state.cutoff) continue;
    const s = settleMatch(l.match, l.reports, now, def.report.deadlineSec);
    if (s.status === 'confirmed') ap.apply(l, s, false);
  }
  return { ...state, players: ap.players, recentPairs: ap.recentPairs, kels: book.records, accounts: mergeAccounts(state.accounts, latest) };
}

export function toLocalView(def: GameDefinition, state: RatingState): LocalView {
  return {
    ratingOf: (pk) => state.players[pk]?.rating ?? def.rating.initialRating,
    mannersTotalOf: (pk) => {
      const m = state.players[pk]?.manners;
      return m ? m.noReport + m.cancel + m.mismatch : 0;
    },
    lastMatchBetween: (x, y) => {
      const [a, b] = pairKey(x, y);
      let last: number | null = null;
      for (const p of state.recentPairs) if (p.a === a && p.b === b && (last === null || p.settledAt > last)) last = p.settledAt;
      return last;
    },
    hasIdentity: (pk) => state.players[pk]?.hasIdentity ?? false,
  };
}
