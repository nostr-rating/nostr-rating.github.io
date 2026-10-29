import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createNostrRelayClient, RATING_PAGE_SIZE } from '@nostr-rating/core';
import { relaysBelowPageSize } from './relayInfo.js';
import { listGames, runSnapshot } from './run.js';

const { values } = parseArgs({
  options: {
    cutoff: { type: 'string' },
    relays: { type: 'string' },
    game: { type: 'string' },
    root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  },
});

if (!values.cutoff || !/^\d+$/.test(values.cutoff)) {
  console.error('usage: npm run snapshot -- --cutoff <unix seconds> [--game <id>（省略すると configs/games.json のすべて）] [--relays wss://a,wss://b] [--root .]');
  process.exit(2);
}

const root = resolve(values.root);
const urls = values.relays
  ? values.relays.split(',').map((s) => s.trim()).filter(Boolean)
  : (JSON.parse(readFileSync(join(root, 'configs/relays.json'), 'utf8')) as { relays: string[] }).relays;

const small = await relaysBelowPageSize(urls, RATING_PAGE_SIZE);
if (small.length > 0) {
  for (const r of small) console.error(`${r.url}: 1回に返す件数の上限が ${r.maxLimit} 件で、${RATING_PAGE_SIZE} 件より少ないので使えません`);
  process.exit(1);
}

// 取り切れなかった問い合わせは試し直し、それでも駄目なら集計をやめる（翌日の集計でやり直す）
const relay = createNostrRelayClient(urls, { strict: true, maxWaitMs: 10_000 });
try {
  for (const game of values.game ? [values.game] : listGames(root)) {
    const { path, snapshot } = await runSnapshot({ root, cutoff: Number(values.cutoff), relay, game });
    console.log(`wrote ${path} (players: ${Object.keys(snapshot.players).length}, events: ${snapshot.inputs.event_count})`);
    if (snapshot.inputs.event_count === 0) console.warn(`warning: ${game}: no events were used (no matches in the window)`);
  }
} finally {
  relay.close();
}
process.exit(0);
