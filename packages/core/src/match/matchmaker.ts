import type { NostrEvent } from 'nostr-tools/pure';
import {
  buildApplication,
  buildMatch,
  buildRecruitment,
  parseAccountInfo,
  parseApplication,
  parseMatch,
  parseRecruitment,
  type Application,
  type MatchRecord,
  type Recruitment,
} from '../events/codec.js';
import { KIND } from '../events/kinds.js';
import { acceptsNewMatches, type GameDefinition } from '../game/definition.js';
import { signAs, type SessionIdentity } from '../kel/book.js';
import type { RelayClient } from '../relay/client.js';
import type { FighterId, Pubkey } from '../types.js';
import { canMatch, type LocalView, type SeekerView } from './conditions.js';

export interface MatchmakerDeps {
  relay: RelayClient;
  /** 自分のアカウントとして署名するための使い捨ての鍵 */
  identity: SessionIdentity;
  /** 他人のイベントを証明書から aid に結び付ける。分からなければ null */
  author: (ev: NostrEvent) => Promise<Pubkey | null>;
  def: GameDefinition;
  view: LocalView;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface SearchParams {
  firstFighter: FighterId;
  rangeChoice: number | null;
  rematchHours: number;
  settingsId: string;
}

/** 内部ループの刻み。申し込みの処理と、成立待ちの確認に使う */
const TICK_MS = 1000;
/** 他人の募集を探し直す間隔 */
const SCAN_INTERVAL_SEC = 5;
/** 1回の探索で申し込む募集の上限（偽の募集で延々と待たされないように） */
const MAX_APPLICATIONS_PER_SCAN = 3;
/** 募集の waitingSince として受け入れる、作成時刻からの遡りの上限 */
const MAX_WAITING_SEC = 6 * 3600;
/** 作成時刻として受け入れる、手元の時計からの未来方向のずれ */
const CLOCK_SKEW_SEC = 60;
/** 連戦の判定のために遡って読む対戦の期間 */
const REMATCH_LOOKBACK_SEC = 48 * 3600;

function abortError(): Error {
  const e = new Error('search aborted');
  e.name = 'AbortError';
  return e;
}

/** (waitingSince, pubkey) が小さいほど「先に待っていた」 */
function waitedLonger(a: { waitingSince: number; pubkey: Pubkey }, b: { waitingSince: number; pubkey: Pubkey }): boolean {
  return a.waitingSince < b.waitingSince || (a.waitingSince === b.waitingSince && a.pubkey < b.pubkey);
}

/**
 * docs/spec.md「マッチング」の手順。
 * 条件に合う募集があれば申し込み、なければ自分が募集を出す。募集中も他人の募集を探し、
 * 自分より先に待っていた相手が見つかれば自分の募集を閉じてそちらへ申し込む。
 */
export class Matchmaker {
  readonly #d: MatchmakerDeps;

  constructor(deps: MatchmakerDeps) {
    this.#d = deps;
  }

  async search(p: SearchParams, signal: AbortSignal): Promise<MatchRecord> {
    const { relay, identity, author, def, now } = this.#d;
    const game = def.id;
    const me = identity.aid;
    const mySession = await identity.signer.getPublicKey();
    const waitingSince = now();
    if (!acceptsNewMatches(def, waitingSince).ok) throw new Error('new matches are not accepted until the next season starts');

    const self = (): SeekerView => ({
      pubkey: me,
      rating: this.#d.view.ratingOf(me),
      rangeChoice: p.rangeChoice,
      rematchHours: p.rematchHours,
      waitingSince,
      mannersTotal: this.#d.view.mannersTotalOf(me),
    });

    const applications: Application[] = [];
    /** 自分の申し込み ID → その申し込みに対して受け入れるマッチ（最初の正当なもので固定） */
    const sentApplications = new Map<string, Application>();
    const matches = new Map<string, MatchRecord>();
    const since = waitingSince - 5;
    const recent = await this.#recentOpponents(me, mySession);
    const unsubs = [
      relay.subscribe([{ kinds: [KIND.application], '#p': [mySession], since }], (ev) => {
        author(ev).then(
          (by) => {
            const a = parseApplication(game, ev, by);
            if (a && a.recruiter === me) applications.push(a);
          },
          (e: unknown) => console.warn('could not resolve the author of an application', e),
        );
      }),
      relay.subscribe([{ kinds: [KIND.match], '#p': [mySession], since }], (ev) => {
        author(ev).then(
          (by) => {
            const m = parseMatch(game, ev, by);
            if (!m || m.p2 !== me || matches.has(m.applicationId)) return;
            const app = sentApplications.get(m.applicationId);
            if (app && this.#answers(m, app)) matches.set(m.applicationId, m);
          },
          (e: unknown) => console.warn('could not resolve the author of a match', e),
        );
      }),
    ];

    let recruiting = false;
    /** 一度でも募集を出したら、相手から申し込まれうる。互いに申し込み合わないよう、先に待っていた相手にだけ申し込む */
    let hasRecruited = false;
    let lastHeartbeat = -Infinity;
    let lastScan = -Infinity;

    const publishRecruitment = async (status: 'open' | 'closed') => {
      const t = now();
      const tmpl = buildRecruitment(
        game,
        { firstFighter: p.firstFighter, rating: self().rating, rangeChoice: p.rangeChoice, rematchHours: p.rematchHours, settingsId: p.settingsId, waitingSince, status },
        t,
        def.matching.recruitmentTtlSec,
      );
      await relay.publish(await signAs(identity, tmpl));
      recruiting = status === 'open';
      if (recruiting) hasRecruited = true;
      lastHeartbeat = t;
    };

    try {
      for (;;) {
        if (signal.aborted) throw abortError();

        if (recruiting) {
          const m = await this.#acceptApplication(p, self(), applications, recent);
          if (m) {
            await publishRecruitment('closed');
            return m;
          }
        }

        if (now() - lastScan >= SCAN_INTERVAL_SEC) {
          lastScan = now();
          for (const r of (await this.#candidates(self(), hasRecruited, recent)).slice(0, MAX_APPLICATIONS_PER_SCAN)) {
            if (signal.aborted) throw abortError();
            if (recruiting) await publishRecruitment('closed');
            const m = await this.#apply(p, r, waitingSince, sentApplications, matches, signal);
            if (m) return m;
          }
        }

        if (!recruiting || now() - lastHeartbeat >= def.matching.heartbeatSec) await publishRecruitment('open');
        await this.#d.sleep(TICK_MS);
      }
    } catch (e) {
      if (recruiting) await publishRecruitment('closed').catch(() => undefined);
      throw e;
    } finally {
      unsubs.forEach((u) => u());
    }
  }

  async #candidates(self: SeekerView, onlyOlder: boolean, recent: Map<Pubkey, number>): Promise<Recruitment[]> {
    const { relay, def, view, now, author } = this.#d;
    const t = now();
    const events: NostrEvent[] = await relay.query([
      { kinds: [KIND.recruitment], '#d': [def.id], since: t - def.matching.heartbeatSec * 2 },
    ]);
    const parsed = await Promise.all(events.map(async (e) => parseRecruitment(def.id, e, await author(e))));
    const plausible = parsed
      .filter((r): r is Recruitment => r !== null && r.status === 'open' && r.pubkey !== self.pubkey && r.expiresAt > t)
      .filter(
        (r) =>
          r.createdAt <= t + CLOCK_SKEW_SEC &&
          r.waitingSince <= r.createdAt &&
          r.createdAt - r.waitingSince <= MAX_WAITING_SEC &&
          r.expiresAt - r.createdAt <= def.matching.recruitmentTtlSec * 2,
      )
      .filter((r) => !onlyOlder || waitedLonger(r, self))
      .filter((r) => canMatch(def, self, this.#viewOf(r.pubkey, r), t, this.#lastBetween(self.pubkey, r.pubkey, recent)));
    const out: Recruitment[] = [];
    for (const r of plausible) if (await this.#hasIdentity(r.pubkey)) out.push(r);
    return out.sort(
        (a, b) =>
          Math.abs(view.ratingOf(a.pubkey) - self.rating) - Math.abs(view.ratingOf(b.pubkey) - self.rating) ||
          (waitedLonger(a, b) ? -1 : 1),
      );
  }

  #viewOf(pubkey: Pubkey, c: { rangeChoice: number | null; rematchHours: number; waitingSince: number }): SeekerView {
    return {
      pubkey,
      rating: this.#d.view.ratingOf(pubkey),
      rangeChoice: c.rangeChoice,
      rematchHours: c.rematchHours,
      waitingSince: c.waitingSince,
      mannersTotal: this.#d.view.mannersTotalOf(pubkey),
    };
  }

  async #acceptApplication(
    p: SearchParams,
    self: SeekerView,
    applications: Application[],
    recent: Map<Pubkey, number>,
  ): Promise<MatchRecord | null> {
    const { relay, identity, def, now } = this.#d;
    const t = now();
    // 申込者が待ちをやめた後に成立させないよう、成立待ちの時間内に届いたものだけを受ける
    const fresh = applications
      .filter((a) => a.createdAt <= t + CLOCK_SKEW_SEC && t - a.createdAt < def.matching.applicationTimeoutSec - 2)
      .filter((a) => a.waitingSince <= a.createdAt && a.createdAt - a.waitingSince <= MAX_WAITING_SEC)
      .sort((a, b) => a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : 1));
    applications.length = 0;
    for (const a of fresh) {
      if (!canMatch(def, self, this.#viewOf(a.pubkey, a), t, this.#lastBetween(self.pubkey, a.pubkey, recent))) continue;
      if (!(await this.#hasIdentity(a.pubkey))) continue;
      const ev = await signAs(
        identity,
        buildMatch(
          def.id,
          {
            p1: self.pubkey,
            p2: a.pubkey,
            sessions: [await identity.signer.getPublicKey(), a.session],
            p1Fighter: p.firstFighter,
            p2Fighter: a.firstFighter,
            p1SettingsId: p.settingsId,
            p2SettingsId: a.settingsId,
            applicationId: a.eventId,
          },
          Math.max(t, a.createdAt),
        ),
      );
      await relay.publish(ev);
      return parseMatch(def.id, ev, identity.aid);
    }
    return null;
  }

  async #apply(
    p: SearchParams,
    r: Recruitment,
    waitingSince: number,
    sent: Map<string, Application>,
    matches: Map<string, MatchRecord>,
    signal: AbortSignal,
  ): Promise<MatchRecord | null> {
    const { relay, identity, def, now, sleep } = this.#d;
    const ev = await signAs(
      identity,
      buildApplication(
        def.id,
        { recruiter: r.pubkey, recruiterSession: r.session, firstFighter: p.firstFighter, settingsId: p.settingsId, rangeChoice: p.rangeChoice, rematchHours: p.rematchHours, waitingSince },
        now(),
      ),
    );
    const app = parseApplication(def.id, ev, identity.aid);
    if (!app) return null;
    sent.set(app.eventId, app);
    await relay.publish(ev);
    const deadline = now() + def.matching.applicationTimeoutSec;
    while (now() < deadline) {
      const m = matches.get(ev.id);
      if (m) return m;
      if (signal.aborted) throw abortError();
      await sleep(TICK_MS / 4);
    }
    return matches.get(ev.id) ?? null;
  }

  /** 自分の申し込みに対する、募集した本人からの正当なマッチか */
  #answers(m: MatchRecord, app: Application): boolean {
    const gap = m.createdAt - app.createdAt;
    return (
      m.p1 === app.recruiter &&
      m.applicationId === app.eventId &&
      m.p2Fighter === app.firstFighter &&
      m.p2SettingsId === app.settingsId &&
      gap >= 0 &&
      gap <= this.#d.def.matching.applicationTimeoutSec
    );
  }

  readonly #identityCache = new Map<Pubkey, boolean>();

  /** 手元の計算で分からなければ、リレーにアカウントの公開情報を問い合わせる */
  async #hasIdentity(pk: Pubkey): Promise<boolean> {
    if (this.#d.view.hasIdentity(pk)) return true;
    const cached = this.#identityCache.get(pk);
    if (cached !== undefined) return cached;
    const { relay, def, author } = this.#d;
    const evs = await relay.query([{ kinds: [KIND.account], '#d': [pk] }]);
    let ok = false;
    for (const e of evs) {
      const by = await author(e);
      if (by === pk && (parseAccountInfo(e, by)?.claims.length ?? 0) > 0) ok = true;
    }
    this.#identityCache.set(pk, ok);
    return ok;
  }

  /** まだスナップショットに入っていない最近の対戦も、連戦の判定に使う */
  async #recentOpponents(me: Pubkey, mySession: Pubkey): Promise<Map<Pubkey, number>> {
    const { relay, def, now, author } = this.#d;
    const evs = await relay.query([{ kinds: [KIND.match], '#p': [mySession], since: now() - REMATCH_LOOKBACK_SEC }]);
    const out = new Map<Pubkey, number>();
    for (const ev of evs) {
      const m = parseMatch(def.id, ev, await author(ev));
      if (!m || (m.p1 !== me && m.p2 !== me)) continue;
      const other = m.p1 === me ? m.p2 : m.p1;
      out.set(other, Math.max(out.get(other) ?? 0, m.createdAt));
    }
    return out;
  }

  #lastBetween(me: Pubkey, other: Pubkey, recent: Map<Pubkey, number>): number | null {
    const a = this.#d.view.lastMatchBetween(me, other);
    const b = recent.get(other) ?? null;
    return a === null ? b : b === null ? a : Math.max(a, b);
  }
}
