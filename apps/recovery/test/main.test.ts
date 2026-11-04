import * as core from '@nostr-rating/core';
import { beforeAll, describe, expect, test, vi } from 'vitest';

/** 3枚に分けた復活の言葉のうちの2枚。どちらも1枚では足りない（2枚で復元できる） */
const cards = vi.hoisted(() => ({ words: [] as string[] }));

vi.mock('@nostr-rating/core', async (original) => {
  const c = await original<typeof core>();
  cards.words = [c.newRecoveryWords(), c.newRecoveryWords()];
  const state = {
    abandoned: false,
    devices: new Map(),
    next: { keys: [...cards.words.map((w) => c.recoveryKey(w).pub), c.recoveryKey(c.newRecoveryWords()).pub], threshold: 2 },
  };
  return {
    ...c,
    createNostrRelayClient: () => ({ close() {}, query: async () => [], publish: async () => undefined }),
    findAccountsByNextKeys: async () => ['a'.repeat(64)],
    loadKel: async () => ({ state, chain: [] }),
  };
});

const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const $$ = <T extends Element>(s: string) => [...document.querySelectorAll<T>(s)];
const button = (name: string) => $$<HTMLButtonElement>('button').find((b) => b.textContent!.startsWith(name))!;

beforeAll(async () => {
  // jsdom のブラウザの言語は英語なので、日本語の文言で確かめるために先に日本語にする
  Object.defineProperty(navigator, 'languages', { value: ['ja-JP'], configurable: true });
  document.body.innerHTML = '<div id="app"></div>';
  await import('../src/main.js');
});

describe('recovery words split into cards', () => {
  test('asking for one more card keeps what was typed so the next card can be added', async () => {
    $$<HTMLTextAreaElement>('.words-input')[0]!.value = cards.words[0]!;
    button('アカウントを探す').click();
    await vi.waitFor(() => expect($('[role=alert]').textContent).toBe('このアカウントを復元するには、復活の言葉があと 1 枚必要です。「もう1枚入力する」から足してください。'));
    expect($$<HTMLTextAreaElement>('.words-input').map((t) => t.value)).toEqual([cards.words[0]]);

    button('もう1枚入力する').click();
    $$<HTMLTextAreaElement>('.words-input')[1]!.value = cards.words[1]!;
    button('アカウントを探す').click();
    await vi.waitFor(() => expect($$('h2').map((e) => e.textContent)).toEqual(['2. 新しい端末の申請']));
  });
});

describe('language', () => {
  test('switching the language redraws the current step in that language and keeps what was typed', () => {
    const select = $<HTMLSelectElement>('select.locale-select');
    expect([document.documentElement.lang, document.title, select.value]).toEqual(['ja', '復活の道具 | Nostr-Rating', 'ja']);
    $<HTMLTextAreaElement>('textarea[placeholder]').value = 'nr-device:abc';

    select.value = 'en';
    select.dispatchEvent(new Event('change'));
    expect([document.documentElement.lang, document.title, $('h1').textContent, $$('h2').map((e) => e.textContent)]).toEqual([
      'en',
      'Recovery tool | Nostr-Rating',
      'Recovery tool',
      ['2. Request from the new device'],
    ]);
    expect($<HTMLTextAreaElement>('textarea[placeholder]').value).toBe('nr-device:abc');
    expect(localStorage.getItem('nostr-rating:locale')).toBe('en');

    const back = $<HTMLSelectElement>('select.locale-select');
    back.value = 'ja';
    back.dispatchEvent(new Event('change'));
    expect($$('h2').map((e) => e.textContent)).toEqual(['2. 新しい端末の申請']);
  });
});
