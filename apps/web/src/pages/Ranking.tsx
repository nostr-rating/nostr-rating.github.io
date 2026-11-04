import { useEffect } from 'react';
import { LinkedAccounts } from '../components/LinkedAccounts.js';
import { IdentityBadge } from '../components/IdentityBadge.js';
import { messages, useT } from '../i18n.js';
import { displayName, useApp } from '../state/AppContext.js';

const M = messages({
  ja: {
    title: (season: number) => `ランキング（シーズン ${season}）`,
    provisional: '締め切り（対戦から24時間）前の対戦は暫定値です。',
    noRecords: 'まだ対戦記録がありません。',
    rank: '順位',
    name: '名前',
    rating: 'レート',
    winLoss: '勝敗',
    manners: 'マナー',
    shareText: 'Nostr-Rating の戦績',
    share: 'レートを X に投稿',
    shareHint: '投稿のカードには、毎日の集計で確定したレートが出ます。',
    ratingRd: (r: string, rd: string) => `${r}（RD ${rd}）`,
    peak: '最高レート',
    record: (w: number, l: number, n: number) => `${w}勝 ${l}敗（${n}戦）`,
    mannersLong: 'マナーの目安',
    mannersDetail: (noReport: number, cancel: number, mismatch: number) => `未報告 ${noReport} / 中止 ${cancel} / 食い違い ${mismatch}`,
    noSeasonRecord: 'このシーズンの記録はありません。',
    pastSeason: (season: string, final: string, peak: string, w: number, l: number) => `シーズン ${season}: 最終レート ${final}（最高 ${peak}）・${w}勝 ${l}敗`,
  },
  en: {
    title: (season: number) => `Ranking (Season ${season})`,
    provisional: 'Matches before their deadline (24 hours after the match) are provisional.',
    noRecords: 'No match records yet.',
    rank: 'Rank',
    name: 'Name',
    rating: 'Rating',
    winLoss: 'W-L',
    manners: 'Manners',
    shareText: 'My Nostr-Rating record',
    share: 'Post my rating on X',
    shareHint: 'The card in the post shows the rating confirmed by the daily tally.',
    ratingRd: (r: string, rd: string) => `${r} (RD ${rd})`,
    peak: 'Peak rating',
    record: (w: number, l: number, n: number) => `${w}W ${l}L (${n} matches)`,
    mannersLong: 'Manners',
    mannersDetail: (noReport: number, cancel: number, mismatch: number) => `no report ${noReport} / canceled ${cancel} / mismatched ${mismatch}`,
    noSeasonRecord: 'No records this season.',
    pastSeason: (season: string, final: string, peak: string, w: number, l: number) => `Season ${season}: final rating ${final} (peak ${peak}), ${w}W ${l}L`,
  },
});

export function Ranking() {
  const app = useApp();
  const t = useT(M);
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
      <h2>{t.title(app.ratings.season)}</h2>
      <p className="hint">{t.provisional}</p>
      {rows.length === 0 ? (
        <p>{t.noRecords}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">{t.rank}</th>
              <th>{t.name}</th>
              <th className="num">{t.rating}</th>
              <th className="num">{t.winLoss}</th>
              <th className="num">{t.manners}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([pk, p], i) => (
              <tr key={pk} className={pk === app.pubkey ? 'me' : undefined}>
                <td className="num">{i + 1}</td>
                <td>
                  <a href={`#/player/${pk}`}>{displayName(app, pk)}</a>
                </td>
                <td className="num">{p.rating.toFixed(0)}</td>
                <td className="num">{p.wins}-{p.losses}</td>
                <td className="num">{p.manners.noReport + p.manners.cancel + p.manners.mismatch}</td>
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
  const t = useT(M);
  const p = app.ratings.players[pubkey];
  return (
    <section className="card">
      <h2>{displayName(app, pubkey)}</h2>
      <IdentityBadge claims={app.identities[pubkey]} pubkey={pubkey} fetchFn={app.fetchFn} />
      <details>
        <summary>ID</summary>
        <p className="mono muted">{pubkey}</p>
      </details>
      {pubkey === app.pubkey && (
        <a
          className="button primary"
          href={`https://x.com/intent/post?text=${encodeURIComponent(t.shareText)}&url=${encodeURIComponent(new URL(`${import.meta.env.BASE_URL}p/${pubkey}.html`, location.origin).href)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t.share}
        </a>
      )}
      {pubkey === app.pubkey && <p className="hint">{t.shareHint}</p>}
      {p ? (
        <table>
          <tbody>
            <tr><th>{t.rating}</th><td>{t.ratingRd(p.rating.toFixed(1), p.rd.toFixed(1))}</td></tr>
            <tr><th>{t.peak}</th><td>{p.peakRating.toFixed(1)}</td></tr>
            <tr><th>{t.winLoss}</th><td>{t.record(p.wins, p.losses, p.matches)}</td></tr>
            <tr><th>{t.mannersLong}</th><td>{t.mannersDetail(p.manners.noReport, p.manners.cancel, p.manners.mismatch)}</td></tr>
          </tbody>
        </table>
      ) : (
        <p>{t.noSeasonRecord}</p>
      )}
      {Object.entries(app.ratings.seasonSummaries)
        .filter(([, players]) => players[pubkey])
        .sort(([a], [b]) => Number(b) - Number(a))
        .map(([season, players]) => {
          const x = players[pubkey]!;
          return (
            <p key={season} className="muted">
              {t.pastSeason(season, x.finalRating.toFixed(0), x.peakRating.toFixed(0), x.wins, x.losses)}
            </p>
          );
        })}
      <LinkedAccounts pubkey={pubkey} />
    </section>
  );
}
