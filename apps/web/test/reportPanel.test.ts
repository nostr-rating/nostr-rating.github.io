import type { MatchRecord, ReportResult, ResultReport } from '@nostr-rating/core';
import { describe, expect, test } from 'vitest';
import { latestReports, reportStatus, resultSent } from '../src/components/ReportPanel.js';
import { def } from './helpers.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const T0 = 1_790_800_000;
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
  sessions: [],
  seed: '1'.repeat(64),
};
let seq = 0;
const rep = (reporter: string, result: ReportResult, at: number): ResultReport => {
  seq += 1;
  return { id: seq.toString(16).padStart(64, '0'), matchId: match.id, reporter, result, createdAt: at };
};

describe('the report panel only shows reports that count (docs/adr/0015)', () => {
  test('a cancel sent after a result is not shown as my report, and cancel stays unavailable', () => {
    const r = [rep(A, 'win', T0 + 5), rep(A, 'cancel', T0 + 9)];
    expect([latestReports(def, match, r, T0 + 10).get(A), resultSent(def, match, r, A, T0 + 10)]).toEqual(['win', true]);
  });

  test('when a result follows a cancel pair, the room reopens as a mismatch', () => {
    const r = [rep(A, 'cancel', T0 + 5), rep(B, 'cancel', T0 + 7)];
    expect(reportStatus(def, match, r, B, T0 + 8)).toBe('対戦は中止になりました');
    expect(reportStatus(def, match, [...r, rep(A, 'win', T0 + 9)], B, T0 + 10)).toBe('報告が食い違っています。確認して送り直してください。');
  });

  test('reports outside the match window do not count as a sent result', () => {
    const r = [rep(A, 'win', T0 - 1), rep(A, 'lose', T0 + 20)];
    expect([resultSent(def, match, r, A, T0 + 10), latestReports(def, match, r, T0 + 10).has(A)]).toEqual([false, false]);
  });
});
