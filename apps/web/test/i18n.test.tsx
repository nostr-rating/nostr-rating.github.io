import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { locale, messages, setLocale, tr, useT, useText } from '../src/i18n.js';

const M = messages({ ja: { hello: 'こんにちは', count: (n: number) => `${n}戦` }, en: { hello: 'Hello', count: (n: number) => `${n} matches` } });

function Hello() {
  const t = useT(M);
  const text = useText();
  return (
    <p>
      {t.hello} {t.count(3)} {text({ ja: 'チェス', en: 'Chess' })}
    </p>
  );
}

afterEach(() => setLocale('ja'));

describe('i18n', () => {
  test('starts in the browser language', () => {
    expect(locale()).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });

  test('switching re-renders, remembers the choice and sets the page language', () => {
    render(<Hello />);
    expect(screen.getByRole('paragraph').textContent).toBe('こんにちは 3戦 チェス');
    act(() => setLocale('en'));
    expect(screen.getByRole('paragraph').textContent).toBe('Hello 3 matches Chess');
    expect([tr(M).hello, localStorage.getItem('nostr-rating:locale'), document.documentElement.lang]).toEqual(['Hello', 'en', 'en']);
  });
});
