import { describe, expect, test } from 'vitest';
import { allowedRange, canMatch, type SeekerView } from '../../src/match/conditions.js';
import { def } from '../helpers/def.js';

const T = 1_000_000;
const seeker = (o: Partial<SeekerView>): SeekerView => ({
  pubkey: 'a',
  rating: 1500,
  rangeChoice: null,
  rematchHours: 0,
  waitingSince: T,
  mannersTotal: 0,
  ...o,
});

describe('allowedRange', () => {
  test('fixed choice', () => {
    expect(allowedRange(def, seeker({ rangeChoice: 50 }), T + 600)).toBe(50);
  });

  test('unlimited widens 50 per minute from 200', () => {
    expect(allowedRange(def, seeker({}), T)).toBe(200);
    expect(allowedRange(def, seeker({}), T + 59)).toBe(200);
    expect(allowedRange(def, seeker({}), T + 60)).toBe(250);
    expect(allowedRange(def, seeker({}), T + 239)).toBe(350);
  });
});

describe('canMatch', () => {
  test('narrower range wins', () => {
    const a = seeker({ pubkey: 'a', rating: 1500, rangeChoice: 50 });
    const b = seeker({ pubkey: 'b', rating: 1560 });
    expect(canMatch(def, a, b, T, null)).toBe(false);
    expect(canMatch(def, a, { ...b, rating: 1550 }, T, null)).toBe(true);
  });

  test('symmetric', () => {
    const a = seeker({ pubkey: 'a', rating: 1500, rangeChoice: 100 });
    const b = seeker({ pubkey: 'b', rating: 1650, waitingSince: T - 600 });
    expect(canMatch(def, a, b, T, null)).toBe(canMatch(def, b, a, T, null));
  });

  test('rematch uses the longer window', () => {
    const a = seeker({ pubkey: 'a', rematchHours: 1 });
    const b = seeker({ pubkey: 'b', rematchHours: 3 });
    expect(canMatch(def, a, b, T, T - 2 * 3600)).toBe(false);
    expect(canMatch(def, a, b, T, T - 3 * 3600)).toBe(true);
  });

  test('rematch 0 allows immediate rematch', () => {
    expect(canMatch(def, seeker({ pubkey: 'a' }), seeker({ pubkey: 'b' }), T, T - 1)).toBe(true);
  });

  test('manners difference over 5 blocks', () => {
    expect(canMatch(def, seeker({ pubkey: 'a', mannersTotal: 0 }), seeker({ pubkey: 'b', mannersTotal: 5 }), T, null)).toBe(true);
    expect(canMatch(def, seeker({ pubkey: 'a', mannersTotal: 0 }), seeker({ pubkey: 'b', mannersTotal: 6 }), T, null)).toBe(false);
  });

  test('never matches self', () => {
    expect(canMatch(def, seeker({ pubkey: 'a' }), seeker({ pubkey: 'a' }), T, null)).toBe(false);
  });
});
