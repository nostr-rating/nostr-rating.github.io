import { useEffect } from 'react';
import { LinkedAccounts } from '../components/LinkedAccounts.js';
import { IdentityBadge } from '../components/IdentityBadge.js';
import { displayName, useApp } from '../state/AppContext.js';

export function Ranking() {
  const app = useApp();
  useEffect(() => {
    if (app.pubkey) void app.refresh();
    // 画面を開いたときに最新のレートを読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.pubkey]);
  const rows = Object.entries(app.ratings.players)
    .filter(([, p]) => p.matches > 0)
    .sort(([, a], [, b]) => b.rating - a.rating);

  return (
    <section className="card">
      <h2>ランキング（シーズン {app.ratings.season}）</h2>
      <p className="muted">締め切り（対戦から24時間）前の対戦は暫定値です。</p>
      {rows.length === 0 ? (
        <p>まだ対戦記録がありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>名前</th>
              <th>レート</th>
              <th>勝敗</th>
              <th>マナー</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([pk, p], i) => (
              <tr key={pk} className={pk === app.pubkey ? 'me' : undefined}>
                <td>{i + 1}</td>
                <td>
                  <a href={`#/player/${pk}`}>{displayName(app, pk)}</a>
                </td>
                <td>{p.rating.toFixed(0)}</td>
                <td>{p.wins}-{p.losses}</td>
                <td>{p.manners.noReport + p.manners.cancel + p.manners.mismatch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Player({ pubkey }: { pubkey: string }) {
  const app = useApp();
  const p = app.ratings.players[pubkey];
  return (
    <section className="card stack">
      <h2>{displayName(app, pubkey)}</h2>
      <IdentityBadge claims={app.identities[pubkey]} pubkey={pubkey} fetchFn={app.fetchFn} />
      <details>
        <summary>ID</summary>
        <p className="mono muted">{pubkey}</p>
      </details>
      {pubkey === app.pubkey && (
        <a
          className="button"
          href={`https://x.com/intent/post?text=${encodeURIComponent('Nostr-Rating の戦績')}&url=${encodeURIComponent(new URL(`${import.meta.env.BASE_URL}p/${pubkey}.html`, location.origin).href)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          レートを X に投稿
        </a>
      )}
      {pubkey === app.pubkey && <p className="muted">投稿のカードには、毎日の集計で確定したレートが出ます。</p>}
      {p ? (
        <table>
          <tbody>
            <tr><th>レート</th><td>{p.rating.toFixed(1)}（RD {p.rd.toFixed(1)}）</td></tr>
            <tr><th>最高レート</th><td>{p.peakRating.toFixed(1)}</td></tr>
            <tr><th>勝敗</th><td>{p.wins}勝 {p.losses}敗（{p.matches}戦）</td></tr>
            <tr><th>マナーの目安</th><td>未報告 {p.manners.noReport} / 中止 {p.manners.cancel} / 食い違い {p.manners.mismatch}</td></tr>
          </tbody>
        </table>
      ) : (
        <p>このシーズンの記録はありません。</p>
      )}
      {Object.entries(app.ratings.seasonSummaries)
        .filter(([, players]) => players[pubkey])
        .sort(([a], [b]) => Number(b) - Number(a))
        .map(([season, players]) => {
          const x = players[pubkey]!;
          return (
            <p key={season} className="muted">
              シーズン {season}: 最終レート {x.finalRating.toFixed(0)}（最高 {x.peakRating.toFixed(0)}）・{x.wins}勝 {x.losses}敗
            </p>
          );
        })}
      <LinkedAccounts pubkey={pubkey} />
    </section>
  );
}
