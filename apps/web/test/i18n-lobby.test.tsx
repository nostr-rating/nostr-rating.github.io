import { MemoryRelay } from '@nostr-rating/core';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { setLocale } from '../src/i18n.js';
import { Lobby } from '../src/pages/Lobby.js';
import { Ranking } from '../src/pages/Ranking.js';
import { rangeLabel, Settings } from '../src/pages/Settings.js';
import { makeDeps, newPlayer, renderWithApp } from './helpers.js';

afterEach(() => {
  cleanup();
  setLocale('ja');
});

const realNow = () => Math.floor(Date.now() / 1000);

describe('English screens', () => {
  test('the lobby shows its texts and the fighter names in English', async () => {
    setLocale('en');
    const relay = new MemoryRelay(realNow);
    const { account } = await newPlayer(relay, realNow);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), account });
    expect(await screen.findByRole('heading', { name: 'Find an opponent' })).toBeTruthy();
    expect(screen.getByText('To play, link an X or GitHub account.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Link an account' })).toBeTruthy();
    const fighter = screen.getByLabelText('Fighter for game 1') as HTMLSelectElement;
    expect(fighter.options[0]!.textContent).toBe('Mario');
    expect((screen.getByLabelText('Rating gap to match within') as HTMLSelectElement).options[0]!.textContent).toBe('No limit');
  });

  test('switching the language redraws the screen', async () => {
    const relay = new MemoryRelay(realNow);
    const { account } = await newPlayer(relay, realNow);
    renderWithApp(<Ranking />, { deps: makeDeps({ relay, now: realNow }), account });
    expect(await screen.findByText('まだ対戦記録がありません。')).toBeTruthy();
    act(() => setLocale('en'));
    await waitFor(() => expect(screen.getByText('No match records yet.')).toBeTruthy());
    expect(screen.getByText('Matches before their deadline (24 hours after the match) are provisional.')).toBeTruthy();
  });

  test('settings show the stage ban and rematch choices in English', async () => {
    setLocale('en');
    const relay = new MemoryRelay(realNow);
    const { account } = await newPlayer(relay, realNow);
    renderWithApp(<Settings />, { deps: makeDeps({ relay, now: realNow }), account });
    expect(await screen.findByRole('heading', { name: 'Stage bans' })).toBeTruthy();
    const rematch = screen.getByLabelText('Rematches') as HTMLSelectElement;
    expect([...rematch.options].slice(0, 3).map((o) => o.textContent)).toEqual([
      'Allow rematches',
      'Do not match opponents I played within 1 hour',
      'Do not match opponents I played within 3 hours',
    ]);
    expect(rangeLabel(null)).toBe('No limit');
  });
});
