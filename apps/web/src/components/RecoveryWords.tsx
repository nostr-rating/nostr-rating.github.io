import { useMemo, useState } from 'react';

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
 * words は1枚ずつ改行で区切る。onSplit を渡すと、1枚の言葉を3枚に分けられる
 */
export function RecoveryWords({
  words,
  onConfirmed,
  onLater,
  onSplit,
}: {
  words: string;
  onConfirmed(): void;
  onLater?(): void;
  onSplit?(): Promise<void>;
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

  const submit = () => {
    const ok = checks.every((c, i) => answers[i]!.trim().toLowerCase() === cards[c.card]![c.pos]);
    setWrong(!ok);
    if (ok) onConfirmed();
  };

  const split = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSplit!();
      setCard(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!checking) {
    return (
      <div className="stack">
        {many ? (
          <p>
            復活の言葉を{cards.length}枚に分けました。{cards.length}枚のうち2枚あれば戻せます。1枚ずつ別の紙に書き写し、別々の場所にしまってください（{card + 1}枚目／{cards.length}枚）。
          </p>
        ) : (
          <p>端末を全部失くしたときに、アカウントを戻すための12個の単語です。紙に書き写してしまっておいてください。写真やスマホのメモ、クラウドには保存しないでください。</p>
        )}
        <ol className="words" data-testid="recovery-words">
          {cards[card]!.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <button type="button" className="primary" disabled={busy} onClick={() => (card + 1 < cards.length ? setCard(card + 1) : setChecking(true))}>
          {card + 1 < cards.length ? `${card + 1}枚目を書き写した` : '書き写した'}
        </button>
        {!many && onSplit && (
          <button type="button" disabled={busy} onClick={() => void split()}>
            3枚に分けて保管する（2枚あれば戻せる）
          </button>
        )}
        {onLater && (
          <button type="button" disabled={busy} onClick={onLater}>
            あとで書く
          </button>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div className="stack">
      <p>書き写せたかを確かめます。次の単語を入力してください。</p>
      {checks.map((c, i) => (
        <label key={`${c.card}:${c.pos}`} className="stack">
          {many ? `${c.card + 1}枚目の${c.pos + 1}番目` : `${c.pos + 1}番目`}
          <input
            autoComplete="off"
            autoCapitalize="none"
            value={answers[i]}
            onChange={(e) => setAnswers((prev) => prev.map((x, k) => (k === i ? e.target.value : x)))}
          />
        </label>
      ))}
      {wrong && <p className="error" role="alert">違う単語があります。紙を見直してください。</p>}
      <button type="button" className="primary" onClick={submit}>
        確かめる
      </button>
      <button
        type="button"
        onClick={() => {
          setChecking(false);
          setCard(0);
        }}
      >
        単語をもう一度見る
      </button>
    </div>
  );
}
