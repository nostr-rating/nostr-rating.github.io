import { useEffect, useState } from 'react';
import { messages, useT } from '../i18n.js';

const M = messages({
  ja: { copied: 'コピーしました', failed: '失敗しました', failedHelp: 'コピーできませんでした。文字を長押しして選び、コピーしてください' },
  en: { copied: 'Copied', failed: 'Failed', failedHelp: 'Could not copy. Press and hold the text to select it, then copy it.' },
});

/**
 * 押したらコピーし、ボタンの文字を「コピーしました」に3秒変える。
 * 文字は重ねて置いてあり、ボタンの幅は変わらない（横の要素を動かさない）
 */
export function CopyButton(props: { text: string | null; children: string; className?: string }) {
  const t = useT(M);
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 3000);
    return () => clearTimeout(timer);
  }, [result]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text!);
      setResult('copied');
    } catch {
      setResult('failed');
    }
  };

  const message = result === 'copied' ? t.copied : result === 'failed' ? t.failedHelp : '';
  return (
    <button type="button" className={props.className} disabled={props.text === null} onClick={() => void copy()}>
      <span className="copy-button" aria-hidden="true">
        <span className={result === null ? 'on' : ''}>{props.children}</span>
        <span className={result === 'copied' ? 'on' : ''}>{t.copied}</span>
        <span className={result === 'failed' ? 'on' : ''}>{t.failed}</span>
      </span>
      <span className="sr-only">{props.children}</span>
      <span className="sr-only" role="status">{message}</span>
    </button>
  );
}
