import { MemoryRelay, sideOf } from '@nostr-rating/core';
import { cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MatchRoom } from '../src/pages/MatchRoom.js';
import { makeDeps, matchBetween, newPlayer, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(cleanup);

async function setup() {
  const relay = new MemoryRelay(realNow);
  const claims = [{ platform: 'github' as const, identity: 'u', proof: 'abc' }];
  const a = await newPlayer(relay, realNow, { claims });
  const b = await newPlayer(relay, realNow, { claims });
  // a（フォックス）はマリオ相手に終点を拒否、b（マリオ）はフォックス相手に戦場とすま村を拒否
  const match = await matchBetween(relay, a, b, { bansA: { mario: ['final_destination'] }, bansB: { fox: ['battlefield', 'smashville'] } });
  const roomA = renderWithApp(<MatchRoom matchId={match.id} />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
  const roomB = renderWithApp(<MatchRoom matchId={match.id} />, { deps: makeDeps({ relay, now: realNow }), account: b.account });
  const [A, B] = [within(roomA.container), within(roomB.container)];
  // 部屋を立てるのは、マッチの id で決まった1つ目の側（P1）
  const p1First = sideOf(match.id, 'p1') === 0;
  return { relay, match, A, B, host: p1First ? A : B, guest: p1First ? B : A };
}

describe('MatchRoom', () => {
  test('P1 sends the room id and P2 sees it with the password', async () => {
    const user = userEvent.setup();
    const { host, guest } = await setup();
    expect((await host.findByTestId('my-side')).textContent).toBe('あなたは「P1」です（相手は「P2」）。');
    await user.type(await host.findByLabelText('部屋 ID'), 'AB12C');
    await user.click(host.getByRole('button', { name: '部屋 ID を送る' }));
    expect((await guest.findByTestId('room-id', {}, { timeout: 5000 })).textContent).toBe('AB12C');
    expect(guest.getByTestId('room-password').textContent).toBe('1122');
    expect(guest.queryByLabelText('部屋 ID')).toBeNull();
  });

  test('room id that is not 5 characters cannot be sent', async () => {
    const user = userEvent.setup();
    const { host } = await setup();
    await user.type(await host.findByLabelText('部屋 ID'), 'AB12');
    expect((host.getByRole('button', { name: '部屋 ID を送る' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('stage guide applies both bans in game 1 and only the winner bans afterwards', async () => {
    const user = userEvent.setup();
    const { A, B } = await setup();
    await waitFor(() =>
      expect(A.getByTestId('stage-options').textContent).toBe('ポケモンスタジアム2・小戦場・ホロウバスティオン・村と街'),
    );
    expect(A.getByTestId('stage-picker').textContent).toBe('1戦目: お互いが選び、ゲーム内の抽選に従います');
    // 1戦目は P1（フォックス）の勝ち → 2戦目は P2（マリオ）が選ぶ。除くのは P1 がマリオに設定した終点だけ
    await user.click(await B.findByRole('button', { name: '1戦目: 相手の勝ち' }));
    expect(B.getByTestId('stage-picker').textContent).toBe('2戦目: あなたが選びます（相手は「おまかせ」）');
    expect(B.getByTestId('stage-options').textContent).toBe('戦場・ポケモンスタジアム2・小戦場・ホロウバスティオン・村と街・すま村');
    await user.click(A.getByRole('button', { name: '1戦目: あなたの勝ち' }));
    expect(A.getByTestId('stage-picker').textContent).toBe('2戦目: 相手が選びます（あなたは「おまかせ」）');
  });

  test('win/lose reports confirm on both screens', async () => {
    const user = userEvent.setup();
    const { A, B } = await setup();
    await user.click(await A.findByRole('button', { name: '勝ち' }));
    await user.click(await B.findByRole('button', { name: '負け' }));
    await waitFor(() => {
      expect(A.getByTestId('report-status').textContent).toBe('結果が確定しました（あなたの勝ち）');
      expect(B.getByTestId('report-status').textContent).toBe('結果が確定しました（相手の勝ち）');
    }, { timeout: 5000 });
  });

  test('win/win shows a mismatch', async () => {
    const user = userEvent.setup();
    const { A, B } = await setup();
    await user.click(await A.findByRole('button', { name: '勝ち' }));
    await user.click(await B.findByRole('button', { name: '勝ち' }));
    await waitFor(() => expect(A.getByTestId('report-status').textContent).toBe('報告が食い違っています。確認して送り直してください。'), { timeout: 5000 });
  });

  describe('chess (invite link, draw)', () => {
    async function chessSetup() {
      const relay = new MemoryRelay(realNow);
      const claims = [{ platform: 'github' as const, identity: 'u', proof: 'abc' }];
      const a = await newPlayer(relay, realNow, { claims });
      const b = await newPlayer(relay, realNow, { claims });
      const match = await matchBetween(relay, a, b, { game: 'chess' });
      const roomA = renderWithApp(<MatchRoom matchId={match.id} />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
      const roomB = renderWithApp(<MatchRoom matchId={match.id} />, { deps: makeDeps({ relay, now: realNow }), account: b.account });
      const [A, B] = [within(roomA.container), within(roomB.container)];
      const p1First = sideOf(match.id, 'p1') === 0;
      return { relay, match, host: p1First ? A : B, guest: p1First ? B : A };
    }

    test('white sends an https invite link and black sees its host name before opening', async () => {
      const user = userEvent.setup();
      const { host, guest } = await chessSetup();
      expect((await host.findByTestId('my-side')).textContent).toBe('あなたは「白」です（相手は「黒」）。');
      expect((await guest.findByTestId('my-side')).textContent).toBe('あなたは「黒」です（相手は「白」）。');
      expect(guest.queryByLabelText('招待リンク（https:// で始まるもの）')).toBeNull();
      const input = await host.findByLabelText('招待リンク（https:// で始まるもの）');
      const send = host.getByRole('button', { name: '招待リンクを送る' }) as HTMLButtonElement;
      await user.type(input, 'http://chess.example/invite/1');
      expect(send.disabled).toBe(true);
      await user.clear(input);
      await user.type(input, 'https://chess.example/invite/1');
      await user.click(send);
      expect((await guest.findByTestId('invite-host', {}, { timeout: 5000 })).textContent).toBe('chess.example');
      expect(guest.getByRole('link', { name: '招待リンクを開く' }).getAttribute('href')).toBe('https://chess.example/invite/1');
      // キャラもステージもないゲームなので、ステージの案内は出ない
      expect(guest.queryByText('ステージ', { exact: false })).toBeNull();
    });

    test('both reporting a draw settles the match as a draw', async () => {
      const user = userEvent.setup();
      const { host, guest } = await chessSetup();
      await user.click(await host.findByRole('button', { name: '引き分け' }));
      await user.click(await guest.findByRole('button', { name: '引き分け' }));
      await waitFor(() => expect(host.getByTestId('report-status').textContent).toBe('結果が確定しました（引き分け）'), { timeout: 5000 });
      await waitFor(() => expect(guest.getByTestId('report-status').textContent).toBe('結果が確定しました（引き分け）'), { timeout: 5000 });
    });
  });
});
