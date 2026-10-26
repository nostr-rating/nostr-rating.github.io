import { encodeNsec } from '@nostr-rating/core';
import { useEffect, useState } from 'react';
import { loadLocalSecretKey, markBackedUp } from '../services/signer-local.js';
import { useApp } from '../state/AppContext.js';

/** アプリ内鍵の書き出し。NIP-07 の利用者は鍵を拡張機能が持っているので表示しない */
export function KeyBackup({ onDone }: { onDone?: () => void }) {
  const app = useApp();
  const [nsec, setNsec] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [checked, setChecked] = useState(app.backedUp);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (app.signerKind !== 'local') return;
    void loadLocalSecretKey().then((sk) => setNsec(sk ? encodeNsec(sk) : null));
  }, [app.signerKind, app.pubkey]);

  if (app.signerKind !== 'local') {
    return <p className="muted">アカウントはブラウザ拡張機能が管理しています。バックアップは拡張機能側で行ってください。</p>;
  }

  const download = () => {
    if (!nsec) return;
    const blob = new Blob([`Nostr-Rating の引き継ぎコード（他人に見せないでください）\n${nsec}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nostr-rating-key.txt';
    a.click();
    // Safari はクリックの直後に URL を無効にすると保存に失敗することがある
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };

  const finish = async () => {
    await markBackedUp();
    app.setBackedUp(true);
    onDone?.();
  };

  return (
    <div className="stack">
      <p>
        引き継ぎコードは、あなたのアカウントそのものです。ブラウザのデータを消すとこの端末からも消え、コードがないとレートや戦績を引き継げません。
        パスワード管理アプリなど、安全な場所に保存してください。他人には見せないでください。
      </p>
      <div className="row">
        <button type="button" onClick={() => setShown((v) => !v)}>{shown ? '隠す' : 'コードを表示'}</button>
        <button
          type="button"
          onClick={() =>
            nsec &&
            void navigator.clipboard?.writeText(nsec).then(
              () => setCopied('コピーしました'),
              () => setCopied('コピーできませんでした。「コードを表示」から書き写してください'),
            )
          }
        >
          コピー
        </button>
        <button type="button" onClick={download}>ファイルに保存</button>
      </div>
      {copied && <p className="muted" role="status">{copied}</p>}
      {shown && nsec && <p className="mono" data-testid="nsec">{nsec}</p>}
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        安全な場所に保存しました
      </label>
      {onDone && (
        <button type="button" className="primary" disabled={!checked} onClick={() => void finish()}>
          対戦をはじめる
        </button>
      )}
      {!onDone && !app.backedUp && (
        <button type="button" disabled={!checked} onClick={() => void finish()}>
          保存済みにする
        </button>
      )}
    </div>
  );
}
