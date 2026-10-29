import { attributor, buildKelBook, KIND, MemoryRelay, parseKelEvent, type EventTemplate } from '@nostr-rating/core';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Onboarding } from '../src/pages/Onboarding.js';
import { confirmWords, makeDeps, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  location.hash = '#/onboarding';
});
afterEach(() => {
  cleanup();
  delete window.nostr;
});

describe('a signer app as the device key', () => {
  test('a NIP-07 extension becomes the device key and signs the daily certificate', async () => {
    const sk = generateSecretKey();
    const asked: number[] = [];
    window.nostr = {
      getPublicKey: async () => getPublicKey(sk),
      signEvent: async (t: EventTemplate) => {
        asked.push(t.kind);
        return finalizeEvent(t, sk);
      },
    };
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    renderWithApp(<Onboarding />, { deps: makeDeps({ relay, now: realNow }) });
    await user.click(screen.getByText('署名アプリを使う（Nostr に詳しい人向け）'));
    await user.click(screen.getByRole('button', { name: 'ブラウザ拡張（NIP-07）で始める' }));
    await confirmWords(user);
    await user.type(await screen.findByLabelText('表示名'), 'ナナ');
    await waitFor(() => expect((screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await screen.findByTestId('verification-text');

    // KEL の端末は拡張機能の公開鍵（schnorr）。署名を頼まれたのは本文への署名（kind 23753）だけ
    const icp = relay.all().find((e) => e.kind === KIND.kel)!;
    const parsed = parseKelEvent(icp)!;
    expect((parsed.input.entry.body as { devices: { key: unknown; label: string }[] }).devices.map((d) => [d.key, d.label])).toEqual([
      [{ type: 'schnorr', pub: getPublicKey(sk) }, '署名アプリ（NIP-07）'],
    ]);
    expect(new Set(asked)).toEqual(new Set([23753]));
    // 拡張機能が出した証明書で、表示名のイベントがこのアカウントのものと認められる
    const info = relay.all().find((e) => e.kind === KIND.account)!;
    const author = attributor(buildKelBook({}, relay.all(), -Infinity, Infinity).states)(info);
    expect(author).toBe(parsed.aid);
  });

  test('without an extension it explains what is missing', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    await user.click(screen.getByText('署名アプリを使う（Nostr に詳しい人向け）'));
    await user.click(screen.getByRole('button', { name: 'ブラウザ拡張（NIP-07）で始める' }));
    expect((await screen.findByRole('alert')).textContent).toBe('署名アプリにつなげませんでした: ブラウザ拡張（NIP-07）が見つかりません');
  });
});

describe('a signer app for a new device', () => {
  test('a failed connection keeps the current device request', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'すでにアカウントを持っている' }));
    await waitFor(() => expect(screen.getByTestId('device-request').textContent).toMatch(/^nr-device:/));
    const code = screen.getByTestId('device-request').textContent;
    await user.click(screen.getByText('この端末の鍵に署名アプリを使う（Nostr に詳しい人向け）'));
    await user.click(screen.getByRole('button', { name: 'ブラウザ拡張（NIP-07）で申請を作り直す' }));
    expect((await screen.findByRole('alert')).textContent).toBe('署名アプリにつなげませんでした: ブラウザ拡張（NIP-07）が見つかりません');
    expect(screen.getByTestId('device-request').textContent).toBe(code);
  });
});
