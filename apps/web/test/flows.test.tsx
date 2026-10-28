import { buildMatch, buildReport, buildSettings, KIND, MemoryRelay, sideOf, verificationText, type RelayClient } from '@nostr-rating/core';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Lobby } from '../src/pages/Lobby.js';
import { MatchRoom } from '../src/pages/MatchRoom.js';
import { makeDeps, matchBetween, newPlayer, renderWithApp, type Player } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  localStorage.clear();
  location.hash = '#/lobby';
});
afterEach(cleanup);

const player = (relay: MemoryRelay, name: string, gist: string) =>
  newPlayer(relay, realNow, { name, claims: [{ platform: 'github', identity: name, proof: gist }] });

function gistRoutes(entries: { login: string; gist: string; aid: string }[]): Record<string, unknown> {
  return Object.fromEntries(
    entries.map((e) => [`https://api.github.com/gists/${e.gist}`, { owner: { login: e.login }, files: { f: { content: verificationText(e.aid) } } }]),
  );
}

describe('match room', () => {
  test('shows the opponent name and the verification status of their SNS claim', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    const routes = gistRoutes([{ login: 'bob', gist: 'bbb1', aid: b.aid }]);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow, routes }), account: a.account });
    expect(await screen.findByText('bob', { selector: 'strong' })).toBeTruthy();
    expect(await screen.findByText('確認済み')).toBeTruthy();
  });

  test('after confirmation the report buttons are gone and my report is shown', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    await relay.publish(await b.signer.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: m.sessions[0]!, result: 'lose' }, realNow())));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    await user.click(await screen.findByRole('button', { name: '勝ち' }));
    await waitFor(() => expect(screen.getByTestId('report-status').textContent).toBe('結果が確定しました（あなたの勝ち）'));
    expect(screen.queryByRole('button', { name: '勝ち' })).toBeNull();
    expect(screen.getByText('あなたの報告: 勝ち')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ロビーに戻る' })).toBeTruthy();
  });

  test('reporting asks for confirmation and sends nothing when cancelled', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    await user.click(await screen.findByRole('button', { name: '負け' }));
    expect(relay.all().filter((e) => e.kind === KIND.report)).toHaveLength(0);
  });

  test('a failed send is shown to the player', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    const failing: RelayClient = { ...relay, query: relay.query.bind(relay), subscribe: relay.subscribe.bind(relay), close: () => undefined, publish: async () => { throw new Error('offline'); } };
    // 部屋を立てる側（マッチの id で決まる）として開く
    const host = sideOf(m.id, 'p1') === 0 ? a : b;
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: { ...makeDeps({ relay, now: realNow }), relay: failing }, account: host.account });
    await user.type(await screen.findByLabelText('部屋 ID'), 'AB12C');
    await user.click(screen.getByRole('button', { name: '部屋 ID を送る' }));
    expect(await screen.findByText('送れませんでした。電波のよい場所でもう一度押してください。')).toBeTruthy();
  });

  test('stage guide can undo a game and record the opponent changing fighter', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    await user.click(await screen.findByRole('button', { name: '1戦目: あなたの勝ち' }));
    await user.selectOptions(screen.getByLabelText('相手のキャラ（直前の敗者が変えたとき）'), 'luigi');
    expect(screen.getByTestId('stage-options').textContent).toBe('終点・戦場・ポケモンスタジアム2・小戦場・ホロウバスティオン・村と街・すま村');
    await user.click(screen.getByRole('button', { name: '1つ前に戻す' }));
    expect(screen.getByTestId('stage-picker').textContent).toBe('1戦目: お互いが選び、ゲーム内の抽選に従います');
  });

  test('shows the excluded stages and the report deadline', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), account: b.account });
    await waitFor(() => expect(screen.getByTestId('excluded-stages').textContent).toBe('除外: 終点（相手の拒否）'));
    expect(screen.getByTestId('deadline').textContent).toMatch(/^報告の締め切り: \d{1,2}\/\d{1,2} \d{2}:\d{2}（あと 23時間\d+分）$/);
  });
});

async function forgedMatch(relay: MemoryRelay, attacker: Player, victim: Player): Promise<string> {
  const ev = await attacker.signer.signEvent(
    buildMatch(
      'smash_sp',
      {
        p1: attacker.aid,
        p2: victim.aid,
        p1Fighter: 'fox',
        p2Fighter: 'mario',
        p1SettingsId: '1'.repeat(64),
        p2SettingsId: '2'.repeat(64),
        applicationId: 'a'.repeat(64),
        sessions: [await attacker.signer.getPublicKey(), await victim.signer.getPublicKey()],
      },
      realNow() - 30,
    ),
  );
  await relay.publish(ev);
  return ev.id;
}

describe('forged matches', () => {
  test('a match without the victim application is not listed in the lobby', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const mallory = await player(relay, 'mallory', 'eee1');
    const real = await matchBetween(relay, a, b);
    await forgedMatch(relay, mallory, b);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: b.account });
    expect(await screen.findByRole('link', { name: '対戦ルームへ戻る（alice さん）' })).toBeTruthy();
    expect(document.querySelectorAll(`a[href^="#/match/"]`)).toHaveLength(1);
    expect(document.querySelector('a[href^="#/match/"]')!.getAttribute('href')).toBe(`#/match/${real.id}`);
  });

  test('opening a forged match room says it is not a valid match', async () => {
    const relay = new MemoryRelay(realNow);
    const b = await player(relay, 'bob', 'bbb1');
    const mallory = await player(relay, 'mallory', 'eee1');
    const id = await forgedMatch(relay, mallory, b);
    renderWithApp(<MatchRoom matchId={id} />, { deps: makeDeps({ relay, now: realNow }), account: b.account });
    expect(await screen.findByText('この対戦は有効ではありません。あなたの申し込みに応えた対戦であることを確かめられませんでした。')).toBeTruthy();
  });
});

describe('lobby', () => {
  test('lists an ongoing match with a way back to the room', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    const link = await screen.findByRole('link', { name: '対戦ルームへ戻る（bob さん）' });
    expect(link.getAttribute('href')).toBe(`#/match/${m.id}`);
  });

  test('search waits for saved settings and keeps the saved stage bans', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    await relay.publish(await a.signer.signEvent(buildSettings('smash_sp', { stageBans: { mario: ['smashville'] }, rangeChoice: 100, rematchHours: 3 }, realNow() - 10)));
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    await waitFor(() => expect((screen.getByRole('button', { name: '対戦相手を探す' }) as HTMLButtonElement).disabled).toBe(false));
    await user.selectOptions(screen.getByLabelText('マッチングするレート差'), '50');
    await user.click(screen.getByRole('button', { name: '対戦相手を探す' }));
    await waitFor(() => expect(relay.all().filter((e) => e.kind === KIND.settings).length).toBe(1));
    const latest = relay.all().find((e) => e.kind === KIND.settings)!;
    expect(JSON.parse(latest.content)).toEqual({ stageBans: { mario: ['smashville'] }, rangeChoice: 50, rematchHours: 3 });
    await user.click(await screen.findByRole('button', { name: 'やめる' }));
  });

  test('pressing search twice starts only one search', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account: a.account });
    const button = await screen.findByRole('button', { name: '対戦相手を探す' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(button);
    await screen.findByRole('button', { name: 'やめる' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(new Set(relay.all().filter((e) => e.kind === KIND.recruitment).map((e) => JSON.parse(e.content).waitingSince)).size).toBe(1);
    await user.click(screen.getByRole('button', { name: 'やめる' }));
  });
});
