import { decodeDeviceRequest, deviceRequestCheck, KIND, MemoryRelay, parseKelEvent, recoveryKey, verificationText } from '@nostr-rating/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Account, memoryKeyStore } from '../src/account/account.js';
import { App } from '../src/App.js';
import { Onboarding } from '../src/pages/Onboarding.js';
import { Settings } from '../src/pages/Settings.js';
import { confirmWords, makeDeps, newPlayer, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  location.hash = '#/onboarding';
});
afterEach(cleanup);

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
    // 復活の言葉は端末に残さない
    expect(Object.keys((await deps.keyStore.get<object>('account'))!).sort()).toEqual(['aid', 'device', 'kel', 'knownDevices', 'sessions']);
  });

  test('an X post is verified through oEmbed', async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = {};
    renderWithApp(<Onboarding />, { deps: makeDeps({ routes, now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await confirmWords(user);
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

  test('nothing is published or kept on the device until the words are written down', async () => {
    const user = userEvent.setup();
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await screen.findByTestId('recovery-words');
    expect(screen.queryByRole('button', { name: 'あとで書く' })).toBeNull();
    expect((deps.relay as MemoryRelay).all()).toEqual([]);
    expect(await deps.keyStore.get('account')).toBeUndefined();
  });

  test('starting without writing the words down asks first, because the account cannot be restored', async () => {
    const user = userEvent.setup();
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    expect(screen.getByTestId('skip-hint').textContent).toBe('書き写さずに始めると、端末を全部失くしたときにアカウントを復元できません。');
    const asked: string[] = [];
    let answer = false;
    vi.spyOn(window, 'confirm').mockImplementation((m) => (asked.push(m ?? ''), answer));
    await user.click(screen.getByRole('button', { name: '書き写さずに始める' }));
    expect(await deps.keyStore.get('account')).toBeUndefined();
    answer = true;
    await user.click(screen.getByRole('button', { name: '書き写さずに始める' }));
    expect(await screen.findByLabelText('表示名')).toBeTruthy();
    expect(asked).toEqual(Array(2).fill('復活の言葉を書き写さずに始めますか？端末を全部失くすと、このアカウントは復元できません。'));
    expect(Object.keys((await deps.keyStore.get<object>('account'))!).sort()).toEqual(['aid', 'device', 'kel', 'knownDevices', 'sessions']);
    vi.restoreAllMocks();
  });

  test('when the account cannot be published, the check stays on screen with the error', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    relay.publish = async () => {
      throw new Error('offline');
    };
    const deps = makeDeps({ relay, now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await confirmWords(user);
    expect((await screen.findByText('始められませんでした。電波のよい場所でもう一度押してください。')).getAttribute('role')).toBe('alert');
    expect(screen.getByRole('button', { name: '確かめる' })).toBeTruthy();
    expect(await deps.keyStore.get('account')).toBeUndefined();
  });

  test('splitting the words into three cards needs two of them to recover', async () => {
    const user = userEvent.setup();
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await user.click(await screen.findByRole('button', { name: '3枚に分けて保管する' }));
    const cards: string[][] = [];
    for (let i = 0; i < 3; i++) {
      expect((await screen.findByTestId('card-number')).textContent).toBe(`${i + 1}枚目／3枚`);
      cards.push(within(screen.getByTestId('recovery-words')).getAllByRole('listitem').map((li) => li.textContent ?? ''));
      await user.click(screen.getByRole('button', { name: i < 2 ? `${i + 1}枚目を書き写した` : '書き写した' }));
    }
    for (const input of await screen.findAllByLabelText(/枚目の\d+番目/)) {
      const [, c, n] = (input.closest('label')?.textContent ?? '').match(/(\d+)枚目の(\d+)番目/)!;
      await user.type(input, cards[Number(c) - 1]![Number(n) - 1]!);
    }
    await user.click(screen.getByRole('button', { name: '確かめる' }));
    expect(await screen.findByLabelText('表示名')).toBeTruthy();
    // 作成の宣言の次の鍵が、はじめから3枚（2枚で復元できる）になる
    const stored = (await deps.keyStore.get<{ kel: { entry: { body: { t: string; next: { keys: string[]; threshold: number } } } }[] }>('account'))!;
    const icp = stored.kel.map((k) => k.entry.body);
    expect(icp.map((b) => [b.t, b.next.keys.length, b.next.threshold])).toEqual([['icp', 3, 2]]);
    expect(icp[0]!.next.keys).toEqual(cards.map((w) => recoveryKey(w.join(' ')).pub));
  });

  test('a second device is registered by pasting its request on an existing device', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const existing = await newPlayer(relay, realNow, { name: 'アリス', claims: [{ platform: 'github', identity: 'alice', proof: 'abc' }] });
    renderWithApp(<Onboarding />, { deps: makeDeps({ relay, now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'すでにアカウントを持っている' }));
    await waitFor(() => expect(screen.getByTestId('device-request').textContent).toMatch(/^nr-device:/));
    expect((await screen.findByRole('img', { name: '端末の申請の QR コード' })).querySelector('svg')).toBeTruthy();
    const request = decodeDeviceRequest(screen.getByTestId('device-request').textContent!)!;
    expect(screen.getByTestId('device-check').textContent).toBe(`確認の番号: ${deviceRequestCheck(request)}`);
    await existing.account.addDevice(screen.getByTestId('device-request').textContent!);
    // 表示名と紐づけがあるアカウントなので、そのままロビーへ進む
    await waitFor(() => expect(location.hash).toBe('#/lobby'), { timeout: 5000 });
    expect(existing.account.state!.devices.size).toBe(2);
  });

  test('a new device links to the recovery tool for someone who lost every device', async () => {
    vi.stubEnv('VITE_RECOVERY_URL', 'https://github.com/o/r/releases/tag/recovery-v2');
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'すでにアカウントを持っている' }));
    expect(screen.getByRole('link', { name: 'リリースのページ' }).getAttribute('href')).toBe('https://github.com/o/r/releases/tag/recovery-v2');
    vi.unstubAllEnvs();
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

  test('a fixed room password is kept only on this device and never published', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const p = await newPlayer(relay, realNow);
    renderWithApp(<Settings />, { deps: makeDeps({ relay, now: realNow }), account: p.account });
    const input = await screen.findByLabelText('部屋のパスワードの初期値');
    expect(screen.getByTestId('password-hint').textContent).toBe('空にしておくと、対戦ごとに数字4桁を作ります。この端末にだけ保存し、公開はしません。');
    await user.type(input, '123');
    expect(screen.getByTestId('password-error').textContent).toBe('数字4〜8桁で入力してください。');
    expect((screen.getByRole('button', { name: '設定を保存' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, '4');
    expect(screen.getByTestId('password-error').textContent).toBe('');
    await waitFor(() => expect((screen.getByRole('button', { name: '設定を保存' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '設定を保存' }));
    await waitFor(() => expect(localStorage.getItem('nostr-rating:default-room-password:smash_sp')).toBe('1234'));
    const ev = relay.all().find((e) => e.kind === KIND.settings)!;
    expect(ev.content.includes('1234')).toBe(false);
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

  test('links to the recovery tool baked in at build time', async () => {
    vi.stubEnv('VITE_RECOVERY_URL', 'https://github.com/o/r/releases/tag/recovery-v2');
    const p = await newPlayer(new MemoryRelay(realNow), realNow);
    renderWithApp(<Settings />, { deps: makeDeps({ now: realNow }), account: p.account });
    expect((await screen.findByRole('link', { name: '復活の道具を入手する' })).getAttribute('href')).toBe('https://github.com/o/r/releases/tag/recovery-v2');
    vi.unstubAllEnvs();
  });
});

describe('Onboarding: going back', () => {
  /** 始めて、言葉を書き写し、表示名の手順まで進める */
  async function toNameStep(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'この端末で始める' }));
    await confirmWords(user);
    return screen.findByLabelText('表示名');
  }

  test('the name hint does not ask for the in-game name', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    await toNameStep(user);
    expect(screen.getByTestId('name-hint').textContent).toBe('対戦相手とランキングに表示される名前です。');
  });

  test('the identity step can go back to change the name', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    await user.type(await toNameStep(user), 'アリス');
    await waitFor(() => expect((screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await screen.findByTestId('verification-text');
    await user.click(screen.getByRole('button', { name: '表示名を変える' }));
    expect(((await screen.findByLabelText('表示名')) as HTMLInputElement).value).toBe('アリス');
  });

  test('starting over forgets the account on this device and returns to the first step', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await toNameStep(user);
    expect(await deps.keyStore.get('account')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '最初からやり直す' }));
    expect(confirm).toHaveBeenCalledWith('この端末のアカウントを消して、最初からやり直しますか？いまの復活の言葉は使えなくなります。');
    expect(await screen.findByRole('button', { name: 'この端末で始める' })).toBeTruthy();
    expect(await deps.keyStore.get('account')).toBeUndefined();
    confirm.mockRestore();
  });

  test('starting over does nothing when cancelled', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deps = makeDeps({ now: realNow });
    renderWithApp(<Onboarding />, { deps });
    await toNameStep(user);
    await user.click(screen.getByRole('button', { name: '最初からやり直す' }));
    expect(screen.getByLabelText('表示名')).toBeTruthy();
    expect(await deps.keyStore.get('account')).toBeTruthy();
    confirm.mockRestore();
  });

  test('copying the verification text says it was copied', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    await user.type(await toNameStep(user), 'アリス');
    await waitFor(() => expect((screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    const text = (await screen.findByTestId('verification-text')).textContent ?? '';
    await user.click(screen.getByRole('button', { name: '文をコピー' }));
    expect(await navigator.clipboard.readText()).toBe(text);
    expect((await screen.findByRole('status')).textContent).toBe('コピーしました');
  });
});

describe('App header during onboarding', () => {
  test('shows only the help link until the account is ready', async () => {
    renderWithApp(<App />, { deps: makeDeps({ now: realNow }) });
    await screen.findByRole('button', { name: 'この端末で始める' });
    expect(screen.queryByRole('combobox', { name: 'ゲーム' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: '画面' })).toBeNull();
    expect(screen.getByRole('link', { name: 'ヘルプ' })).toBeTruthy();
  });
});
