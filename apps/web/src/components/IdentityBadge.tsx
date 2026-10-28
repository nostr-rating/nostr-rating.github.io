import { proofUrl, verifyClaim, type IdentityClaim, type Pubkey, type VerifyStatus } from '@nostr-rating/core';
import { useEffect, useState } from 'react';

const LABEL: Record<VerifyStatus, string> = {
  verified: '確認済み',
  failed: '確認できませんでした',
};
const CLASS: Record<VerifyStatus, string> = { verified: 'ok', failed: 'ng' };

export function StatusBadge({ status }: { status: VerifyStatus }) {
  return <span className={`badge ${CLASS[status]}`}>{LABEL[status]}</span>;
}

const PLATFORM: Record<IdentityClaim['platform'], string> = { github: 'GitHub', twitter: 'X' };

/**
 * 相手の紐づけ。主張ごとに確かめて状態を出す（docs/protocol.md「外部アカウントの紐づけ」）。
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

  if (claims === undefined) return <span className="muted">紐づけを確認中…</span>;
  if (claims.length === 0) return <span className="badge ng">紐づけなし</span>;
  return (
    <span className="stack">
      {claims.map((c) => {
        const key = `${c.platform}:${c.identity}`;
        return (
          <span key={key} className="row">
            <a className="chip" href={proofUrl(c)} target="_blank" rel="noreferrer noopener">
              {PLATFORM[c.platform]}: {c.identity}
            </a>
            {pubkey && fetchFn && (status[key] ? <StatusBadge status={status[key]} /> : <span className="muted">確認中…</span>)}
          </span>
        );
      })}
    </span>
  );
}
