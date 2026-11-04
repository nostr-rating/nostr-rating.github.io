import type { MatchRecord, ReportResult, ResultReport } from '../events/codec.js';
import type { Pubkey } from '../types.js';

export type Settlement =
  | { status: 'pending' }
  | { status: 'confirmed'; winner: Pubkey; loser: Pubkey; settledAt: number }
  /** 双方が引き分けを報告した（引き分けがあるゲームだけ） */
  | { status: 'drawn'; settledAt: number }
  | { status: 'cancelled'; settledAt: number }
  | { status: 'mismatch'; settledAt: number }
  | { status: 'no_report'; settledAt: number; missing: Pubkey[] };

export interface MannersCount {
  noReport: number;
  cancel: number;
  mismatch: number;
}

/**
 * docs/spec.md「結果の確定」。報告を時刻順に走査し、噛み合う報告の組（勝ち+負け、中止+中止）が
 * 初めてそろった瞬間に確定する。「最新の報告どうし」ではなく「これまでに出した報告」で
 * 判定するので、日時を遡らせた報告を後から足しても確定は覆らない。
 * 勝ち・負け・引き分けを報告した人の中止は数えない（docs/adr/0015）。
 * 締め切り（matchDeadline）までにそろわなければ、最新報告から食い違い／未報告とする。
 */
export function settleMatch(match: MatchRecord, reports: ResultReport[], now: number, deadline: number, allowDraw = false): Settlement {
  const valid = validReports(match, reports, now, deadline, allowDraw);

  const latest = new Map<Pubkey, ReportResult>();
  const sent = { [match.p1]: new Set<ReportResult>(), [match.p2]: new Set<ReportResult>() };
  for (const r of valid) {
    latest.set(r.reporter, r.result);
    sent[r.reporter]!.add(r.result);
    // 新しい報告が組を完成させたかだけを見る（以前に完成していればもう返している）
    const other = r.reporter === match.p1 ? match.p2 : match.p1;
    const theirs = sent[other]!;
    if (r.result === 'win' && theirs.has('lose')) return { status: 'confirmed', winner: r.reporter, loser: other, settledAt: r.createdAt };
    if (r.result === 'lose' && theirs.has('win')) return { status: 'confirmed', winner: other, loser: r.reporter, settledAt: r.createdAt };
    if (r.result === 'cancel' && theirs.has('cancel')) return { status: 'cancelled', settledAt: r.createdAt };
    if (r.result === 'draw' && theirs.has('draw')) return { status: 'drawn', settledAt: r.createdAt };
  }

  if (now < deadline) return { status: 'pending' };
  const missing = [match.p1, match.p2].filter((p) => !latest.has(p));
  if (missing.length > 0) return { status: 'no_report', settledAt: deadline, missing };
  return { status: 'mismatch', settledAt: deadline };
}

/**
 * docs/spec.md「取得」。片方（absent）のイベントを取り切れなかった対戦を、締め切りの時点で確定する。
 * absent の報告は使わず、相手の最新の報告に合わせたものとみなす。相手が報告していなければ数えない
 */
export function settleAgreeing(match: MatchRecord, reports: ResultReport[], absent: Pubkey, deadline: number, allowDraw = false): Settlement {
  const other = absent === match.p1 ? match.p2 : match.p1;
  const last = validReports(match, reports, deadline, deadline, allowDraw)
    .filter((r) => r.reporter === other)
    .at(-1);
  if (!last) return { status: 'no_report', settledAt: deadline, missing: [match.p1, match.p2] };
  switch (last.result) {
    case 'win':
      return { status: 'confirmed', winner: other, loser: absent, settledAt: last.createdAt };
    case 'lose':
      return { status: 'confirmed', winner: absent, loser: other, settledAt: last.createdAt };
    case 'draw':
      return { status: 'drawn', settledAt: last.createdAt };
    case 'cancel':
      return { status: 'cancelled', settledAt: last.createdAt };
  }
}

/** 締め切りまでに当事者が出した、その対戦の報告（時刻順） */
function validReports(match: MatchRecord, reports: ResultReport[], now: number, deadline: number, allowDraw: boolean): ResultReport[] {
  const valid = reports
    .filter(
      (r) =>
        r.matchId === match.id &&
        (r.reporter === match.p1 || r.reporter === match.p2) &&
        r.createdAt >= match.createdAt &&
        r.createdAt <= deadline &&
        r.createdAt <= now &&
        // 引き分けのないゲームでは、引き分けの報告はなかったものとする
        (allowDraw || r.result !== 'draw'),
    )
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 中止を日時を遡らせて出し、そろった結果を取り消せないように、結果を報告した人の中止は時刻を問わず使わない
  const decided = new Set(valid.filter((r) => r.result !== 'cancel').map((r) => r.reporter));
  return valid.filter((r) => r.result !== 'cancel' || !decided.has(r.reporter));
}

const zero = (): MannersCount => ({ noReport: 0, cancel: 0, mismatch: 0 });

export function mannersDelta(match: MatchRecord, s: Settlement): Record<Pubkey, MannersCount> {
  switch (s.status) {
    case 'cancelled':
      return { [match.p1]: { ...zero(), cancel: 1 }, [match.p2]: { ...zero(), cancel: 1 } };
    case 'mismatch':
      return { [match.p1]: { ...zero(), mismatch: 1 }, [match.p2]: { ...zero(), mismatch: 1 } };
    case 'no_report':
      // 誰も報告しなかった対戦は、成立していなかった可能性がある（幽霊マッチ）ので数えない
      if (s.missing.length === 2) return {};
      return Object.fromEntries(s.missing.map((p) => [p, { ...zero(), noReport: 1 }]));
    default:
      return {};
  }
}
