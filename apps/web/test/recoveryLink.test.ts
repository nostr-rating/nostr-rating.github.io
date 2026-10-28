import { afterEach, describe, expect, test, vi } from 'vitest';
import { recoveryLink, recoveryUrl, withRecoveryLink } from '../src/recoveryLink.js';

afterEach(() => vi.unstubAllEnvs());

describe('recoveryUrl', () => {
  test('uses the release page found at build time', () => {
    expect(recoveryUrl({ VITE_RECOVERY_URL: 'https://github.com/o/r/releases/tag/recovery-v2', VITE_REPO_URL: 'https://github.com/o/r' })).toBe(
      'https://github.com/o/r/releases/tag/recovery-v2',
    );
  });

  test('falls back to the list of releases when no recovery release exists yet', () => {
    expect(recoveryUrl({ VITE_RECOVERY_URL: '', VITE_REPO_URL: 'https://github.com/o/r' })).toBe('https://github.com/o/r/releases');
  });

  test('is null without a repository', () => {
    expect(recoveryUrl({})).toBeNull();
  });
});

describe('withRecoveryLink', () => {
  const html = '<p>前</p>\n        <!-- recovery-link -->\n<p>後</p>';

  test('puts the link where the help page marks it', () => {
    expect(withRecoveryLink(html, 'https://github.com/o/r/releases/tag/recovery-v2')).toBe(
      '<p>前</p>\n        <p><a href="https://github.com/o/r/releases/tag/recovery-v2" target="_blank" rel="noopener noreferrer">復活の道具を入手する</a>（リリースのページです。ファイルの sha256 もそこで確かめられます）</p>\n<p>後</p>',
    );
  });

  test('drops the mark when there is no link', () => {
    expect(withRecoveryLink(html, null)).toBe('<p>前</p>\n        \n<p>後</p>');
  });
});

describe('recoveryLink', () => {
  test('reads the link baked in at build time', () => {
    vi.stubEnv('VITE_RECOVERY_URL', 'https://github.com/o/r/releases/tag/recovery-v2');
    expect(recoveryLink()).toBe('https://github.com/o/r/releases/tag/recovery-v2');
  });

  test('is null when the build has none', () => {
    vi.stubEnv('VITE_RECOVERY_URL', '');
    expect(recoveryLink()).toBeNull();
  });
});
