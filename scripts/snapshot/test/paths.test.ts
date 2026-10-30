import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cliPath } from '../src/paths.js';

describe('cliPath', () => {
  test('a relative path is taken from where npm was run, not from the workspace', () => {
    expect(cliPath('apps/web/dist', { INIT_CWD: '/work/repo' }, '/work/repo/scripts/snapshot')).toBe(join(resolve('/work/repo'), 'apps/web/dist'));
  });

  test('without npm, a relative path is taken from the current directory', () => {
    expect(cliPath('out', {}, '/work/here')).toBe(join(resolve('/work/here'), 'out'));
  });

  test('an absolute path stays as it is', () => {
    expect(cliPath('/abs/out', { INIT_CWD: '/work/repo' }, '/x')).toBe(resolve('/abs/out'));
  });
});
