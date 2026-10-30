import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createNostrRelayClient, initFastVerify, RATING_PAGE_SIZE, setVerifyCacheLimit } from '@nostr-rating/core';
import { relaysBelowPageSize, relaysWithoutLimit } from './relayInfo.js';
import { partStore } from './parts.js';
import { cliPath } from './paths.js';
import { eachGame, listGames, runSnapshot } from './run.js';

const { values } = parseArgs({
  options: {
    cutoff: { type: 'string' },
    relays: { type: 'string' },
    game: { type: 'string' },
    /** 部品の置き場（git の管理外）。新しい部品は upload/<リリースのタグ>/ にも置く */
    parts: { type: 'string' },
    /** 前回の部品を取るリリースの取得元（https://github.com/<owner>/<repo>/releases/download/） */
    'release-base': { type: 'string', default: process.env.SNAPSHOT_RELEASE_BASE },
    root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  },
});

if (!values.cutoff || !/^\d+$/.test(values.cutoff)) {
  console.error(
    'usage: npm run snapshot -- --cutoff <unix seconds> [--game <id>（省略すると configs/games.json のすべて）] [--relays wss://a,wss://b] [--root .] [--parts <dir>] [--release-base <url>]',
  );
  process.exit(2);
}

await initFastVerify();
// 全員分の署名を先に確かめてから使うので、確かめた結果を捨てない（docs/adr/0011）
setVerifyCacheLimit(Infinity);
const root = cliPath(values.root);
const parts = partStore(values.parts ? cliPath(values.parts) : join(root, '.snapshot-parts'), values['release-base'] || null);
const urls = values.relays
  ? values.relays.split(',').map((s) => s.trim()).filter(Boolean)
  : (JSON.parse(readFileSync(join(root, 'configs/relays.json'), 'utf8')) as { relays: string[] }).relays;

const small = await relaysBelowPageSize(urls, RATING_PAGE_SIZE);
if (small.length > 0) {
  for (const r of small) console.error(`${r.url}: 1回に返す件数の上限が ${r.maxLimit} 件で、${RATING_PAGE_SIZE} 件より少ないので使えません`);
  process.exit(1);
}
for (const url of await relaysWithoutLimit(urls)) {
  console.warn(`warning: ${url}: 1回に返す件数の上限を NIP-11 で公開していないか、読めませんでした。上限が ${RATING_PAGE_SIZE} 件より少ないと、取り切ったと見なしてしまいます`);
}

// 取り切れなかった問い合わせは試し直し、それでも駄目なら集計をやめる（翌日の集計でやり直す）
const relay = createNostrRelayClient(urls, { strict: true, maxWaitMs: 10_000 });
let failed: { game: string; error: unknown }[];
try {
  failed = await eachGame(values.game ? [values.game] : listGames(root), async (game) => {
    const { path, toc, release, uploads } = await runSnapshot({ root, cutoff: Number(values.cutoff), relay, parts, game });
    console.log(`wrote ${path} (events: ${toc.inputs.event_count}; ${uploads} new parts for release ${release})`);
    if (toc.inputs.event_count === 0) console.warn(`warning: ${game}: no events were used (no matches in the window)`);
  });
} finally {
  relay.close();
}
// 書けたゲームの分はワークフローが上げてコミットする。失敗したゲームがあれば、最後に失敗として終える
for (const f of failed) console.error(`${f.game}: ${f.error instanceof Error ? (f.error.stack ?? f.error.message) : String(f.error)}`);
process.exit(failed.length > 0 ? 1 : 0);
