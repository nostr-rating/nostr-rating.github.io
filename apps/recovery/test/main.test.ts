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
