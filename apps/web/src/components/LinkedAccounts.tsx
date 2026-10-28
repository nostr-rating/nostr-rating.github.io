import { accountsSharingClaims, claimKey, verifyClaim, type IdentityClaim, type Pubkey } from '@nostr-rating/core';
import { useEffect, useState } from 'react';
import { displayName, useApp } from '../state/AppContext.js';

const PLATFORM: Record<IdentityClaim['platform'], string> = { github: 'GitHub', twitter: 'X' };

/**
 * 同じ X / GitHub を紐づけた別のアカウント（復活の言葉を失くして作り直す前のアカウントなど）と、
 * その過去のシーズンの成績。双方の紐づけを確かめられたものだけを出す
 */
export function LinkedAccounts({ pubkey }: { pubkey: Pubkey }) {
  const app = useApp();
  const [linked, setLinked] = useState<{ aid: Pubkey; via: IdentityClaim[] }[]>([]);
  const accounts = Object.fromEntries(
    [...new Set([...Object.keys(app.ratings.accounts), ...Object.keys(app.identities)])].map((aid) => [
      aid,
      { claims: app.identities[aid] ?? app.ratings.accounts[aid]?.claims ?? [] },
    ]),
  );
  const candidates = accountsSharingClaims(accounts, pubkey);
  const key = JSON.stringify(candidates);

  useEffect(() => {
    let alive = true;
    const mine = accounts[pubkey]?.claims ?? [];
    void (async () => {
      const ok = async (c: IdentityClaim, aid: Pubkey) => (await verifyClaim(c, aid, app.fetchFn)) === 'verified';
      const out: { aid: Pubkey; via: IdentityClaim[] }[] = [];
      for (const cand of candidates) {
        const via: IdentityClaim[] = [];
        for (const theirs of cand.claims) {
          const own = mine.find((c) => claimKey(c) === claimKey(theirs));
          if (own && (await ok(own, pubkey)) && (await ok(theirs, cand.aid))) via.push(own);
        }
        if (via.length > 0) out.push({ aid: cand.aid, via });
      }
      if (alive) setLinked(out);
    })();
    return () => {
      alive = false;
    };
    // 候補が変わったときだけ確かめ直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, key, app.fetchFn]);

  const rows = linked.flatMap(({ aid, via }) =>
    Object.entries(app.ratings.seasonSummaries)
      .filter(([, players]) => players[aid])
      .map(([season, players]) => ({ aid, via, season, x: players[aid]! })),
  );
  if (rows.length === 0) return null;
  return (
    <div className="stack" data-testid="linked-accounts">
      <h3>以前のアカウントの成績</h3>
      {rows
        .sort((a, b) => Number(b.season) - Number(a.season))
        .map(({ aid, via, season, x }) => (
          <p key={`${aid}:${season}`} className="muted">
            シーズン {season}: 最終レート {x.finalRating.toFixed(0)}（最高 {x.peakRating.toFixed(0)}）・{x.wins}勝 {x.losses}敗
            {`（${displayName(app, aid)}、同じ ${via.map((c) => `${PLATFORM[c.platform]}: ${c.identity}`).join('・')} を紐づけ）`}
          </p>
        ))}
    </div>
  );
}
