import { describe, expect, test } from 'vitest';
import { coalesce } from '../src/services/coalesce.js';

describe('coalesce', () => {
  test('runs one at a time and runs once more for every request made while running', async () => {
    const started: number[] = [];
    let release: (() => void)[] = [];
    let n = 0;
    const run = coalesce(async () => {
      const i = ++n;
      started.push(i);
      await new Promise<void>((r) => release.push(r));
      return i;
    });
    const a = run();
    const b = run();
    const c = run();
    expect(started).toEqual([1]);
    release.shift()!();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 2]);
    release.shift()!();
    expect(await Promise.all([a, b, c])).toEqual([1, 2, 2]);
    expect(started).toEqual([1, 2]);
    release = [];
  });

  test('a failure does not block the next run', async () => {
    let fail = true;
    const run = coalesce(async () => {
      if (fail) throw new Error('down');
      return 'ok';
    });
    await expect(run()).rejects.toThrow(new Error('down'));
    fail = false;
    expect(await run()).toBe('ok');
  });
});
