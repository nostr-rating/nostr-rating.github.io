import { useEffect, useState } from 'react';

/**
 * 押したらコピーし、ボタンの文字を「コピーしました」に3秒変える。
 * 文字は重ねて置いてあり、ボタンの幅は変わらない（横の要素を動かさない）
 */
export function CopyButton(props: { text: string | null; children: string; className?: string }) {
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

  const message = result === 'copied' ? 'コピーしました' : result === 'failed' ? 'コピーできませんでした。文字を長押しして選び、コピーしてください' : '';
  return (
    <button type="button" className={props.className} disabled={props.text === null} onClick={() => void copy()}>
      <span className="copy-button" aria-hidden="true">
        <span className={result === null ? 'on' : ''}>{props.children}</span>
        <span className={result === 'copied' ? 'on' : ''}>コピーしました</span>
        <span className={result === 'failed' ? 'on' : ''}>失敗しました</span>
      </span>
      <span className="sr-only">{props.children}</span>
      <span className="sr-only" role="status">{message}</span>
    </button>
  );
}
