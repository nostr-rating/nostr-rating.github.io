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
import { messages, useT, useText } from '../i18n.js';
import { Dock } from './Dock.js';

const M = messages({
  ja: {
    pickBoth: (n: number) => `${n}戦目: お互いが選び、ゲーム内の抽選に従います`,
    pickMe: (n: number) => `${n}戦目: あなたが選びます（相手は「おまかせ」）`,
    pickOpponent: (n: number) => `${n}戦目: 相手が選びます（あなたは「おまかせ」）`,
    title: 'ステージ案内',
    fighters: (me: string, other: string) => `あなた: ${me} ／ 相手: ${other}`,
    excluded: '除外: ',
    none: 'なし',
    bannedBy: (stage: string, mine: boolean) => `${stage}（${mine ? 'あなた' : '相手'}の拒否）`,
    sep: '・',
    changeFighter: 'キャラを変える',
    changeFromGame2: '2戦目からは、直前の敗者だけがキャラを変えられます。',
    onlyLoser: '変えられるのは直前の敗者だけです。',
    opponentFighter: '相手のキャラ',
    opponentChanged: '相手がキャラを変えたら、ここで選び直してください。',
    iWon: (n: number) => `${n}戦目: あなたの勝ち`,
    theyWon: (n: number) => `${n}戦目: 相手の勝ち`,
    setOver: (iWon: boolean) => `${iWon ? 'あなたが2本先取しました。' : '相手が2本先取しました。'}結果を報告してください。`,
    undo: '1つ前に戻す',
  },
  en: {
    pickBoth: (n: number) => `Game ${n}: both players pick, and the in-game random draw decides`,
    pickMe: (n: number) => `Game ${n}: you pick (your opponent chooses "Random")`,
    pickOpponent: (n: number) => `Game ${n}: your opponent picks (you choose "Random")`,
    title: 'Stage guide',
    fighters: (me: string, other: string) => `You: ${me} / Opponent: ${other}`,
    excluded: 'Excluded: ',
    none: 'None',
    bannedBy: (stage: string, mine: boolean) => `${stage} (${mine ? 'your' : "opponent's"} ban)`,
    sep: ', ',
    changeFighter: 'Change fighter',
    changeFromGame2: 'From game 2, only the loser of the previous game can change fighters.',
    onlyLoser: 'Only the loser of the previous game can change fighters.',
    opponentFighter: "Opponent's fighter",
    opponentChanged: 'If your opponent changes fighters, select the new one here.',
    iWon: (n: number) => `Game ${n}: you won`,
    theyWon: (n: number) => `Game ${n}: opponent won`,
    setOver: (iWon: boolean) => `${iWon ? 'You won 2 games.' : 'Your opponent won 2 games.'} Please report the result.`,
    undo: 'Undo last game',
  },
});

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
    return out.filter((o) => def.stages!.starter.includes(o.stage));
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
  const t = useT(M);
  const text = useText();
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
  // ステージとキャラのあるゲームでだけ表示する（MatchRoom が確かめる）
  const stages = def.stages!;
  const characters = def.characters!;
  const stageName = (s: string) => {
    const st = stages.all.find((x) => x.id === s);
    return st ? text(st.name) : s;
  };
  const fighterName = (f: string) => {
    const c = characters.list.find((x) => x.id === f);
    return c ? text(c.name) : f;
  };
  const lastLoser: Side | null = set.games.length > 0 ? (set.games.at(-1)!.winner === 'p1' ? 'p2' : 'p1') : null;
  const fighterOf = (side: Side) => (side === 'p1' ? set.p1Fighter : set.p2Fighter);
  const excluded = excludedStages(def, set, bans, me);

  const pickerText =
    opts.picker === 'both' ? t.pickBoth(gameNo) : opts.picker === me ? t.pickMe(gameNo) : t.pickOpponent(gameNo);

  const apply = (f: () => SetState) => {
    try {
      setSet(f());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const fighterSelect = (side: Side, label: string, hint: string, disabled = false) => (
    <div className="field">
      <label htmlFor={`${id}-${side}`}>{label}</label>
      <select id={`${id}-${side}`} value={fighterOf(side)} disabled={disabled} onChange={(e) => apply(() => changeFighter(def, set, side, e.target.value))}>
        {characters.list.map((f) => (
          <option key={f.id} value={f.id}>{text(f.name)}</option>
        ))}
      </select>
      <p className="hint">{hint}</p>
    </div>
  );

  return (
    <div className="card">
      <h3>{t.title}</h3>
      <p className="muted">{t.fighters(fighterName(fighterOf(me)), fighterName(fighterOf(other)))}</p>
      {winner === null ? (
        <>
          <p data-testid="stage-picker">{pickerText}</p>
          <p data-testid="stage-options">{opts.stages.map(stageName).join(t.sep)}</p>
          <p className="muted" data-testid="excluded-stages">
            {t.excluded}
            {excluded.length === 0 ? t.none : excluded.map((e) => t.bannedBy(stageName(e.stage), e.by === 'me')).join(t.sep)}
          </p>
          {/* キャラの欄は1戦目から出しておき（1戦目は変えられない）、2戦目に入っても下の要素を動かさない */}
          {lastLoser === null && fighterSelect(me, t.changeFighter, t.changeFromGame2, true)}
          {lastLoser === me && fighterSelect(me, t.changeFighter, t.onlyLoser)}
          {lastLoser === other && fighterSelect(other, t.opponentFighter, t.opponentChanged)}
          <div className="choices game-result">
            <button type="button" onClick={() => apply(() => recordGame(def, set, me))}>{t.iWon(gameNo)}</button>
            <button type="button" onClick={() => apply(() => recordGame(def, set, other))}>{t.theyWon(gameNo)}</button>
          </div>
        </>
      ) : (
        <p>{t.setOver(winner === me)}</p>
      )}
      <button type="button" className="text" disabled={set.games.length === 0} onClick={() => apply(() => undoGame(set))}>
        {t.undo}
      </button>
      {error && (
        <Dock>
          <p className="notice bad" role="alert">{error}</p>
        </Dock>
      )}
    </div>
  );
}
