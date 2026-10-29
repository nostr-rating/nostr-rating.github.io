import { useMemo, useState } from 'react';
import { Dock } from './Dock.js';

function shuffled(n: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all;
}

/** 書き写したかを確かめる単語。1枚なら3語、分けたときは1枚につき1語 */
function pickChecks(cards: number): { card: number; pos: number }[] {
  if (cards === 1) return shuffled(12).slice(0, 3).sort((a, b) => a - b).map((pos) => ({ card: 0, pos }));
  return Array.from({ length: cards }, (_, card) => ({ card, pos: shuffled(12)[0]! }));
}

/**
 * 復活の言葉の表示と、書き写したかの確認（ヘルプ「はじめかた」）。
 * words は1枚ずつ改行で区切る。onSplit を渡すと、1枚の言葉を3枚に分けられる。
 * onSkip を渡すと、書き写さずに始められる。onConfirmed と onSkip が失敗したら、その画面のままエラーを出す
 */
export function RecoveryWords({
  words,
  onConfirmed,
  onSplit,
  onSkip,
}: {
  words: string;
  onConfirmed(): Promise<void> | void;
  onSplit?(): void;
  onSkip?(): Promise<void>;
}) {
  const cards = words.split('\n').map((c) => c.split(' '));
  const [card, setCard] = useState(0);
  const [checking, setChecking] = useState(false);
  const checks = useMemo(() => pickChecks(cards.length), [cards.length]);
  const [answers, setAnswers] = useState<string[]>(() => checks.map(() => ''));
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const many = cards.length > 1;

  const run = async (action: () => Promise<void> | void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const ok = checks.every((c, i) => answers[i]!.trim().toLowerCase() === cards[c.card]![c.pos]);
    setWrong(!ok);
    if (ok) await run(onConfirmed);
  };

  const split = () => {
    onSplit!();
    setCard(0);
  };

  if (!checking) {
    return (
      <div className="stack">
        {many ? (
          <p>
            復活の言葉を{cards.length}枚に分けました。1枚ずつ別の紙に書き写し、別々の場所にしまってください。{cards.length}枚のうち2枚あれば復元できます。
          </p>
        ) : (
          <p>端末を全部失くしたときに、アカウントを復元するための12個の単語です。紙に書き写してしまっておいてください。写真やスマホのメモ、クラウドには保存しないでください。</p>
        )}
        {many && (
          <p className="muted" data-testid="card-number">
            {card + 1}枚目／{cards.length}枚
          </p>
        )}
        <ol className="words" data-testid="recovery-words">
          {cards[card]!.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <button type="button" className="primary wide" onClick={() => (card + 1 < cards.length ? setCard(card + 1) : setChecking(true))}>
          {card + 1 < cards.length ? `${card + 1}枚目を書き写した` : '書き写した'}
        </button>
        {!many && onSplit && (
          <div className="field">
            <button type="button" className="wide" onClick={split}>
              3枚に分けて保管する
            </button>
            <p className="hint">分散させて保管したい場合に有効です。3枚のうち2枚があれば復元できる状態となります。</p>
          </div>
        )}
        {!many && onSkip && (
          <div className="field">
            <button type="button" className="wide" disabled={busy} onClick={() => void run(onSkip)}>
              書き写さずに始める
            </button>
            <p className="notice" data-testid="skip-hint">
              <span>書き写さずに始めると、端末を全部失くしたときにアカウントを復元できません。</span>
            </p>
          </div>
        )}
        {error && (
          <Dock>
            <p className="notice bad" role="alert">{error}</p>
          </Dock>
        )}
      </div>
    );
  }
  return (
    <div className="stack">
      <p>書き写せたかを確かめます。次の単語を入力してください。</p>
      {checks.map((c, i) => (
        <label key={`${c.card}:${c.pos}`} className="inline">
          {many ? `${c.card + 1}枚目の${c.pos + 1}番目` : `${c.pos + 1}番目`}
          <input
            autoComplete="off"
            autoCapitalize="none"
            value={answers[i]}
            onChange={(e) => setAnswers((prev) => prev.map((x, k) => (k === i ? e.target.value : x)))}
          />
        </label>
      ))}
      <p className="slot error" role="alert">
        {wrong ? '違う単語があります。紙を見直してください。' : ''}
      </p>
      <button type="button" className="primary wide" disabled={busy} onClick={() => void submit()}>
        {busy ? '作成中…' : '確かめる'}
      </button>
      <button
        type="button"
        className="text"
        disabled={busy}
        onClick={() => {
          setChecking(false);
          setCard(0);
        }}
      >
        単語をもう一度見る
      </button>
      {error && (
        <Dock>
          <p className="notice bad" role="alert">{error}</p>
        </Dock>
      )}
    </div>
  );
}
