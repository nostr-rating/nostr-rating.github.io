import { describe, expect, test } from 'vitest';
import { relaysBelowPageSize, relaysWithoutLimit } from '../src/relayInfo.js';

/** NIP-11 の問い合わせに答える fetch（Accept を確かめる） */
function infoFetch(infos: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new Headers(init?.headers).get('Accept') !== 'application/nostr+json') return new Response('', { status: 400 });
    if (!(url in infos)) return new Response('', { status: 404 });
    return new Response(JSON.stringify(infos[url]), { status: 200 });
  }) as typeof fetch;
}

describe('relaysBelowPageSize', () => {
  test('lists the relays whose max_limit is smaller than the page size', async () => {
    const fetchFn = infoFetch({
      'https://small.example/': { limitation: { max_limit: 100 } },
      'https://large.example/': { limitation: { max_limit: 5000 } },
      'http://local.example:7777/': { limitation: { max_limit: 300 } },
      'https://silent.example/': { name: 'no limitation' },
    });
    const urls = ['wss://small.example', 'wss://large.example', 'ws://local.example:7777', 'wss://silent.example', 'wss://down.example'];
    expect(await relaysBelowPageSize(urls, 300, fetchFn)).toEqual([{ url: 'wss://small.example', maxLimit: 100 }]);
  });

  test('lists the relays whose limit is not known, to warn about them', async () => {
    const fetchFn = infoFetch({
      'https://large.example/': { limitation: { max_limit: 5000 } },
      'https://silent.example/': { name: 'no limitation' },
    });
    expect(await relaysWithoutLimit(['wss://large.example', 'wss://silent.example', 'wss://down.example'], fetchFn)).toEqual(['wss://silent.example', 'wss://down.example']);
  });
});
