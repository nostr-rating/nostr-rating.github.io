import { useEffect, useState } from 'react';

/** 押したらコピーし、できたかどうかを横に出す */
export function CopyButton(props: { text: string | null; children: string }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 3000);
    return () => clearTimeout(t);
  }, [result]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text!);
      setResult('copied');
    } catch {
      setResult('failed');
    }
  };

  return (
    <span className="copy">
      <button type="button" disabled={props.text === null} onClick={() => void copy()}>
        {props.children}
      </button>
      {result && (
        <span role="status" className="muted">
          {result === 'copied' ? 'コピーしました' : 'コピーできませんでした。長押しで選んでコピーしてください'}
        </span>
      )}
    </span>
  );
}
