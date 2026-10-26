import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { RatingState } from '../../src/rating/pipeline.js';
import { def } from '../helpers/def.js';
import {
  eventIdsHash,
  ratingConfigHash,
  serializeSnapshot,
  sha256Hex,
  snapshotToState,
  stateToSnapshot,
} from '../../src/snapshot/format.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const fixtureState: RatingState = {
  season: 1,
  cutoff: 1790900000,
  players: {
    [B]: {
      rating: 1420.123456,
      rd: 290.5,
      volatility: 0.059999,
      peakRating: 1500,
      matches: 1,
      wins: 0,
      losses: 1,
      manners: { noReport: 1, cancel: 0, mismatch: 0 },
      lastMatchAt: 1790850000,
      hasIdentity: true,
    },
    [A]: {
      rating: 1579.876544,
      rd: 290.5,
      volatility: 0.060001,
      peakRating: 1579.876544,
      matches: 1,
      wins: 1,
      losses: 0,
      manners: { noReport: 0, cancel: 0, mismatch: 0 },
      lastMatchAt: 1790850000,
      hasIdentity: true,
    },
  },
  recentPairs: [{ a: A, b: B, settledAt: 1790850000 }],
  seasonSummaries: {},
};

const meta = {
  game: 'smash_sp',
  previous: 'snapshots/season_1/2026-10-27.json',
  previousSha256: 'c'.repeat(64),
  eventIds: ['2'.repeat(64), '1'.repeat(64)],
  configSha256: 'd'.repeat(64),
};

describe('snapshot format', () => {
  test('serializeSnapshot matches golden fixture', () => {
    expect(serializeSnapshot(stateToSnapshot(fixtureState, meta))).toBe(
      readFileSync(resolve(__dirname, '../fixtures/snapshot-basic.json'), 'utf8'),
    );
  });

  test('stateToSnapshot ↔ snapshotToState roundtrip', () => {
    expect(snapshotToState(stateToSnapshot(fixtureState, meta))).toEqual(fixtureState);
  });

  test('serialize is independent of object key insertion order', () => {
    const reordered: RatingState = {
      recentPairs: fixtureState.recentPairs,
      players: { [A]: fixtureState.players[A]!, [B]: fixtureState.players[B]! },
      cutoff: fixtureState.cutoff,
      season: 1,
      seasonSummaries: {},
    };
    expect(serializeSnapshot(stateToSnapshot(reordered, meta))).toBe(serializeSnapshot(stateToSnapshot(fixtureState, meta)));
  });

  test('ratingConfigHash covers rating-relevant settings only', () => {
    const changedTau = { ...def, rating: { ...def.rating, tau: 0.6 } };
    const changedName = { ...def, name: '別の名前' };
    expect(ratingConfigHash(changedTau)).not.toBe(ratingConfigHash(def));
    expect(ratingConfigHash(changedName)).toBe(ratingConfigHash(def));
  });

  test('sha256Hex and eventIdsHash', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(eventIdsHash(['b', 'a'])).toBe(sha256Hex('a\nb'));
  });
});
