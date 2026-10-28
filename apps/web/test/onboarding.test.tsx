import { KIND, MemoryRelay, parseKelEvent, recoveryKey, verificationText } from '@nostr-rating/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Account, memoryKeyStore } from '../src/account/account.js';
import { Onboarding } from '../src/pages/Onboarding.js';
import { Settings } from '../src/pages/Settings.js';
import { makeDeps, newPlayer, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  location.hash = '#/onboarding';
});
afterEach(cleanup);

/** 表示された12語から、確認で聞かれた番号の単語を入れる */
async function confirmWords(user: ReturnType<typeof userEvent.setup>) {
  const words = within(await screen.findByTestId('recovery-words'))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
  expect(words).toHaveLength(12);
  await user.click(screen.getByRole('button', { name: '書き写した' }));
  for (const input of await screen.findAllByLabelText(/番目/)) {
    const n = Number((input.closest('label')?.textContent ?? '').match(/(\d+)番目/)![1]);
    await user.type(input, words[n - 1]!);
  }
  await user.click(screen.getByRole('button', { name: '確かめる' }));
}

describe('Onboarding', () => {
  test('creates an account, confirms the recovery words, publishes the name and a GitHub link', async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = {};
    const deps = makeDeps({ routes, now: realNow });
    renderWithApp(<Onboarding />, { deps });

    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await confirmWords(user);
    await user.type(await screen.findByLabelText('表示名'), 'アリス');
    await waitFor(() => expect((screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '次へ' }));

    const text = (await screen.findByTestId('verification-text')).textContent ?? '';
    const aid = text.split(': ')[1]!;
    expect(text).toBe(verificationText(aid));
    routes['https://api.github.com/gists/abc123'] = { owner: { login: 'alice' }, files: { 'n.txt': { content: text } } };
    await user.type(screen.getByLabelText('投稿の URL'), 'https://gist.github.com/alice/abc123');
    await user.click(screen.getByRole('button', { name: '確認する' }));
    expect(await screen.findByText('確認済み')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '登録して次へ' }));
    await waitFor(() => expect(location.hash).toBe('#/lobby'));

    const all = (deps.relay as MemoryRelay).all();
    expect(all.filter((e) => e.kind === KIND.kel).map((e) => parseKelEvent(e)?.aid)).toEqual([aid]);
    const info = all.filter((e) => e.kind === KIND.account).sort((a, b) => b.created_at - a.created_at)[0]!;
    expect(JSON.parse(info.content)).toEqual({ name: 'アリス', claims: [{ platform: 'github', identity: 'alice', proof: 'abc123' }] });
    // 復活の言葉は確かめたら端末から消える
    expect((await deps.keyStore.get<{ pendingWords: string | null }>('account'))!.pendingWords).toBeNull();
  });

  test('an X post is verified through oEmbed', async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = {};
    renderWithApp(<Onboarding />, { deps: makeDeps({ routes, now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await user.click(await screen.findByRole('button', { name: 'あとで書く' }));
    await user.type(await screen.findByLabelText('表示名'), 'ボブ');
    await waitFor(() => expect((screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    const text = (await screen.findByTestId('verification-text')).textContent ?? '';
    routes[`https://publish.x.com/oembed?omit_script=true&url=${encodeURIComponent('https://x.com/bob/status/123')}`] = {
      author_url: 'https://twitter.com/bob',
      html: `<blockquote><p>${text}</p></blockquote>`,
    };
    await user.type(await screen.findByLabelText('投稿の URL'), 'https://x.com/bob/status/123');
    await user.click(screen.getByRole('button', { name: '確認する' }));
    expect(await screen.findByText('確認済み')).toBeTruthy();
  });

  test('putting off the recovery words keeps them on the device until confirmed', async () => {
    const user = userEvent.setup();
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await user.click(await screen.findByRole('button', { name: 'あとで書く' }));
    expect(await screen.findByLabelText('表示名')).toBeTruthy();
    expect((await deps.keyStore.get<{ pendingWords: string | null }>('account'))!.pendingWords?.split(' ')).toHaveLength(12);
  });

  test('splitting the words into three cards needs two of them to recover', async () => {
    const user = userEvent.setup();
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await user.click(await screen.findByRole('button', { name: '3枚に分けて保管する（2枚あれば戻せる）' }));
    const cards: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await screen.findByText(new RegExp(`（${i + 1}枚目／3枚）`));
      cards.push(within(screen.getByTestId('recovery-words')).getAllByRole('listitem').map((li) => li.textContent ?? ''));
      await user.click(screen.getByRole('button', { name: i < 2 ? `${i + 1}枚目を書き写した` : '書き写した' }));
    }
    for (const input of await screen.findAllByLabelText(/枚目の\d+番目/)) {
      const [, c, n] = (input.closest('label')?.textContent ?? '').match(/(\d+)枚目の(\d+)番目/)!;
      await user.type(input, cards[Number(c) - 1]![Number(n) - 1]!);
    }
    await user.click(screen.getByRole('button', { name: '確かめる' }));
    expect(await screen.findByLabelText('表示名')).toBeTruthy();
    const stored = (await deps.keyStore.get<{ pendingWords: string | null; kel: { entry: { body: { t: string; next: { keys: string[]; threshold: number } } } }[] }>('account'))!;
    expect(stored.pendingWords).toBeNull();
    const rot = stored.kel[stored.kel.length - 1]!.entry.body;
    expect([rot.t, rot.next.keys.length, rot.next.threshold]).toEqual(['rot', 3, 2]);
    expect(rot.next.keys).toEqual(cards.map((w) => recoveryKey(w.join(' ')).pub));
  });

  test('a second device is registered by pasting its request on an existing device', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const existing = await newPlayer(relay, realNow, { name: 'アリス', claims: [{ platform: 'github', identity: 'alice', proof: 'abc' }] });
    renderWithApp(<Onboarding />, { deps: makeDeps({ relay, now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'すでにアカウントを持っている' }));
    await waitFor(() => expect(screen.getByTestId('device-request').textContent).toMatch(/^nr-device:/));
    expect((await screen.findByRole('img', { name: '端末の申請の QR コード' })).querySelector('svg')).toBeTruthy();
    await existing.account.addDevice(screen.getByTestId('device-request').textContent!);
    // 表示名と紐づけがあるアカウントなので、そのままロビーへ進む
    await waitFor(() => expect(location.hash).toBe('#/lobby'), { timeout: 5000 });
    expect(existing.account.state!.devices.size).toBe(2);
  });
});

describe('Settings', () => {
  test('cannot select a third ban stage and publishes settings', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const p = await newPlayer(relay, realNow);
    renderWithApp(<Settings />, { deps: makeDeps({ relay, now: realNow }), account: p.account });

    await user.selectOptions(screen.getByLabelText('相手のファイター'), 'mario');
    await user.click(screen.getByRole('button', { name: '終点' }));
    await user.click(screen.getByRole('button', { name: 'すま村' }));
    expect((screen.getByRole('button', { name: '戦場' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole('button', { name: '設定を保存' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '設定を保存' }));

    await waitFor(() => {
      const ev = relay.all().find((e) => e.kind === KIND.settings)!;
      expect(JSON.parse(ev.content)).toEqual({ stageBans: { mario: ['final_destination', 'smashville'] }, rangeChoice: null, rematchHours: 0 });
    });
  });

  test('lists this device and revokes another one', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const p = await newPlayer(relay, realNow);
    const second = await p.account.addDevice(await Account.prepareDevice(memoryKeyStore(), 'タブレット'));
    renderWithApp(<Settings />, { deps: makeDeps({ relay, now: realNow }), account: p.account });
    const list = within(await screen.findByTestId('devices'));
    expect(await list.findByText(/テスト端末（この端末）/)).toBeTruthy();
    expect(list.getByText(/タブレット/)).toBeTruthy();
    window.confirm = () => true;
    await user.click(list.getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(within(screen.getByTestId('devices')).queryByText(/タブレット/)).toBeNull());
    expect(p.account.state!.devices.get(second.id)!.intervals.every((i) => i.to <= realNow())).toBe(true);
  });
});
