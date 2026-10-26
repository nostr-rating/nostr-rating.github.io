import { describe, expect, test } from 'vitest';
import { applyWeight, glicko2Update, inflateRd, round6 } from '../../src/rating/glicko2.js';

const isRound6 = (x: number) => round6(x) === x;

describe('glicko2Update', () => {
  test('matches Glickman (2013) worked example', () => {
    const r = glicko2Update(
      { rating: 1500, rd: 200, volatility: 0.06 },
      [
        { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
        { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
        { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
      ],
      0.5,
    );
    // 論文の 1464.06 は途中の値を丸めた結果。丸めない計算では 1464.0507
    expect(r.rating).toBeCloseTo(1464.05, 2);
    expect(r.rd).toBeCloseTo(151.52, 2);
    expect(r.volatility).toBeCloseTo(0.05999, 4);
  });

  test('win against equal opponent raises rating and lowers rd', () => {
    const p = { rating: 1500, rd: 350, volatility: 0.06 };
    const r = glicko2Update(p, [{ opponent: p, score: 1 }], 0.5);
    expect(r.rating).toBeGreaterThan(1500);
    expect(r.rd).toBeLessThan(350);
  });

  test('no results only widens rd', () => {
    const r = glicko2Update({ rating: 1600, rd: 50, volatility: 0.06 }, [], 0.5);
    expect(r.rating).toBe(1600);
    expect(r.rd).toBeCloseTo(Math.sqrt(50 ** 2 + (0.06 * 173.7178) ** 2), 6);
  });

  test('outputs are rounded to 6 decimals', () => {
    const r = glicko2Update(
      { rating: 1500, rd: 200, volatility: 0.06 },
      [{ opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 }],
      0.5,
    );
    expect(isRound6(r.rating) && isRound6(r.rd) && isRound6(r.volatility)).toBe(true);
  });
});

describe('inflateRd', () => {
  test('grows with periods', () => {
    const r = inflateRd({ rating: 1500, rd: 50, volatility: 0.06 }, 10, 350);
    expect(r.rd).toBeCloseTo(Math.sqrt(50 ** 2 + 10 * (0.06 * 173.7178) ** 2), 6);
    expect(r.rating).toBe(1500);
  });

  test('caps at maxRd', () => {
    expect(inflateRd({ rating: 1500, rd: 340, volatility: 0.06 }, 1000, 350).rd).toBe(350);
  });

  test('zero periods is identity', () => {
    const p = { rating: 1500, rd: 50, volatility: 0.06 };
    expect(inflateRd(p, 0, 350)).toEqual(p);
  });
});

describe('applyWeight', () => {
  test('0.5 halves the change', () => {
    const before = { rating: 1500, rd: 200, volatility: 0.06 };
    const after = { rating: 1520, rd: 180, volatility: 0.07 };
    expect(applyWeight(before, after, 0.5)).toEqual({ rating: 1510, rd: 190, volatility: 0.065 });
  });

  test('1 returns after', () => {
    const before = { rating: 1500, rd: 200, volatility: 0.06 };
    const after = { rating: 1520.123456, rd: 180, volatility: 0.07 };
    expect(applyWeight(before, after, 1)).toEqual(after);
  });
});
