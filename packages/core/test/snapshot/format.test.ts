import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { KelRecords } from '../../src/kel/book.js';
import type { EvaluatedMatch, RatingState } from '../../src/rating/pipeline.js';
import { def } from '../helpers/def.js';
import {
  buildSnapshot,
  eventIdsHash,
  fromSnapshotMatch,
  kelPrefix,
  publishedFiles,
  ratingConfigHash,
  serializeToc,
  sha256Hex,
  stateFromParts,
  type KelIndexPart,
  type KelPrefixPart,
  type MatchesPart,
  type PlayersPart,
  type SeasonPart,
} from '../../src/snapshot/format.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
/** そのシーズンに対戦していない、前のシーズンの選手 */
const C = 'c'.repeat(64);

/** 形式のテストなので、KEL の中身は確かめられる形でなくてよい */
const fakeKel = (aid: string) => [{ entry: { body: { t: 'icp', aid }, sigs: [] }, at: 1 }] as unknown as KelRecords[string];

const fixtureState: RatingState = {
  season: 2,
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
      draws: 0,
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
      draws: 0,
      manners: { noReport: 0, cancel: 0, mismatch: 0 },
      lastMatchAt: 1790850000,
      hasIdentity: true,
    },
  },
  recentPairs: [{ a: A, b: B, settledAt: 1790850000 }],
  seasonSummaries: { '1': { [C]: { finalRating: 1612, peakRating: 1650, matches: 9, wins: 6, losses: 3, draws: 0 } } },
  kels: { [A]: fakeKel(A), [B]: fakeKel(B), [C]: fakeKel(C) },
  accounts: {
    [A]: { name: 'a', claims: [{ platform: 'github', identity: 'a1', proof: 'a1' }], eventId: '1'.repeat(64), createdAt: 1790800000 },
    [C]: { name: 'c', claims: [], eventId: '3'.repeat(64), createdAt: 1780000000 },
  },
};

const meta = {
  game: 'smash_sp',
  previous: 'snapshots/smash_sp/season_2/2026-10-27.json',
  previousSha256: 'e'.repeat(64),
  eventIds: ['2'.repeat(64), '1'.repeat(64)],
  configSha256: 'd'.repeat(64),
  release: 'snapshot-smash_sp-season_2-2026-10-28',
  matches: [
    {
      id: '5'.repeat(64),
      createdAt: 1790850000,
      p1: A,
      p2: B,
      result: 'p1',
      missing: [],
      rating: {
        weight: 0.5,
        p1: { before: { rating: 1500, rd: 350, volatility: 0.06 }, periods: 0, after: { rating: 1581.155447, rd: 320.159482, volatility: 0.06 } },
        p2: { before: { rating: 1500, rd: 300, volatility: 0.06 }, periods: 2, after: { rating: 1420.5, rd: 310.25, volatility: 0.06 } },
      },
    },
    { id: '6'.repeat(64), createdAt: 1790851000, p1: B, p2: C, result: 'no_report', missing: [C], rating: null },
  ] satisfies EvaluatedMatch[],
};

const FIXTURES = resolve(__dirname, '../fixtures');
const parse = <T>(text: string) => JSON.parse(text) as T;

/** 部品の sha256 から本文を引く */
function textOf(texts: Map<string, string>, sha256: string): string {
  const t = texts.get(sha256);
  if (t === undefined) throw new Error(`no part ${sha256}`);
  return t;
}

describe('snapshot format', () => {
  test('the table of contents matches the golden file', () => {
    expect(serializeToc(buildSnapshot(fixtureState, meta).toc)).toBe(readFileSync(resolve(FIXTURES, 'snapshot-toc.json'), 'utf8'));
  });

  test('the matches part matches the golden file and reads back into the same records', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    const text = textOf(texts, toc.parts.matches!.sha256);
    expect(text).toBe(readFileSync(resolve(FIXTURES, 'snapshot-matches.json'), 'utf8'));
    expect(parse<MatchesPart>(text).matches.map(fromSnapshotMatch)).toEqual(meta.matches);
  });

  test('the players part matches the golden file', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    expect(textOf(texts, toc.parts.players.sha256)).toBe(readFileSync(resolve(FIXTURES, 'snapshot-players.json'), 'utf8'));
  });

  test('every part is named by the sha256 of its bytes and records its size', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    const refs = [toc.parts.players, ...Object.values(toc.parts.accounts), ...Object.values(toc.parts.kels), toc.parts.ids, ...Object.values(toc.parts.seasons)];
    for (const ref of refs) {
      const text = textOf(texts, ref.sha256);
      expect([sha256Hex(text), ref.size, ref.release]).toEqual([ref.sha256, new TextEncoder().encode(text).length, meta.release]);
    }
  });

  test('the state comes back from the parts', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    const back = stateFromParts(toc, {
      players: parse<PlayersPart>(textOf(texts, toc.parts.players.sha256)),
      seasons: { '1': parse<SeasonPart>(textOf(texts, toc.parts.seasons['1']!.sha256)) },
      accounts: Object.assign({}, ...Object.values(toc.parts.accounts).map((r) => parse(textOf(texts, r.sha256)))),
      kels: Object.assign({}, ...Object.values(toc.parts.kels).map((r) => parse(textOf(texts, r.sha256)))),
    });
    expect(back).toEqual(fixtureState);
  });

  test('without the accounts and kels parts, only the accounts of season players and past seasons come back, and no KEL', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    const back = stateFromParts(toc, {
      players: parse<PlayersPart>(textOf(texts, toc.parts.players.sha256)),
      seasons: { '1': parse<SeasonPart>(textOf(texts, toc.parts.seasons['1']!.sha256)) },
    });
    expect([Object.keys(back.accounts).sort(), back.kels]).toEqual([[A, C], {}]);
  });

  test('the result does not depend on the order of object keys', () => {
    const reordered: RatingState = {
      accounts: { [C]: fixtureState.accounts[C]!, [A]: fixtureState.accounts[A]! },
      kels: { [C]: fixtureState.kels[C]!, [B]: fixtureState.kels[B]!, [A]: fixtureState.kels[A]! },
      seasonSummaries: fixtureState.seasonSummaries,
      recentPairs: fixtureState.recentPairs,
      players: { [A]: fixtureState.players[A]!, [B]: fixtureState.players[B]! },
      cutoff: fixtureState.cutoff,
      season: 2,
    };
    expect(serializeToc(buildSnapshot(reordered, meta).toc)).toBe(serializeToc(buildSnapshot(fixtureState, meta).toc));
  });

  test('an unchanged part stays in the release where it was first put, and only new parts are returned', () => {
    const first = buildSnapshot(fixtureState, meta);
    const changed: RatingState = { ...fixtureState, cutoff: fixtureState.cutoff + 86400, players: { [A]: fixtureState.players[A]! } };
    const next = buildSnapshot(changed, { ...meta, release: 'later', prevToc: first.toc });
    expect([next.toc.parts.players.release, next.toc.parts.kels['a']!.release, next.toc.parts.accounts['a']!.release]).toEqual(['later', meta.release, meta.release]);
    expect(next.texts.has(next.toc.parts.players.sha256)).toBe(true);
    expect(next.texts.has(next.toc.parts.kels['a']!.sha256)).toBe(false);
  });

  test('a past season part is kept as it was, even when the account changed later', () => {
    const first = buildSnapshot(fixtureState, meta);
    const renamed: RatingState = { ...fixtureState, accounts: { ...fixtureState.accounts, [C]: { ...fixtureState.accounts[C]!, name: 'renamed' } } };
    const next = buildSnapshot(renamed, { ...meta, release: 'later', prevToc: first.toc });
    expect(next.toc.parts.seasons['1']).toEqual(first.toc.parts.seasons['1']);
    // 公開情報と KEL は aid の先頭1文字ごとの部品なので、変わった c の部品だけを置き直す
    expect([next.toc.parts.accounts['c']!.release, next.toc.parts.accounts['a']!.release]).toEqual(['later', meta.release]);
  });

  test('the players part gives the KEL of season players, and the index gives everyone else', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    const players = parse<PlayersPart>(textOf(texts, toc.parts.players.sha256));
    const files = publishedFiles(toc, {
      players: textOf(texts, toc.parts.players.sha256),
      seasons: { '1': textOf(texts, toc.parts.seasons['1']!.sha256) },
      kels: fixtureState.kels,
    });
    const part = (sha: string) => {
      const text = files.get(`snapshots/parts/${sha}.json`);
      expect(text === undefined ? null : sha256Hex(text)).toBe(sha);
      return parse<unknown>(text!);
    };
    expect(Object.keys(players.kels).sort()).toEqual([A, B]);
    expect(part(players.kels[A]!)).toEqual(fixtureState.kels[A]);
    const index = part(toc.kel_index.sha256) as KelIndexPart;
    const prefix = part(index[kelPrefix(C)]!.sha256) as KelPrefixPart;
    expect(part(prefix[C]!)).toEqual(fixtureState.kels[C]);
    expect(part(toc.parts.seasons['1']!.sha256)).toEqual(parse(textOf(texts, toc.parts.seasons['1']!.sha256)));
  });

  test('splits accounts and KELs into parts by the first character of the aid', () => {
    const { toc } = buildSnapshot(fixtureState, meta);
    expect([Object.keys(toc.parts.accounts), Object.keys(toc.parts.kels)]).toEqual([['a', 'c'], ['a', 'b', 'c']]);
  });

  test('a KEL that two games share is published at the same path for both', () => {
    const one = buildSnapshot(fixtureState, meta);
    const other = buildSnapshot({ ...fixtureState, kels: { [A]: fixtureState.kels[A]! } }, { ...meta, game: 'chess' });
    const files = (_game: string, b: typeof one, kels: KelRecords) =>
      publishedFiles(b.toc, { players: textOf(b.texts, b.toc.parts.players.sha256), seasons: { '1': textOf(b.texts, b.toc.parts.seasons['1']!.sha256) }, kels });
    const shaA = parse<PlayersPart>(textOf(one.texts, one.toc.parts.players.sha256)).kels[A]!;
    expect([files('smash_sp', one, fixtureState.kels).has(`snapshots/parts/${shaA}.json`), files('chess', other, { [A]: fixtureState.kels[A]! }).has(`snapshots/parts/${shaA}.json`)]).toEqual([true, true]);
  });

  test('publishing stops when the KELs do not give the index in the table of contents', () => {
    const { toc, texts } = buildSnapshot(fixtureState, meta);
    const bulk = { players: textOf(texts, toc.parts.players.sha256), seasons: { '1': textOf(texts, toc.parts.seasons['1']!.sha256) } };
    expect(() => publishedFiles(toc, { ...bulk, kels: { ...fixtureState.kels, [C]: fakeKel(A) } })).toThrow(
      'the KELs do not match kel_index in the table of contents',
    );
  });

  test('ratingConfigHash covers rating-relevant settings only', () => {
    const changedTau = { ...def, rating: { ...def.rating, tau: 0.6 } };
    const changedName = { ...def, name: { ja: '別の名前', en: 'Another name' } };
    expect(ratingConfigHash(changedTau)).not.toBe(ratingConfigHash(def));
    expect(ratingConfigHash(changedName)).toBe(ratingConfigHash(def));
  });

  test('sha256Hex and eventIdsHash', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(eventIdsHash(['b', 'a'])).toBe(sha256Hex('a\nb'));
  });
});
