import { deviceValidAt } from '@nostr-rating/core';
import { decodeDeviceRequest, deviceRequestCheck } from '../account/account.js';
import { QrScanner } from './QrScanner.js';
import { useState } from 'react';
import { useApp } from '../state/AppContext.js';

const date = (t: number) => new Date(t * 1000).toLocaleDateString('ja-JP');

/** 端末の一覧・取り消し・追加（ヘルプ「2台目を登録する」「困ったとき」） */
export function Devices() {
  const app = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const state = app.account?.state;
  if (!app.account || !state) return null;
  const t = app.now();
  const devices = [...state.devices.values()].filter((d) => deviceValidAt(state, d.record.id, t));
  const request = decodeDeviceRequest(code);

  const run = async (f: () => Promise<void>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await f();
      await app.reloadAccount();
      setMessage(done);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ul className="device-list" data-testid="devices">
        {devices.map((d) => (
          <li key={d.record.id}>
            <span>
              <span className="device-name">
                {d.record.label}
                {d.record.id === app.account!.deviceId ? '（この端末）' : ''}
              </span>
              <span className="muted">期限 {date(d.record.expiresAt)}</span>
            </span>
            {d.record.id !== app.account!.deviceId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`「${d.record.label}」を取り消しますか？その端末ではもう対戦できなくなります。`)) {
                    void run(() => app.account!.revoke(d.record.id), '取り消しました');
                  }
                }}
              >
                取り消す
              </button>
            )}
          </li>
        ))}
      </ul>
      <h3>端末を追加</h3>
      <p className="hint">新しい端末で「すでにアカウントを持っている」を選ぶと表示される QR コードを読み取るか、「端末の申請」の文字列を貼ってください。</p>
      {scanning ? (
        <QrScanner
          accept={(t) => decodeDeviceRequest(t) !== null}
          onResult={(t) => {
            setCode(t);
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      ) : (
        <button type="button" onClick={() => setScanning(true)}>
          QR を読み取る
        </button>
      )}
      <div className="field">
        <label htmlFor="device-request-input">端末の申請</label>
        <textarea id="device-request-input" rows={3} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
        <p className="slot" data-testid="device-check">{request ? `追加する端末: ${request.label}（確認の番号 ${deviceRequestCheck(request)}）` : ''}</p>
      </div>
      <p className="hint">新しい端末の画面に出ている確認の番号と同じかを確かめてから追加してください。</p>
      <button type="button" className="wide" disabled={busy || !request} onClick={() => void run(async () => void (await app.account!.addDevice(code)), 'この端末を追加しました')}>
        この端末を追加
      </button>
      <p className="slot" role="status">{message ?? ''}</p>
    </div>
  );
}
