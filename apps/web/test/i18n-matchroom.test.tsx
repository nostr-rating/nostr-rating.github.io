import { MemoryRelay, sideOf } from '@nostr-rating/core';
import { act, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setLocale } from '../src/i18n.js';
import { MatchRoom } from '../src/pages/MatchRoom.js';
import { stageBanErrorText } from '../src/stageErrors.js';
import { makeDeps, matchBetween, newPlayer, P2_SEED, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  setLocale('en');
});
afterEach(() => {
  cleanup();
  setLocale('ja');
});

describe('the match room in English', () => {
  test('shows sides, format, room notes and the stage guide from the English names in the game definition', async () => {
    const relay = new MemoryRelay(realNow);
    const claims = [{ platform: 'github' as const, identity: 'u', proof: 'abc' }];
    const a = await newPlayer(relay, realNow, { claims });
    const b = await newPlayer(relay, realNow, { claims });
    const match = await matchBetween(relay, a, b);
    const p1First = sideOf(match.seed, P2_SEED, 'p1') === 0;
    const host = within(renderWithApp(<MatchRoom matchId={match.id} />, { deps: makeDeps({ relay, now: realNow }), account: (p1First ? a : b).account }).container);

    expect((await host.findByTestId('my-side')).textContent).toBe('You are "P1" (your opponent is "P2").');
    expect(host.getByTestId('room-format').textContent).toBe('First to 2 wins / 3 stocks, 7-minute time limit / Entry: "Anyone" / Room size: 2 players');
    expect(host.getByTestId('chat-note').textContent).toBe('Send the room ID and password from the "Private room" section above.');
    expect(host.getByTestId('stage-picker').textContent).toBe('Game 1: both players pick, and the in-game random draw decides');
    expect(host.getByTestId('report-status').textContent).toBe('Please report the result');
    expect(host.getByRole('button', { name: 'Send room ID and password' })).toBeTruthy();
  });

  test('switching the language re-renders the room in Japanese', async () => {
    const relay = new MemoryRelay(realNow);
    const claims = [{ platform: 'github' as const, identity: 'u', proof: 'abc' }];
    const a = await newPlayer(relay, realNow, { claims });
    const b = await newPlayer(relay, realNow, { claims });
    const match = await matchBetween(relay, a, b);
    const p1First = sideOf(match.seed, P2_SEED, 'p1') === 0;
    const host = within(renderWithApp(<MatchRoom matchId={match.id} />, { deps: makeDeps({ relay, now: realNow }), account: (p1First ? a : b).account }).container);
    await host.findByTestId('my-side');
    act(() => setLocale('ja'));
    expect(host.getByTestId('my-side').textContent).toBe('あなたは「P1」です（相手は「P2」）。');
    expect(host.getByTestId('room-format').textContent).toBe('2本先取 ／ ストック3・制限時間7分 ／ 入室制限「だれでも」 ／ 部屋の人数 2人');
  });
});

describe('stage ban errors', () => {
  test('are written in the chosen language', () => {
    expect([
      stageBanErrorText({ code: 'too_many', fighter: 'mario', max: 2 }, 'en'),
      stageBanErrorText({ code: 'use_group_key', fighter: 'daisy', key: 'peach' }, 'en'),
      stageBanErrorText({ code: 'too_many', fighter: 'mario', max: 2 }, 'ja'),
    ]).toEqual(['mario: up to 2 stage bans', 'daisy: set this as peach', 'mario: 拒否ステージは2つまでです']);
  });
});
