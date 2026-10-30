import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claimKey,
  proofUrl,
  publishedFiles,
  verifyClaim,
  type AccountSummary,
  type IdentityClaim,
  type KelRecords,
  type RatingState,
} from '@nostr-rating/core';
import { latestOf, loadSnapshot, type LoadedSnapshot, type PartStore } from './parts.js';
import { listGames } from './run.js';

export interface SiteOptions {
  /** リポジトリのルート（snapshots/ がある場所） */
  root: string;
  /** 書き出し先（GitHub Pages に載せるディレクトリ） */
  out: string;
  /** アプリの公開 URL（末尾の / 付き）。選手ページからのリンクに使う */
  appUrl: string;
  fetchFn: typeof fetch;
  /** スナップショットの部品の置き場（docs/adr/0011） */
  parts: PartStore;
}

/** 公開 API の1人分（docs/api.md） */
export interface PlayerDoc {
  /** どのゲームのレートか */
  game: { id: string; name: string };
  aid: string;
  name: string;
  season: number;
  rating: number;
  rd: number;
  peak_rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  manners: { no_report: number; cancel: number; mismatch: number };
  accounts: { platform: IdentityClaim['platform']; identity: string; proof_url: string; verified: boolean }[];
  past_seasons: Record<string, { final_rating: number; peak_rating: number; matches: number; wins: number; losses: number; draws: number }>;
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

const record = (d: PlayerDoc) => `${d.matches}戦 ${d.wins}勝 ${d.losses}敗${d.draws > 0 ? ` ${d.draws}分` : ''}`;

/** X に貼るとカードになる、選手ごとの静的ページ（ゲームごとのレートを並べる） */
function playerPage(docs: PlayerDoc[], appUrl: string): string {
  const first = docs[0]!;
  const name = first.name || `${first.aid.slice(0, 8)}…`;
  const rated = docs.filter((d) => d.matches > 0);
  const title = rated.length > 0 ? `${name} のレート（${rated.map((d) => `${d.game.name} ${Math.round(d.rating)}`).join('・')}）` : `${name} | Nostr-Rating`;
  const desc = rated.length > 0 ? `Nostr-Rating の確定レート。${rated.map((d) => `${d.game.name}: ${record(d)}`).join('。')}` : 'Nostr-Rating の選手ページ';
  const accounts = first.accounts
    .map(
      (a) =>
        `<li>${platformName(a.platform)}: <a href="${escapeHtml(a.proof_url)}" rel="noopener">${escapeHtml(a.identity)}</a> ${a.verified ? '（確認済み）' : '（確認できず）'}</li>`,
    )
    .join('');
  const games = docs
    .map(
      (d) => `<section>
<h2>${escapeHtml(d.game.name)}</h2>
<p class="rating">${d.matches > 0 ? Math.round(d.rating) : '―'}</p>
<dl>
<dt>シーズン</dt><dd>${d.season}</dd>
<dt>戦績</dt><dd>${record(d)}</dd>
<dt>最高レート</dt><dd>${d.matches > 0 ? Math.round(d.peak_rating) : '―'}</dd>
</dl>
<p class="ref">根拠: 公開リポジトリのスナップショット <code>${escapeHtml(d.snapshot.path)}</code>（sha256 <code>${d.snapshot.sha256}</code>）。<a href="${escapeHtml(`${appUrl}api/v1/${d.game.id}/players/${d.aid}.json`)}">JSON</a></p>
</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Nostr-Rating</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${escapeHtml(`${appUrl}p/${first.aid}.html`)}">
<meta name="twitter:card" content="summary">
<style>
body{font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;line-height:1.8;color:#18223a;background:#f5f7fa}
@media (prefers-color-scheme: dark){body{color:#e7ebf5;background:#10141f}a{color:#8ea4ff}}
.rating{font-size:48px;font-weight:700;margin:8px 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px}dd{margin:0}
code{word-break:break-all;font-size:13px}
.ref{font-size:13px}
</style>
</head>
<body>
<p><a href="${escapeHtml(appUrl)}">Nostr-Rating</a></p>
<h1>${escapeHtml(name)}</h1>
${games}
<h2>紐づけたアカウント</h2>
<ul>${accounts || '<li>なし</li>'}</ul>
<p>どのレートも、誰でも同じイベントから計算し直して確かめられます。アカウントの識別子: <code>${first.aid}</code></p>
</body>
</html>
`;
}

interface LoadedGame {
  id: string;
  name: string;
  loaded: LoadedSnapshot;
  ref: PlayerDoc['snapshot'];
}

async function loadGame(root: string, id: string, parts: PartStore): Promise<LoadedGame | null> {
  const loaded = await loadSnapshot(root, id, parts);
  if (!loaded) return null;
  const name = (JSON.parse(readFileSync(join(root, `configs/${id}.json`), 'utf8')) as { name: string }).name;
  return { id, name, loaded, ref: { path: loaded.pointer.path, sha256: loaded.pointer.sha256, cutoff: loaded.toc.cutoff } };
}

/** アプリが読むスナップショット（latest.json、目次、クライアントが読む部品）を配信に置く（docs/adr/0011） */
function publishSnapshot(out: string, g: LoadedGame): void {
  const { pointer, toc, tocText, texts } = g.loaded;
  write(join(out, latestOf(g.id)), `${JSON.stringify(pointer, null, 2)}\n`);
  write(join(out, pointer.path), tocText);
  const files = publishedFiles(g.id, toc, { players: texts.players, seasons: texts.seasons, kels: JSON.parse(texts.kels) as KelRecords });
  for (const [path, text] of files) write(join(out, path), text);
}

type Summary = RatingState['seasonSummaries'][string][string];

const toPast = (x: Summary) => ({ final_rating: x.finalRating, peak_rating: x.peakRating, matches: x.matches, wins: x.wins, losses: x.losses, draws: x.draws });

/**
 * 最新のスナップショットから、アプリが読むスナップショット（snapshots/）、公開 API（api/v1/）、選手ページ（p/）を書き出す。
 * 紐づけはこのとき X・GitHub に問い合わせて確かめ、確かめられたものだけを by/ の索引に入れる。
 */
export async function buildSite(opts: SiteOptions): Promise<{ players: number; games: string[] }> {
  const games = (await Promise.all(listGames(opts.root).map((id) => loadGame(opts.root, id, opts.parts)))).filter((g): g is LoadedGame => g !== null);
  for (const g of games) publishSnapshot(opts.out, g);
  // アプリはリレーの一覧も、スナップショットと同じ配信元から読む
  write(join(opts.out, 'configs/relays.json'), readFileSync(join(opts.root, 'configs/relays.json'), 'utf8'));

  // 表示名と紐づけは全ゲームで共通（docs/adr/0010）。いちばん新しい公開情報を使う
  const accounts = new Map<string, AccountSummary>();
  for (const g of games) {
    for (const [aid, a] of Object.entries(g.loaded.state.accounts)) {
      const cur = accounts.get(aid);
      if (!cur || cur.createdAt < a.createdAt) accounts.set(aid, a);
    }
  }
  // 紐づけは1人につき1回だけ確かめる
  const accountDocs = new Map<string, PlayerDoc['accounts']>();
  await mapLimit([...accounts.keys()].sort(), CONCURRENCY, async (aid) => {
    const claims = accounts.get(aid)!.claims;
    const verified = await mapLimit(claims, 1, (c) => verifyClaim(c, aid, opts.fetchFn));
    accountDocs.set(aid, claims.map((c, i) => ({ platform: c.platform, identity: c.identity, proof_url: proofUrl(c), verified: verified[i] === 'verified' })));
  });
  // 確かめられた紐づけが同じなら、同じ人の別のアカウント
  const owners = new Map<string, string[]>();
  for (const [aid, list] of accountDocs) for (const a of list) if (a.verified) owners.set(claimKey(a), [...(owners.get(claimKey(a)) ?? []), aid]);

  const pages = new Map<string, PlayerDoc[]>();
  const summary: { id: string; name: string; season: number; players: number; snapshot: PlayerDoc['snapshot'] }[] = [];
  for (const g of games) {
    const { state } = g.loaded;
    const pastOf = (aid: string) =>
      Object.fromEntries(
        Object.entries(state.seasonSummaries)
          .filter(([, players]) => players[aid])
          .map(([season, players]) => [season, toPast(players[aid]!)]),
      );
    // そのゲームに記録のある人だけを載せる。紐づけのあるアカウントは、対戦していないゲームのスナップショットにも 0 戦で入っている
    const hasRecord = (p: RatingState['players'][string]) => p.matches > 0 || p.manners.noReport + p.manners.cancel + p.manners.mismatch > 0;
    const current = Object.entries(state.players).filter(([, p]) => hasRecord(p)).map(([aid]) => aid);
    const aids = [...new Set([...current, ...Object.values(state.seasonSummaries).flatMap((p) => Object.keys(p))])].sort();
    const docs = aids.map((aid): PlayerDoc => {
      const p = state.players[aid];
      const accountsOf = accountDocs.get(aid) ?? [];
      const linked = new Map<string, PlayerDoc['linked_accounts'][number]>();
      for (const a of accountsOf) {
        if (!a.verified) continue;
        for (const other of owners.get(claimKey(a)) ?? []) {
          if (other === aid) continue;
          const cur = linked.get(other) ?? { aid: other, name: accounts.get(other)?.name ?? '', via: [], past_seasons: pastOf(other) };
          cur.via.push({ platform: a.platform, identity: a.identity });
          linked.set(other, cur);
        }
      }
      return {
        game: { id: g.id, name: g.name },
        aid,
        name: accounts.get(aid)?.name ?? '',
        season: state.season,
        rating: p?.rating ?? 0,
        rd: p?.rd ?? 0,
        peak_rating: p?.peakRating ?? 0,
        matches: p?.matches ?? 0,
        wins: p?.wins ?? 0,
        losses: p?.losses ?? 0,
        draws: p?.draws ?? 0,
        manners: p ? { no_report: p.manners.noReport, cancel: p.manners.cancel, mismatch: p.manners.mismatch } : { no_report: 0, cancel: 0, mismatch: 0 },
        accounts: accountsOf,
        past_seasons: pastOf(aid),
        linked_accounts: [...linked.values()].sort((x, y) => (x.aid < y.aid ? -1 : 1)),
        snapshot: g.ref,
      };
    });

    const index = new Map<string, PlayerDoc[]>();
    for (const doc of docs) {
      write(join(opts.out, `api/v1/${g.id}/players`, `${doc.aid}.json`), json(doc));
      pages.set(doc.aid, [...(pages.get(doc.aid) ?? []), doc]);
      for (const a of doc.accounts) {
        if (!a.verified) continue;
        const key = `${a.platform === 'twitter' ? 'x' : 'github'}/${a.identity.toLowerCase()}`;
        index.set(key, [...(index.get(key) ?? []), doc]);
      }
    }
    for (const [key, list] of index) {
      // 同じ外部アカウントを複数のアカウントに紐づけた場合は、対戦数の多い順にすべて返す
      const players = [...list].sort((a, b) => b.matches - a.matches || (a.aid < b.aid ? -1 : 1));
      write(join(opts.out, `api/v1/${g.id}/by`, `${key}.json`), json({ players }));
    }
    write(join(opts.out, `api/v1/${g.id}/index.json`), json({ game: { id: g.id, name: g.name }, snapshot: g.ref, season: state.season, players: docs.length }));
    summary.push({ id: g.id, name: g.name, season: state.season, players: docs.length, snapshot: g.ref });
  }
  for (const [aid, docs] of pages) write(join(opts.out, 'p', `${aid}.html`), playerPage(docs, opts.appUrl));
  write(join(opts.out, 'api/v1/index.json'), json({ games: summary }));
  return { players: pages.size, games: games.map((g) => g.id) };
}
