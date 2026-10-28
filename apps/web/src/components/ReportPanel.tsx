import { settleMatch, type GameDefinition, type MatchRecord, type Pubkey, type ReportResult, type ResultReport } from '@nostr-rating/core';

export const RESULT_LABEL: Record<ReportResult, string> = { win: '勝ち', lose: '負け', draw: '引き分け', cancel: '中止' };

export function reportStatus(def: GameDefinition, match: MatchRecord, reports: ResultReport[], me: Pubkey, now: number): string {
  const s = settleMatch(match, reports, now, def.report.deadlineSec, def.results.draw);
  switch (s.status) {
    case 'confirmed':
      return `結果が確定しました（${s.winner === me ? 'あなた' : '相手'}の勝ち）`;
    case 'drawn':
      return '結果が確定しました（引き分け）';
    case 'cancelled':
      return '対戦は中止になりました';
    case 'mismatch':
      return '報告が食い違ったまま締め切られました';
    case 'no_report':
      return '報告がそろわないまま締め切られました';
    case 'pending': {
      const latest = latestReports(match, reports);
      if (!latest.has(me)) return '結果を報告してください';
      if (latest.size === 2) return '報告が食い違っています。確認して送り直してください。';
      return '相手の報告を待っています';
    }
  }
}

export function latestReports(match: MatchRecord, reports: ResultReport[]): Map<Pubkey, ReportResult> {
  const latest = new Map<Pubkey, ReportResult>();
  for (const r of [...reports].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    if (r.reporter === match.p1 || r.reporter === match.p2) latest.set(r.reporter, r.result);
  }
  return latest;
}

export function ReportPanel(props: {
  status: string;
  /** 確定・中止・締め切り後は報告できない */
  closed: boolean;
  mine: ReportResult | undefined;
  suggested: ReportResult | null;
  /** 引き分けを報告できるゲームか */
  allowDraw: boolean;
  busy: boolean;
  onReport: (r: ReportResult) => Promise<void>;
}) {
  const choose = (r: ReportResult) => {
    // 噛み合う報告がそろうとその場で確定し、取り消せないので確かめる
    if (
      !window.confirm(
        `「${RESULT_LABEL[r]}」で報告します。一度送った報告は取り消せず、後から送り直しても有効なまま残ります。相手の報告と噛み合うと、その場で確定します。よろしいですか？`,
      )
    )
      return;
    void props.onReport(r);
  };
  const choices = props.allowDraw ? (['win', 'lose', 'draw', 'cancel'] as const) : (['win', 'lose', 'cancel'] as const);
  return (
    <div className="card">
      <h3>結果報告</h3>
      {/* 状態と自分の報告は、報告の前から同じ場所を取っておく */}
      <div className="report-state">
        <p data-testid="report-status" role="status" aria-live="polite">{props.status}</p>
        <p className="muted">{props.mine ? `あなたの報告: ${RESULT_LABEL[props.mine]}` : ''}</p>
      </div>
      {props.closed ? (
        <a className="button primary wide" href="#/lobby">ロビーに戻る</a>
      ) : (
        <>
          <div className="choices">
            {choices.map((r) => (
              <button
                key={r}
                type="button"
                disabled={props.busy}
                className={props.suggested === r ? 'primary' : ''}
                aria-describedby={props.suggested === r ? 'suggested-note' : undefined}
                onClick={() => choose(r)}
              >
                {RESULT_LABEL[r]}
              </button>
            ))}
          </div>
          <p id="suggested-note" className="slot muted">
            {props.suggested ? `ステージ案内の記録から「${RESULT_LABEL[props.suggested]}」を勧めています。` : ''}
          </p>
          <p className="hint">
            中止は、相手と連絡が取れない・続けられない事情があるときだけ選んでください。食い違ったときは正しい結果を送り直せますが、前に送った報告も有効なまま残り、相手の報告と噛み合えばそちらで確定します。
          </p>
        </>
      )}
    </div>
  );
}
