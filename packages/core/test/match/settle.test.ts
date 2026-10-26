import { describe, expect, test } from 'vitest';
import type { MatchRecord, ReportResult, ResultReport } from '../../src/events/codec.js';
import { mannersDelta, settleMatch } from '../../src/match/settle.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const T0 = 1000;
const DL = 86400;

const match: MatchRecord = {
  id: 'f'.repeat(64),
  createdAt: T0,
  p1: A,
  p2: B,
  p1Fighter: 'mario',
  p2Fighter: 'fox',
  p1SettingsId: '1'.repeat(64),
  p2SettingsId: '2'.repeat(64),
  applicationId: '3'.repeat(64),
};

let seq = 0;
function rep(reporter: string, result: ReportResult, at: number): ResultReport {
  seq += 1;
  return { id: seq.toString(16).padStart(64, '0'), matchId: match.id, reporter, result, createdAt: at };
}

describe('settleMatch', () => {
  test('win/lose confirms at the agreeing report time', () => {
    expect(settleMatch(match, [rep(A, 'win', T0 + 10), rep(B, 'lose', T0 + 20)], T0 + 30, DL)).toEqual({
      status: 'confirmed',
      winner: A,
      loser: B,
      settledAt: T0 + 20,
    });
  });

  test('input order does not matter', () => {
    expect(settleMatch(match, [rep(B, 'win', T0 + 20), rep(A, 'lose', T0 + 10)], T0 + 30, DL)).toEqual({
      status: 'confirmed',
      winner: B,
      loser: A,
      settledAt: T0 + 20,
    });
  });

  test('agreement is final even if a later report contradicts it', () => {
    const r = [rep(A, 'win', T0 + 10), rep(B, 'lose', T0 + 20), rep(B, 'win', T0 + 30)];
    expect(settleMatch(match, r, T0 + DL + 1, DL)).toEqual({ status: 'confirmed', winner: A, loser: B, settledAt: T0 + 20 });
  });

  test('backdated contradicting report cannot undo an agreement', () => {
    const r = [rep(B, 'lose', T0 + 100), rep(A, 'win', T0 + 200), rep(B, 'win', T0 + 150)];
    expect(settleMatch(match, r, T0 + DL, DL)).toEqual({ status: 'confirmed', winner: A, loser: B, settledAt: T0 + 200 });
  });

  test('future-dated reports are ignored until their time', () => {
    const r = [rep(A, 'win', T0 + 10), rep(B, 'lose', T0 + 500)];
    expect(settleMatch(match, r, T0 + 499, DL)).toEqual({ status: 'pending' });
    expect(settleMatch(match, r, T0 + 500, DL)).toEqual({ status: 'confirmed', winner: A, loser: B, settledAt: T0 + 500 });
  });

  test('mismatch then correction before deadline confirms', () => {
    const r = [rep(A, 'win', T0 + 10), rep(B, 'win', T0 + 20), rep(B, 'lose', T0 + 40)];
    expect(settleMatch(match, r, T0 + 50, DL)).toEqual({ status: 'confirmed', winner: A, loser: B, settledAt: T0 + 40 });
  });

  test('report after deadline is ignored', () => {
    const r = [rep(A, 'win', T0 + 10), rep(B, 'lose', T0 + DL + 1)];
    expect(settleMatch(match, r, T0 + DL + 5, DL)).toEqual({ status: 'no_report', settledAt: T0 + DL, missing: [B] });
  });

  test('report exactly at deadline counts', () => {
    const r = [rep(A, 'win', T0 + 10), rep(B, 'lose', T0 + DL)];
    expect(settleMatch(match, r, T0 + DL, DL)).toEqual({ status: 'confirmed', winner: A, loser: B, settledAt: T0 + DL });
  });

  test('report before match creation is ignored', () => {
    const r = [rep(A, 'win', T0 - 1), rep(B, 'lose', T0 + 10)];
    expect(settleMatch(match, r, T0 + DL, DL)).toEqual({ status: 'no_report', settledAt: T0 + DL, missing: [A] });
  });

  test('only one side reported → no_report with missing=[other]', () => {
    expect(settleMatch(match, [rep(B, 'lose', T0 + 5)], T0 + DL, DL)).toEqual({
      status: 'no_report',
      settledAt: T0 + DL,
      missing: [A],
    });
  });

  test('nobody reported → no_report with both missing', () => {
    expect(settleMatch(match, [], T0 + DL, DL)).toEqual({ status: 'no_report', settledAt: T0 + DL, missing: [A, B] });
  });

  test('cancel/cancel → cancelled early', () => {
    expect(settleMatch(match, [rep(A, 'cancel', T0 + 5), rep(B, 'cancel', T0 + 7)], T0 + 8, DL)).toEqual({
      status: 'cancelled',
      settledAt: T0 + 7,
    });
  });

  test('both reported but disagree at deadline → mismatch', () => {
    expect(settleMatch(match, [rep(A, 'win', T0 + 5), rep(B, 'cancel', T0 + 7)], T0 + DL, DL)).toEqual({
      status: 'mismatch',
      settledAt: T0 + DL,
    });
  });

  test('pending before deadline without agreement', () => {
    expect(settleMatch(match, [rep(A, 'win', T0 + 5), rep(B, 'win', T0 + 7)], T0 + DL - 1, DL)).toEqual({ status: 'pending' });
  });

  test('reports from third parties and other matches are ignored', () => {
    const other = { ...rep(B, 'lose', T0 + 5), matchId: 'e'.repeat(64) };
    expect(settleMatch(match, [rep(A, 'win', T0 + 3), rep(C, 'lose', T0 + 4), other], T0 + 6, DL)).toEqual({ status: 'pending' });
  });

  test('same-second reports are ordered by id', () => {
    const r1 = { ...rep(B, 'win', T0 + 5), id: '0'.repeat(63) + '1' };
    const r2 = { ...rep(B, 'lose', T0 + 5), id: '0'.repeat(63) + '2' };
    expect(settleMatch(match, [r2, rep(A, 'win', T0 + 1), r1], T0 + 6, DL)).toEqual({
      status: 'confirmed',
      winner: A,
      loser: B,
      settledAt: T0 + 5,
    });
  });
});

describe('mannersDelta', () => {
  test('cancelled counts cancel for both', () => {
    expect(mannersDelta(match, { status: 'cancelled', settledAt: 1 })).toEqual({
      [A]: { noReport: 0, cancel: 1, mismatch: 0 },
      [B]: { noReport: 0, cancel: 1, mismatch: 0 },
    });
  });

  test('mismatch counts mismatch for both', () => {
    expect(mannersDelta(match, { status: 'mismatch', settledAt: 1 })).toEqual({
      [A]: { noReport: 0, cancel: 0, mismatch: 1 },
      [B]: { noReport: 0, cancel: 0, mismatch: 1 },
    });
  });

  test('nobody reported counts nothing', () => {
    expect(mannersDelta(match, { status: 'no_report', settledAt: 1, missing: [A, B] })).toEqual({});
  });

  test('no_report counts only missing players', () => {
    expect(mannersDelta(match, { status: 'no_report', settledAt: 1, missing: [B] })).toEqual({
      [B]: { noReport: 1, cancel: 0, mismatch: 0 },
    });
  });

  test('confirmed and pending count nothing', () => {
    expect(mannersDelta(match, { status: 'confirmed', winner: A, loser: B, settledAt: 1 })).toEqual({});
    expect(mannersDelta(match, { status: 'pending' })).toEqual({});
  });
});
