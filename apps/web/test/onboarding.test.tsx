import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { encodeNsec, KIND, LocalSigner, npubOf } from '@nostr-rating/core';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Onboarding } from '../src/pages/Onboarding.js';
import { Settings } from '../src/pages/Settings.js';
import { clearLocalKey, isBackedUp } from '../src/services/signer-local.js';
import { makeDeps, renderWithApp } from './helpers.js';

beforeEach(async () => {
  await clearLocalKey();
  location.hash = '#/onboarding';
});
afterEach(cleanup);

describe('Onboarding', () => {
  test('creates a key, publishes profile and identity, then asks for backup', async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = {};
    const deps = makeDeps({ routes });
    renderWithApp(<Onboarding />, { deps });

    await user.click(screen.getByRole('button', { name: 'はじめる' }));
    await user.type(await screen.findByLabelText('表示名'), 'アリス');
    await user.click(screen.getByRole('button', { name: '次へ' }));

    const text = (await screen.findByTestId('verification-text')).textContent ?? '';
    const npub = text.split(': ')[1]!;
    routes['https://api.github.com/gists/abc123'] = { owner: { login: 'alice' }, files: { 'n.txt': { content: text } } };
    await user.type(screen.getByLabelText('投稿の URL'), 'https://gist.github.com/alice/abc123');
    await user.click(screen.getByRole('button', { name: '確認する' }));
    expect(await screen.findByText('自動検証済み')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '登録して次へ' }));

    expect(await screen.findByText('引き継ぎコードの保存')).toBeTruthy();
    const all = (deps.relay as any).all() as { kind: number; pubkey: string; content: string; tags: string[][] }[];
    const profile = all.find((e) => e.kind === KIND.profile)!;
    expect(JSON.parse(profile.content)).toEqual({ name: 'アリス' });
    expect(npubOf(profile.pubkey)).toBe(npub);
    expect(all.find((e) => e.kind === KIND.identities)!.tags).toEqual([['i', 'github:alice', 'abc123']]);

    await user.click(screen.getByRole('checkbox', { name: '安全な場所に保存しました' }));
    await user.click(screen.getByRole('button', { name: '対戦をはじめる' }));
    await waitFor(async () => expect(await isBackedUp()).toBe(true));
    expect(location.hash).toBe('#/lobby');
  });

  test('X link is accepted as link only', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />);
    await user.click(screen.getByRole('button', { name: 'はじめる' }));
    await user.type(await screen.findByLabelText('表示名'), 'ボブ');
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.type(await screen.findByLabelText('投稿の URL'), 'https://x.com/bob/status/123');
    await user.click(screen.getByRole('button', { name: '確認する' }));
    expect(await screen.findByText('リンクのみ（未検証）')).toBeTruthy();
  });

  test('importing an invalid nsec shows an error', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />);
    await user.click(screen.getByText('すでに Nostr を使っている方'));
    await user.type(screen.getByLabelText('nsec'), 'nsec1invalid');
    await user.click(screen.getByRole('button', { name: '取り込む' }));
    expect(await screen.findByText('nsec を読み取れませんでした')).toBeTruthy();
  });

  test('importing a valid nsec skips key creation', async () => {
    const user = userEvent.setup();
    const sk = generateSecretKey();
    renderWithApp(<Onboarding />);
    await user.click(screen.getByText('すでに Nostr を使っている方'));
    await user.type(screen.getByLabelText('nsec'), encodeNsec(sk));
    await user.click(screen.getByRole('button', { name: '取り込む' }));
    expect(await screen.findByLabelText('表示名')).toBeTruthy();
    expect(screen.getByTestId('my-npub').textContent).toBe(npubOf(getPublicKey(sk)));
  });
});

describe('Settings', () => {
  test('cannot select a third ban stage and publishes settings', async () => {
    const user = userEvent.setup();
    const signer = new LocalSigner(generateSecretKey());
    const deps = makeDeps();
    renderWithApp(<Settings />, { deps, signer: { signer, kind: 'local' } });

    await user.selectOptions(screen.getByLabelText('相手のファイター'), 'mario');
    await user.click(screen.getByRole('button', { name: '終点' }));
    await user.click(screen.getByRole('button', { name: 'すま村' }));
    expect((screen.getByRole('button', { name: '戦場' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '設定を保存' }));

    await waitFor(() => {
      const ev = (deps.relay as any).all().find((e: { kind: number }) => e.kind === KIND.settings);
      expect(JSON.parse(ev.content)).toEqual({ stageBans: { mario: ['final_destination', 'smashville'] }, rangeChoice: null, rematchHours: 0 });
    });
  });
});
