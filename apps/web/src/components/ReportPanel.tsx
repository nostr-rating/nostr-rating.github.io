import { countedReports, matchDeadline, settleMatch, type GameDefinition, type MatchRecord, type Pubkey, type ReportResult, type ResultReport } from '@nostr-rating/core';

import { messages, tr, useT } from '../i18n.js';

const M = messages({
  ja: {
    result: { win: '勝ち', lose: '負け', draw: '引き分け', cancel: '中止' } as Record<ReportResult, string>,
    confirmed: (iWon: boolean) => `結果が確定しました（${iWon ? 'あなた' : '相手'}の勝ち）`,
    drawn: '結果が確定しました（引き分け）',
    cancelled: '対戦は中止になりました',
    mismatch: '報告が食い違ったまま締め切られました',
    noReport: '報告がそろわないまま締め切られました',
    reportNow: '結果を報告してください',
    conflict: '報告が食い違っています。確認して送り直してください。',
    waiting: '相手の報告を待っています',
    confirm: (label: string) =>
      `「${label}」で報告します。一度送った報告は取り消せず、後から送り直しても有効なまま残ります。相手の報告と噛み合うと、その場で確定します。よろしいですか？`,
    title: '結果報告',
    mine: (label: string) => `あなたの報告: ${label}`,
    backToLobby: 'ロビーに戻る',
    stageRecord: (mine: number, theirs: number) => `ステージ案内の記録: あなた ${mine} - ${theirs} 相手`,
    hint: '中止は、相手と連絡が取れない・続けられない事情があるときだけ選んでください。勝ち・負け・引き分けを一度送ると、中止は選べなくなります。食い違ったときは正しい結果を送り直せますが、前に送った報告も有効なまま残り、相手の報告と噛み合えばそちらで確定します。',
  },
  en: {
    result: { win: 'Win', lose: 'Loss', draw: 'Draw', cancel: 'Cancel' },
    confirmed: (iWon: boolean) => `The result is final (${iWon ? 'you won' : 'your opponent won'})`,
    drawn: 'The result is final (draw)',
    cancelled: 'The match was cancelled',
    mismatch: 'The deadline passed with conflicting reports',
    noReport: 'The deadline passed without reports from both players',
    reportNow: 'Please report the result',
    conflict: 'The reports conflict. Check the result and send it again.',
    waiting: "Waiting for your opponent's report",
    confirm: (label: string) =>
      `You are reporting "${label}". A report cannot be withdrawn and stays valid even if you send another one later. If it matches your opponent's report, the result becomes final right away. Continue?`,
    title: 'Report the result',
    mine: (label: string) => `Your report: ${label}`,
    backToLobby: 'Back to Lobby',
    stageRecord: (mine: number, theirs: number) => `Stage guide record: you ${mine} - ${theirs} opponent`,
    hint: 'Choose Cancel only when you cannot reach your opponent or cannot continue. Once you send Win, Loss or Draw, you can no longer choose Cancel. If the reports conflict, you can send the correct result again, but your earlier report also stays valid, and the result becomes final as soon as either one matches your opponent\'s report.',
  },
});

/** 結果の表示名（今の言語） */
export const resultLabel = (r: ReportResult): string => tr(M).result[r];

export function reportStatus(def: GameDefinition, match: MatchRecord, reports: ResultReport[], me: Pubkey, now: number): string {
  const s = settleMatch(match, reports, now, matchDeadline(def, match.createdAt), def.results.draw);
  const t = tr(M);
  switch (s.status) {
    case 'confirmed':
      return t.confirmed(s.winner === me);
    case 'drawn':
      return t.drawn;
    case 'cancelled':
      return t.cancelled;
    case 'mismatch':
      return t.mismatch;
    case 'no_report':
      return t.noReport;
    case 'pending': {
      const latest = latestReports(def, match, reports, now);
      if (!latest.has(me)) return t.reportNow;
      if (latest.size === 2) return t.conflict;
      return t.waiting;
    }
  }
}

/** 各当事者の、数えられる報告のうち最新のもの（結果を報告した人の中止は数えない。docs/adr/0015） */
export function latestReports(def: GameDefinition, match: MatchRecord, reports: ResultReport[], now: number): Map<Pubkey, ReportResult> {
  const latest = new Map<Pubkey, ReportResult>();
  for (const r of countedReports(match, reports, now, matchDeadline(def, match.createdAt), def.results.draw)) latest.set(r.reporter, r.result);
  return latest;
}

/** me が勝ち・負け・引き分けを報告したか。報告していれば、中止を送っても数えない */
export function resultSent(def: GameDefinition, match: MatchRecord, reports: ResultReport[], me: Pubkey, now: number): boolean {
  return countedReports(match, reports, now, matchDeadline(def, match.createdAt), def.results.draw).some((r) => r.reporter === me && r.result !== 'cancel');
}

export function ReportPanel(props: {
  status: string;
  /** 確定・中止・締め切り後は報告できない */
  closed: boolean;
  mine: ReportResult | undefined;
  /** 勝ち・負け・引き分けを送ったあとの中止は数えないので選べなくする（docs/adr/0015） */
  resultSent: boolean;
  /** ステージ案内で記録した勝敗の数（ステージ案内のないゲームでは null） */
  record: { mine: number; theirs: number } | null;
  /** 引き分けを報告できるゲームか */
  allowDraw: boolean;
  busy: boolean;
  onReport: (r: ReportResult) => Promise<void>;
}) {
  const t = useT(M);
  const choose = (r: ReportResult) => {
    // 噛み合う報告がそろうとその場で確定し、取り消せないので確かめる
    if (!window.confirm(t.confirm(t.result[r]))) return;
    void props.onReport(r);
  };
  const choices = props.allowDraw ? (['win', 'lose', 'draw', 'cancel'] as const) : (['win', 'lose', 'cancel'] as const);
  return (
    <div className="card">
      <h3>{t.title}</h3>
      {/* 状態と自分の報告は、報告の前から同じ場所を取っておく */}
      <div className="report-state">
        <p data-testid="report-status" role="status" aria-live="polite">{props.status}</p>
        <p className="muted">{props.mine ? t.mine(t.result[props.mine]) : ''}</p>
      </div>
      {props.closed ? (
        <a className="button primary wide" href="#/lobby">{t.backToLobby}</a>
      ) : (
        <>
          <div className="choices">
            {choices.map((r) => (
              <button
                key={r}
                type="button"
                disabled={props.busy || (r === 'cancel' && props.resultSent)}
                onClick={() => choose(r)}
              >
                {t.result[r]}
              </button>
            ))}
          </div>
          {props.record && (
            <p className="muted" data-testid="stage-record">
              {t.stageRecord(props.record.mine, props.record.theirs)}
            </p>
          )}
          <p className="hint">{t.hint}</p>
        </>
      )}
    </div>
  );
}
