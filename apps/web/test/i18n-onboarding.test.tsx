import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { setLocale } from '../src/i18n.js';
import { Onboarding } from '../src/pages/Onboarding.js';
import { makeDeps, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  location.hash = '#/onboarding';
  setLocale('en');
});
afterEach(() => {
  cleanup();
  setLocale('ja');
});

describe('Onboarding in English', () => {
  test('the first screen and the recovery words are shown in English', async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome to Nostr-Rating');
    expect(screen.getByRole('link', { name: 'How to protect your account' }).getAttribute('href')).toBe('/help/account.en.html');
    await user.click(screen.getByRole('button', { name: 'Start on this device' }));

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Recovery words');
    expect(screen.getByTestId('skip-hint').textContent).toBe(
      'If you start without writing them down, you cannot restore your account when you lose all your devices.',
    );
    await user.click(screen.getByRole('button', { name: 'I wrote them down' }));
    expect(screen.getByText(/^Let's check/).textContent).toBe("Let's check that you wrote them down. Enter the following words.");
    expect(screen.getAllByLabelText(/^Word \d+$/)).toHaveLength(3);
  });

  test('switching the language redraws the screen', async () => {
    renderWithApp(<Onboarding />, { deps: makeDeps({ now: realNow }) });
    expect(screen.getByRole('button', { name: 'I already have an account' })).toBeTruthy();
    act(() => setLocale('ja'));
    expect(screen.getByRole('button', { name: 'すでにアカウントを持っている' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('ja');
  });
});
