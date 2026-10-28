import { useMemo, useState } from 'react';

/** 書き写したかを確かめるために、12語のうち3つを入力してもらう */
function pickThree(): number[] {
  const all = Array.from({ length: 12 }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, 3).sort((a, b) => a - b);
}

/** 復活の言葉の表示と、書き写したかの確認（ヘルプ「はじめかた」） */
export function RecoveryWords({ words, onConfirmed, onLater }: { words: string; onConfirmed(): void; onLater?(): void }) {
  const list = words.split(' ');
  const [checking, setChecking] = useState(false);
  const positions = useMemo(pickThree, []);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [wrong, setWrong] = useState(false);

  const submit = () => {
    const ok = positions.every((p, i) => answers[i]!.trim().toLowerCase() === list[p]);
    setWrong(!ok);
    if (ok) onConfirmed();
  };

  if (!checking) {
    return (
      <div className="stack">
        <p>端末を全部失くしたときに、アカウントを戻すための12個の単語です。紙に書き写してしまっておいてください。写真やスマホのメモ、クラウドには保存しないでください。</p>
        <ol className="words" data-testid="recovery-words">
          {list.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <button type="button" className="primary" onClick={() => setChecking(true)}>
          書き写した
        </button>
        {onLater && (
          <button type="button" onClick={onLater}>
            あとで書く
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="stack">
      <p>書き写せたかを確かめます。次の番号の単語を入力してください。</p>
      {positions.map((p, i) => (
        <label key={p} className="stack">
          {p + 1}番目
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
      <button type="button" onClick={() => setChecking(false)}>
        単語をもう一度見る
      </button>
    </div>
  );
}
