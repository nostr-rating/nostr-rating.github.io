import { buildReport, KIND, MemoryRelay } from '@nostr-rating/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { App } from '../src/App.js';
import { Lobby } from '../src/pages/Lobby.js';
import { Ranking } from '../src/pages/Ranking.js';
import { makeDeps, matchBetween, newPlayer, renderWithApp } from './helpers.js';

afterEach(cleanup);

const realNow = () => Math.floor(Date.now() / 1000);

const userWithIdentity = async (relay: MemoryRelay, now = realNow, keepWords = false) =>
  (await newPlayer(relay, now, { name: 'u', claims: [{ platform: 'github', identity: 'u', proof: 'abc' }], keepWords })).account;

describe('Lobby', () => {
  test('two lobbies on the same relay end up in the same match room', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const [a, b] = [await userWithIdentity(relay), await userWithIdentity(relay)];
    const viewA = renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: a });
    const viewB = renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: b });
    const inA = within(viewA.container);
    const inB = within(viewB.container);

    await user.selectOptions(await inA.findByLabelText('1戦目に使うキャラ'), 'mario');
    await user.click(await inA.findByRole('button', { name: '対戦相手を探す' }));
    expect(await inA.findByText(/待機中/)).toBeTruthy();
    await user.selectOptions(await inB.findByLabelText('1戦目に使うキャラ'), 'fox');
    await user.click(await inB.findByRole('button', { name: '対戦相手を探す' }));

    await waitFor(() => expect(relay.all().filter((e) => e.kind === KIND.match)).toHaveLength(1), { timeout: 15_000 });
    const matchId = relay.all().find((e) => e.kind === KIND.match)!.id;
    await waitFor(() => {
      expect(inA.queryByRole('button', { name: 'やめる' })).toBeNull();
      expect(inB.queryByRole('button', { name: 'やめる' })).toBeNull();
    }, { timeout: 15_000 });
    expect(location.hash).toBe(`#/match/${matchId}`);
  }, 30_000);

  test('cancelling stops waiting', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await userWithIdentity(relay);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: a });
    await user.click(await screen.findByRole('button', { name: '対戦相手を探す' }));
    expect(await screen.findByText(/待機中/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(await screen.findByRole('button', { name: '対戦相手を探す' })).toBeTruthy();
  }, 15_000);

  test('search is disabled until an external account is linked', async () => {
    const relay = new MemoryRelay(realNow);
    const { account } = await newPlayer(relay, realNow);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account });
    await waitFor(() => expect((screen.getByRole('button', { name: '対戦相手を探す' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('対戦するには X か GitHub の紐づけが必要です。')).toBeTruthy();
  });

  test('reminds to write down the recovery words while they are still on the device', async () => {
    const relay = new MemoryRelay(realNow);
    const account = await userWithIdentity(relay, realNow, true);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account });
    await waitFor(() =>
      expect(document.querySelector('.notice')?.textContent).toBe(
        '復活の言葉をまだ書き写していません。端末を全部失くしたときに戻せるよう、設定画面から書き写してください。',
      ),
    );
  });
});

describe('matches to go back to', () => {
  const claims = [{ platform: 'github' as const, identity: 'u', proof: 'abc' }];

  test('a chess match both reported as a draw is settled and not offered again', async () => {
    localStorage.setItem('nostr-rating:game', 'chess');
    const relay = new MemoryRelay(realNow);
    const [a, b] = [await newPlayer(relay, realNow, { claims }), await newPlayer(relay, realNow, { claims })];
    const drawn = await matchBetween(relay, a, b, { game: 'chess', at: realNow() - 120 });
    const open = await matchBetween(relay, a, b, { game: 'chess' });
    const [sa, sb] = [await a.signer.getPublicKey(), await b.signer.getPublicKey()];
    await relay.publish(await a.signer.signEvent(buildReport('chess', { matchId: drawn.id, opponent: sb, result: 'draw' }, realNow() - 60)));
    await relay.publish(await b.signer.signEvent(buildReport('chess', { matchId: drawn.id, opponent: sa, result: 'draw' }, realNow() - 60)));

    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    await waitFor(() => expect(document.querySelector(`a[href="#/match/${open.id}"]`)).not.toBeNull());
    expect(document.querySelector(`a[href="#/match/${drawn.id}"]`)).toBeNull();
    localStorage.clear();
  });
});

describe('Lobby near the season end', () => {
  test('does not start matches whose report deadline would fall after the season end', async () => {
    const end = 1_798_729_200; // シーズン1の終わり（2027-01-01 JST）
    const now = () => end - 3600;
    const relay = new MemoryRelay(now);
    const account = await userWithIdentity(relay, now);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now }), account });
    expect(await screen.findByText('シーズン 1 は 1/1 0:00 に終わります。結果報告の締め切りがシーズン内に収まらないため、新しい対戦はシーズン 2 から受け付けます。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '対戦相手を探す' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Ranking', () => {
  test('shows an empty state without rated players', async () => {
    renderWithApp(<Ranking />);
    expect(await screen.findByText('まだ対戦記録がありません。')).toBeTruthy();
  });
});

describe('game select', () => {
  test('choosing chess hides the character select, recruits for chess and is remembered', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    location.hash = '#/lobby';
    const relay = new MemoryRelay(realNow);
    const a = await userWithIdentity(relay);
    const view = renderWithApp(<App />, { deps: makeDeps({ relay, now: realNow }), account: a });
    const select = (await screen.findByLabelText('ゲーム')) as HTMLSelectElement;
    expect(select.value).toBe('smash_sp');
    expect(await screen.findByLabelText('1戦目に使うキャラ')).toBeTruthy();

    await user.selectOptions(select, 'chess');
    await waitFor(() => expect(screen.queryByLabelText('1戦目に使うキャラ')).toBeNull());
    await user.click(await screen.findByRole('button', { name: '対戦相手を探す' }));
    await waitFor(() => expect(relay.all().filter((e) => e.kind === KIND.recruitment)).toHaveLength(1));
    const rec = relay.all().find((e) => e.kind === KIND.recruitment)!;
    expect(rec.tags.find((t) => t[0] === 'd')).toEqual(['d', 'chess']);
    expect(JSON.parse(rec.content).firstFighter).toBe('');
    // 待っている間は、ゲームを切り替えられない
    expect(select.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    view.unmount();

    // 開き直すと、最後に選んだゲームで始まる
    renderWithApp(<App />, { deps: makeDeps({ relay, now: realNow }), account: a });
    expect(((await screen.findByLabelText('ゲーム')) as HTMLSelectElement).value).toBe('chess');
  });
});
