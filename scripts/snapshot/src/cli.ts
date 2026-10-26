import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createNostrRelayClient } from '@nostr-rating/core';
import { runSnapshot } from './run.js';

const { values } = parseArgs({
  options: {
    cutoff: { type: 'string' },
    relays: { type: 'string' },
    root: { type: 'string', default: resolve(import.meta.dirname, '../../..') },
  },
});

if (!values.cutoff || !/^\d+$/.test(values.cutoff)) {
  console.error('usage: npm run snapshot -- --cutoff <unix seconds> [--relays wss://a,wss://b] [--root .]');
  process.exit(2);
}

const root = resolve(values.root);
const urls = values.relays
  ? values.relays.split(',').map((s) => s.trim()).filter(Boolean)
  : (JSON.parse(readFileSync(join(root, 'configs/relays.json'), 'utf8')) as { relays: string[] }).relays;

const relay = createNostrRelayClient(urls);
try {
  const { path, snapshot } = await runSnapshot({ root, cutoff: Number(values.cutoff), relay });
  console.log(`wrote ${path} (players: ${Object.keys(snapshot.players).length}, events: ${snapshot.inputs.event_count})`);
  if (snapshot.inputs.event_count === 0) console.warn('warning: no events were used (relays unreachable or no matches)');
} finally {
  relay.close();
}
process.exit(0);
