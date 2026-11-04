import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TabInUse } from '../src/components/TabInUse.js';
import { setLocale } from '../src/i18n.js';

afterEach(() => setLocale('ja'));

describe('TabInUse', () => {
  test('tells the user to use the tab that is already open, in each language', () => {
    render(<TabInUse />);
    const text = () => screen.getByRole('alert').textContent;
    expect(text()).toBe(
      '複数のタブでは使えませんNostr-Rating は、複数のタブで同時に開くことはできません。すでに開いているタブでご利用ください。このタブで使うときは、ほかのタブを閉じてから押してください。このタブで開き直す',
    );
    act(() => setLocale('en'));
    expect(text()).toBe(
      'Open in another tabNostr-Rating cannot be open in more than one tab at a time. Please use the tab where it is already open.To use it in this tab, close the other tab first, then press the button.Reopen in this tab',
    );
  });
});
