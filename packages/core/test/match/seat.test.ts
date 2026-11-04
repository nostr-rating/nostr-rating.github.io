import { describe, expect, test } from 'vitest';
import { isSeed, newSeed, seedCommit, sideOf } from '../../src/match/seat.js';

describe('seat draw (docs/adr/0013)', () => {
  test('the commitment is the SHA-256 of the seed string', () => {
    expect(seedCommit('1'.repeat(64))).toBe('3138bb9bc78df27c473ecfd1410f7bd45ebac1f59cf3ff9cfe4db77aab7aedd3');
  });

  test('p1 and p2 always get opposite sides, decided by the last hex digit of SHA256(p1 seed ‖ p2 seed)', () => {
    // SHA256('1'×64 ‖ '4'×64) は …c4（偶数）、SHA256('1'×64 ‖ '2'×64) は …13（奇数）。値は shasum -a 256 で確かめた
    expect([sideOf('1'.repeat(64), '4'.repeat(64), 'p1'), sideOf('1'.repeat(64), '4'.repeat(64), 'p2')]).toEqual([0, 1]);
    expect([sideOf('1'.repeat(64), '2'.repeat(64), 'p1'), sideOf('1'.repeat(64), '2'.repeat(64), 'p2')]).toEqual([1, 0]);
  });

  test('a new seed is 32 random bytes in lowercase hex', () => {
    const s = newSeed();
    expect([isSeed(s), s === newSeed()]).toEqual([true, false]);
    expect([isSeed('A'.repeat(64)), isSeed('1'.repeat(63)), isSeed(1)]).toEqual([false, false, false]);
  });
});
