import { deviceValidAt } from '@nostr-rating/core';
import { decodeDeviceRequest, deviceRequestCheck } from '../account/account.js';
import { QrScanner } from './QrScanner.js';
import { useState } from 'react';
import { messages, useLocale, useT, type Locale } from '../i18n.js';
import { useApp } from '../state/AppContext.js';

const date = (t: number, l: Locale) => new Date(t * 1000).toLocaleDateString(l === 'ja' ? 'ja-JP' : l);

const M = messages({
  ja: {
    thisDevice: '（この端末）',
    expires: (d: string) => `期限 ${d}`,
    confirmRevoke: (label: string) => `「${label}」を取り消しますか？その端末ではもう対戦できなくなります。`,
    revoked: '取り消しました',
    revoke: '取り消す',
    add: '端末を追加',
    addHint: '新しい端末で「すでにアカウントを持っている」を選ぶと表示される QR コードを読み取るか、「端末の申請」の文字列を貼ってください。',
    scan: 'QR を読み取る',
    request: '端末の申請',
    requestCheck: (label: string, check: string) => `追加する端末: ${label}（確認の番号 ${check}）`,
    checkHint: '新しい端末の画面に出ている確認の番号と同じかを確かめてから追加してください。',
    added: 'この端末を追加しました',
    addThis: 'この端末を追加',
  },
  en: {
    thisDevice: ' (this device)',
    expires: (d: string) => `Expires ${d}`,
    confirmRevoke: (label: string) => `Revoke "${label}"? That device will no longer be able to play matches.`,
    revoked: 'Revoked',
    revoke: 'Revoke',
    add: 'Add a device',
    addHint: 'On the new device, choose "I already have an account" and scan the QR code it shows, or paste its device request text.',
    scan: 'Scan QR code',
    request: 'Device request',
    requestCheck: (label: string, check: string) => `Device to add: ${label} (check number ${check})`,
    checkHint: 'Before adding it, make sure the check number matches the one shown on the new device.',
    added: 'Added this device',
    addThis: 'Add this device',
  },
});

/** 端末の一覧・取り消し・追加（ヘルプ「2台目を登録する」「困ったとき」） */
export function Devices() {
  const app = useApp();
  const tx = useT(M);
  const l = useLocale();
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
                {d.record.id === app.account!.deviceId ? tx.thisDevice : ''}
              </span>
              <span className="muted">{tx.expires(date(d.record.expiresAt, l))}</span>
            </span>
            {d.record.id !== app.account!.deviceId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(tx.confirmRevoke(d.record.label))) {
                    void run(() => app.account!.revoke(d.record.id), tx.revoked);
                  }
                }}
              >
                {tx.revoke}
              </button>
            )}
          </li>
        ))}
      </ul>
      <h3>{tx.add}</h3>
      <p className="hint">{tx.addHint}</p>
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
          {tx.scan}
        </button>
      )}
      <div className="field">
        <label htmlFor="device-request-input">{tx.request}</label>
        <textarea id="device-request-input" rows={3} autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
        <p className="slot" data-testid="device-check">{request ? tx.requestCheck(request.label, String(deviceRequestCheck(request))) : ''}</p>
      </div>
      <p className="hint">{tx.checkHint}</p>
      <button type="button" className="wide" disabled={busy || !request} onClick={() => void run(async () => void (await app.account!.addDevice(code)), tx.added)}>
        {tx.addThis}
      </button>
      <p className="slot" role="status">{message ?? ''}</p>
    </div>
  );
}
