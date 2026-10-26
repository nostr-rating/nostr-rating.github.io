import {
  bansAgainst,
  changeFighter,
  initialSet,
  nextStageOptions,
  recordGame,
  setWinner,
  undoGame,
  type GameDefinition,
  type MatchRecord,
  type SetState,
  type Side,
  type StageBans,
  type StageId,
} from '@nostr-rating/core';
import { useEffect, useId, useState } from 'react';

const key = (matchId: string) => `nostr-rating:set:${matchId}`;

/** 試合ごとの記録はこの端末の中だけに置き、ネットワークには流さない */
function loadSet(m: MatchRecord): SetState {
  try {
    const raw = localStorage.getItem(key(m.id));
    if (raw) return JSON.parse(raw) as SetState;
  } catch {
    // 読めなければ最初から
  }
  return initialSet(m.p1Fighter, m.p2Fighter);
}

/** 次の試合で除かれるステージと、誰の拒否によるものか */
function excludedStages(def: GameDefinition, s: SetState, bans: { p1: StageBans; p2: StageBans }, me: Side): { stage: StageId; by: 'me' | 'opponent' }[] {
  const last = s.games.at(-1);
  const out: { stage: StageId; by: 'me' | 'opponent' }[] = [];
  const add = (side: Side, against: string) => {
    for (const st of bansAgainst(def, bans[side], against)) {
      if (!out.some((o) => o.stage === st)) out.push({ stage: st, by: side === me ? 'me' : 'opponent' });
    }
  };
  if (!last) {
    add('p1', s.p2Fighter);
    add('p2', s.p1Fighter);
    return out.filter((o) => def.stages.starter.includes(o.stage));
  }
  const winner = last.winner;
  add(winner, winner === 'p1' ? s.p2Fighter : s.p1Fighter);
  return out;
}

export function StageGuide(props: {
  def: GameDefinition;
  match: MatchRecord;
  me: Side;
  bans: { p1: StageBans; p2: StageBans };
  onSetChange?: (s: SetState) => void;
}) {
  const { def, match, me, bans } = props;
  const id = useId();
  const [set, setSet] = useState<SetState>(() => loadSet(match));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(key(match.id), JSON.stringify(set));
    } catch {
      // 保存できなくても進行の案内はできる
    }
    props.onSetChange?.(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, match.id]);

  const other: Side = me === 'p1' ? 'p2' : 'p1';
  const gameNo = set.games.length + 1;
  const winner = setWinner(def, set);
  const opts = nextStageOptions(def, set, bans);
  const stageName = (s: string) => def.stages.all.find((x) => x.id === s)?.name ?? s;
  const fighterName = (f: string) => def.fighters.find((x) => x.id === f)?.name ?? f;
  const lastLoser: Side | null = set.games.length > 0 ? (set.games.at(-1)!.winner === 'p1' ? 'p2' : 'p1') : null;
  const fighterOf = (side: Side) => (side === 'p1' ? set.p1Fighter : set.p2Fighter);
  const excluded = excludedStages(def, set, bans, me);

  const pickerText =
    opts.picker === 'both'
      ? `${gameNo}戦目: お互いが選び、ゲーム内の抽選に従います`
      : opts.picker === me
        ? `${gameNo}戦目: あなたが選びます（相手は「おまかせ」）`
        : `${gameNo}戦目: 相手が選びます（あなたは「おまかせ」）`;

  const apply = (f: () => SetState) => {
    try {
      setSet(f());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const fighterSelect = (side: Side, label: string) => (
    <>
      <label htmlFor={`${id}-${side}`}>{label}</label>
      <select id={`${id}-${side}`} value={fighterOf(side)} onChange={(e) => apply(() => changeFighter(def, set, side, e.target.value))}>
        {def.fighters.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
    </>
  );

  return (
    <div className="card stack">
      <h3>ステージ案内</h3>
      <p className="muted">
        あなた: {fighterName(fighterOf(me))} ／ 相手: {fighterName(fighterOf(other))}
      </p>
      {winner === null ? (
        <>
          <p data-testid="stage-picker">{pickerText}</p>
          <p data-testid="stage-options">{opts.stages.map(stageName).join('・')}</p>
          <p className="muted" data-testid="excluded-stages">
            除外: {excluded.length === 0 ? 'なし' : excluded.map((e) => `${stageName(e.stage)}（${e.by === 'me' ? 'あなた' : '相手'}の拒否）`).join('・')}
          </p>
          {lastLoser === me && fighterSelect(me, 'キャラを変える（直前の敗者のみ）')}
          {lastLoser === other && fighterSelect(other, '相手のキャラ（直前の敗者が変えたとき）')}
          <div className="row">
            <button type="button" onClick={() => apply(() => recordGame(def, set, me))}>{gameNo}戦目: あなたの勝ち</button>
            <button type="button" onClick={() => apply(() => recordGame(def, set, other))}>{gameNo}戦目: 相手の勝ち</button>
          </div>
        </>
      ) : (
        <p>{winner === me ? 'あなたが2本先取しました。' : '相手が2本先取しました。'}結果を報告してください。</p>
      )}
      {set.games.length > 0 && (
        <button type="button" onClick={() => apply(() => undoGame(set))}>1つ前に戻す</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
