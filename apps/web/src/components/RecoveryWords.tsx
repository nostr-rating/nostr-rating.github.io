import { useMemo, useState } from 'react';
import { messages, useT } from '../i18n.js';
import { Dock } from './Dock.js';

const M = messages({
  ja: {
    splitDone: (n: number) => `復活の言葉を${n}枚に分けました。1枚ずつ別の紙に書き写し、別々の場所にしまってください。${n}枚のうち2枚あれば復元できます。`,
    intro: '端末を全部失くしたときに、アカウントを復元するための12個の単語です。紙に書き写してしまっておいてください。写真やスマホのメモ、クラウドには保存しないでください。',
    cardNumber: (card: number, n: number) => `${card}枚目／${n}枚`,
    copiedCard: (card: number) => `${card}枚目を書き写した`,
    copied: '書き写した',
    split: '3枚に分けて保管する',
    splitHint: '分散させて保管したい場合に有効です。3枚のうち2枚があれば復元できる状態となります。',
    skip: '書き写さずに始める',
    skipHint: '書き写さずに始めると、端末を全部失くしたときにアカウントを復元できません。',
    check: '書き写せたかを確かめます。次の単語を入力してください。',
    wordOnCard: (card: number, pos: number) => `${card}枚目の${pos}番目`,
    word: (pos: number) => `${pos}番目`,
    wrong: '違う単語があります。紙を見直してください。',
    creating: '作成中…',
    confirm: '確かめる',
    showAgain: '単語をもう一度見る',
  },
  en: {
    splitDone: (n: number) => `Your recovery words are split into ${n} cards. Copy each card onto a separate sheet of paper and keep them in different places. Any 2 of the ${n} cards can restore your account.`,
    intro: 'These 12 words restore your account if you lose all your devices. Write them down on paper and keep it safe. Do not save them in photos, phone notes, or cloud storage.',
    cardNumber: (card: number, n: number) => `Card ${card} of ${n}`,
    copiedCard: (card: number) => `I wrote down card ${card}`,
    copied: 'I wrote them down',
    split: 'Split into 3 cards',
    splitHint: 'Useful if you want to keep them in separate places. Any 2 of the 3 cards can restore your account.',
    skip: 'Start without writing them down',
    skipHint: 'If you start without writing them down, you cannot restore your account when you lose all your devices.',
    check: "Let's check that you wrote them down. Enter the following words.",
    wordOnCard: (card: number, pos: number) => `Card ${card}, word ${pos}`,
    word: (pos: number) => `Word ${pos}`,
    wrong: 'Some words are wrong. Check your paper again.',
    creating: 'Creating…',
    confirm: 'Check',
    showAgain: 'Show the words again',
  },
});

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
  const t = useT(M);
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
          <p>{t.splitDone(cards.length)}</p>
        ) : (
          <p>{t.intro}</p>
        )}
        {many && (
          <p className="muted" data-testid="card-number">
            {t.cardNumber(card + 1, cards.length)}
          </p>
        )}
        <ol className="words" data-testid="recovery-words">
          {cards[card]!.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <button type="button" className="primary wide" onClick={() => (card + 1 < cards.length ? setCard(card + 1) : setChecking(true))}>
          {card + 1 < cards.length ? t.copiedCard(card + 1) : t.copied}
        </button>
        {!many && onSplit && (
          <div className="field">
            <button type="button" className="wide" onClick={split}>
              {t.split}
            </button>
            <p className="hint">{t.splitHint}</p>
          </div>
        )}
        {!many && onSkip && (
          <div className="field">
            <button type="button" className="wide" disabled={busy} onClick={() => void run(onSkip)}>
              {t.skip}
            </button>
            <p className="notice" data-testid="skip-hint">
              <span>{t.skipHint}</span>
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
      <p>{t.check}</p>
      {checks.map((c, i) => (
        <label key={`${c.card}:${c.pos}`} className="inline">
          {many ? t.wordOnCard(c.card + 1, c.pos + 1) : t.word(c.pos + 1)}
          <input
            autoComplete="off"
            autoCapitalize="none"
            value={answers[i]}
            onChange={(e) => setAnswers((prev) => prev.map((x, k) => (k === i ? e.target.value : x)))}
          />
        </label>
      ))}
      <p className="slot error" role="alert">
        {wrong ? t.wrong : ''}
      </p>
      <button type="button" className="primary wide" disabled={busy} onClick={() => void submit()}>
        {busy ? t.creating : t.confirm}
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
        {t.showAgain}
      </button>
      {error && (
        <Dock>
          <p className="notice bad" role="alert">{error}</p>
        </Dock>
      )}
    </div>
  );
}
