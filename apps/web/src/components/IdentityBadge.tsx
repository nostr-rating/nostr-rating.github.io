import { proofUrl, verifyClaim, type IdentityClaim, type Pubkey, type VerifyStatus } from '@nostr-rating/core';
import { useEffect, useState } from 'react';
import { messages, useT } from '../i18n.js';

const M = messages({
  ja: {
    status: { verified: '確認済み', failed: '確認できませんでした' } as Record<VerifyStatus, string>,
    checkingLinks: '紐づけを確認中…',
    noLinks: '紐づけなし',
    checking: '確認中…',
  },
  en: {
    status: { verified: 'Verified', failed: 'Could not verify' },
    checkingLinks: 'Checking linked accounts…',
    noLinks: 'No linked accounts',
    checking: 'Checking…',
  },
});
const CLASS: Record<VerifyStatus, string> = { verified: 'ok', failed: 'ng' };

export function StatusBadge({ status }: { status: VerifyStatus }) {
  const t = useT(M);
  return <span className={`badge ${CLASS[status]}`}>{t.status[status]}</span>;
}

const PLATFORM: Record<IdentityClaim['platform'], string> = { github: 'GitHub', twitter: 'X' };

/**
 * 相手の紐づけ。主張ごとに確かめて状態を出す（docs/spec.md「外部アカウントの紐づけ」）。
 * claims が undefined の間は読み込み中で、「なし」とは出さない。
 */
export function IdentityBadge({
  claims,
  pubkey,
  fetchFn,
}: {
  claims: IdentityClaim[] | undefined;
  pubkey?: Pubkey;
  fetchFn?: typeof fetch;
}) {
  const t = useT(M);
  const [status, setStatus] = useState<Record<string, VerifyStatus>>({});
  useEffect(() => {
    if (!claims || !pubkey || !fetchFn) return;
    let alive = true;
    for (const c of claims) {
      void verifyClaim(c, pubkey, fetchFn).then((s) => {
        if (alive) setStatus((prev) => ({ ...prev, [`${c.platform}:${c.identity}`]: s }));
      });
    }
    return () => {
      alive = false;
    };
  }, [claims, pubkey, fetchFn]);

  if (claims === undefined) return <div className="claims"><span className="claim muted">{t.checkingLinks}</span></div>;
  if (claims.length === 0) return <div className="claims"><span className="claim"><span className="badge ng">{t.noLinks}</span></span></div>;
  return (
    <span className="claims">
      {claims.map((c) => {
        const key = `${c.platform}:${c.identity}`;
        return (
          <span key={key} className="claim">
            <a className="chip" href={proofUrl(c)} target="_blank" rel="noreferrer noopener">
              {PLATFORM[c.platform]}: {c.identity}
            </a>
            {pubkey && fetchFn && (status[key] ? <StatusBadge status={status[key]} /> : <span className="muted">{t.checking}</span>)}
          </span>
        );
      })}
    </span>
  );
}
