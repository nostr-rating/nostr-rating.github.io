import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claimKey,
  proofUrl,
  sha256Hex,
  snapshotToState,
  verifyClaim,
  type IdentityClaim,
  type LatestPointer,
  type Snapshot,
} from '@nostr-rating/core';

export interface SiteOptions {
  /** リポジトリのルート（snapshots/ がある場所） */
  root: string;
  /** 書き出し先（GitHub Pages に載せるディレクトリ） */
  out: string;
  /** アプリの公開 URL（末尾の / 付き）。選手ページからのリンクに使う */
  appUrl: string;
  fetchFn: typeof fetch;
}

/** 公開 API の1人分（docs/api.md） */
export interface PlayerDoc {
  aid: string;
  name: string;
  season: number;
  rating: number;
  rd: number;
  peak_rating: number;
  matches: number;
  wins: number;
  losses: number;
  manners: { no_report: number; cancel: number; mismatch: number };
  accounts: { platform: IdentityClaim['platform']; identity: string; proof_url: string; verified: boolean }[];
  past_seasons: Record<string, { final_rating: number; peak_rating: number; matches: number; wins: number; losses: number }>;
  /**
   * 同じ外部アカウントを、双方とも確かめられた形で紐づけた別のアカウント（作り直す前のアカウントなど）。
   * 過去のシーズンの成績を引き継いで見せるのに使う
   */
  linked_accounts: { aid: string; name: string; via: { platform: IdentityClaim['platform']; identity: string }[]; past_seasons: PlayerDoc['past_seasons'] }[];
  snapshot: { path: string; sha256: string; cutoff: number };
}

/** 同時に確かめる紐づけの数（相手のサービスに負担をかけない） */
const CONCURRENCY = 4;

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await f(xs[k]!);
      }
    }),
  );
  return out;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const platformName = (p: IdentityClaim['platform']) => (p === 'twitter' ? 'X' : 'GitHub');

/** X に貼るとカードになる、選手ごとの静的ページ */
function playerPage(doc: PlayerDoc, appUrl: string): string {
  const name = doc.name || `${doc.aid.slice(0, 8)}…`;
  const title = `${name} のレート ${Math.round(doc.rating)}（シーズン${doc.season}）`;
  const desc = `Nostr-Rating ${doc.wins}勝${doc.losses}敗。${doc.snapshot.cutoff ? new Date(doc.snapshot.cutoff * 1000).toISOString().slice(0, 10) : ''} 時点の確定レート`;
  const accounts = doc.accounts
    .map(
      (a) =>
        `<li>${platformName(a.platform)}: <a href="${escapeHtml(a.proof_url)}" rel="noopener">${escapeHtml(a.identity)}</a> ${a.verified ? '（確認済み）' : '（確認できず）'}</li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Nostr-Rating</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${escapeHtml(`${appUrl}p/${doc.aid}.html`)}">
<meta name="twitter:card" content="summary">
<style>
body{font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;line-height:1.8;color:#18223a;background:#f5f7fa}
@media (prefers-color-scheme: dark){body{color:#e7ebf5;background:#10141f}a{color:#8ea4ff}}
.rating{font-size:48px;font-weight:700;margin:8px 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px}dd{margin:0}
code{word-break:break-all;font-size:13px}
</style>
</head>
<body>
<p><a href="${escapeHtml(appUrl)}">Nostr-Rating</a></p>
<h1>${escapeHtml(name)}</h1>
<p class="rating">${Math.round(doc.rating)}</p>
<dl>
<dt>シーズン</dt><dd>${doc.season}</dd>
<dt>戦績</dt><dd>${doc.matches}戦 ${doc.wins}勝 ${doc.losses}敗</dd>
<dt>最高レート</dt><dd>${Math.round(doc.peak_rating)}</dd>
</dl>
<h2>紐づけたアカウント</h2>
<ul>${accounts || '<li>なし</li>'}</ul>
<h2>根拠</h2>
<p>このレートは公開リポジトリのスナップショット <code>${escapeHtml(doc.snapshot.path)}</code>（sha256 <code>${doc.snapshot.sha256}</code>）の値です。誰でも同じイベントから計算し直して確かめられます。</p>
<p>アカウントの識別子: <code>${doc.aid}</code></p>
<p><a href="${escapeHtml(`${appUrl}api/v1/players/${doc.aid}.json`)}">JSON</a></p>
</body>
</html>
`;
}

/**
 * 最新のスナップショットから、公開 API（api/v1/）と選手ページ（p/）を書き出す。
 * 紐づけはこのとき X・GitHub に問い合わせて確かめ、確かめられたものだけを by/ の索引に入れる。
 */
export async function buildSite(opts: SiteOptions): Promise<{ players: number }> {
  const pointer = JSON.parse(readFileSync(join(opts.root, 'snapshots/latest.json'), 'utf8')) as LatestPointer;
  const text = readFileSync(join(opts.root, pointer.path), 'utf8');
  if (sha256Hex(text) !== pointer.sha256) throw new Error(`sha256 mismatch: ${pointer.path}`);
  const snapshot = JSON.parse(text) as Snapshot;
  const state = snapshotToState(snapshot);
  const ref = { path: pointer.path, sha256: pointer.sha256, cutoff: snapshot.cutoff };

  const aids = [...new Set([...Object.keys(state.players), ...Object.keys(state.accounts)])].sort();
  const pastOf = (aid: string) =>
    Object.fromEntries(
      Object.entries(snapshot.season_summaries ?? {})
        .filter(([, players]) => players[aid])
        .map(([season, players]) => [season, players[aid]!]),
    );

  const docs = await mapLimit(aids, CONCURRENCY, async (aid): Promise<PlayerDoc> => {
    const p = snapshot.players[aid];
    const account = state.accounts[aid];
    const claims = account?.claims ?? [];
    const verified = await mapLimit(claims, 1, (c) => verifyClaim(c, aid, opts.fetchFn));
    return {
      aid,
      name: account?.name ?? '',
      season: snapshot.season,
      rating: p?.rating ?? 0,
      rd: p?.rd ?? 0,
      peak_rating: p?.peak_rating ?? 0,
      matches: p?.matches ?? 0,
      wins: p?.wins ?? 0,
      losses: p?.losses ?? 0,
      manners: p?.manners ?? { no_report: 0, cancel: 0, mismatch: 0 },
      accounts: claims.map((c, i) => ({ platform: c.platform, identity: c.identity, proof_url: proofUrl(c), verified: verified[i] === 'verified' })),
      past_seasons: pastOf(aid),
      linked_accounts: [],
      snapshot: ref,
    };
  });

  // 確かめられた紐づけが同じなら、同じ人の別のアカウント
  const owners = new Map<string, PlayerDoc[]>();
  for (const doc of docs) {
    for (const a of doc.accounts) if (a.verified) owners.set(claimKey(a), [...(owners.get(claimKey(a)) ?? []), doc]);
  }
  for (const doc of docs) {
    const linked = new Map<string, PlayerDoc['linked_accounts'][number]>();
    for (const a of doc.accounts) {
      if (!a.verified) continue;
      for (const other of owners.get(claimKey(a)) ?? []) {
        if (other.aid === doc.aid) continue;
        const cur = linked.get(other.aid) ?? { aid: other.aid, name: other.name, via: [], past_seasons: other.past_seasons };
        cur.via.push({ platform: a.platform, identity: a.identity });
        linked.set(other.aid, cur);
      }
    }
    doc.linked_accounts = [...linked.values()].sort((x, y) => (x.aid < y.aid ? -1 : 1));
  }

  const index = new Map<string, PlayerDoc[]>();
  for (const doc of docs) {
    write(join(opts.out, 'api/v1/players', `${doc.aid}.json`), json(doc));
    write(join(opts.out, 'p', `${doc.aid}.html`), playerPage(doc, opts.appUrl));
    for (const a of doc.accounts) {
      if (!a.verified) continue;
      const key = `${a.platform === 'twitter' ? 'x' : 'github'}/${a.identity.toLowerCase()}`;
      index.set(key, [...(index.get(key) ?? []), doc]);
    }
  }
  for (const [key, list] of index) {
    // 同じ外部アカウントを複数のアカウントに紐づけた場合は、対戦数の多い順にすべて返す
    const players = [...list].sort((a, b) => b.matches - a.matches || (a.aid < b.aid ? -1 : 1));
    write(join(opts.out, 'api/v1/by', `${key}.json`), json({ players }));
  }
  write(join(opts.out, 'api/v1/index.json'), json({ snapshot: ref, season: snapshot.season, players: docs.length }));
  return { players: docs.length };
}
