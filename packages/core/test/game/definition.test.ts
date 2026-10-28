import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { banGroupKey, currentSeason, parseGameDefinition, seasonById, sideOf } from '../../src/game/definition.js';

const rawJson = JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/smash_sp.json'), 'utf8'));
const def = parseGameDefinition(rawJson);
const chessJson = JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/chess.json'), 'utf8'));
const games = JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/games.json'), 'utf8')) as { games: string[] };

describe('parseGameDefinition', () => {
  test('loads smash_sp', () => {
    expect(def.characters!.list).toHaveLength(86);
    expect([def.sides, def.results.draw, def.room.kind, def.format]).toEqual([['P1', 'P2'], false, 'code', { bestOf: 3, notes: ['ストック3', '制限時間7分'] }]);
    expect(def.stages!.starter).toEqual([
      'final_destination', 'battlefield', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city',
    ]);
    expect(def.stages!.counterpick).toHaveLength(7);
    expect(def.matching.rangeChoices).toEqual([null, 50, 100, 150, 200]);
  });

  test('rejects starter stage not in all', () => {
    const bad = structuredClone(rawJson);
    bad.stages.starter.push('unknown_stage');
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: stages.starter[6] unknown stage unknown_stage');
  });

  test('rejects unknown character in sharedBanGroups', () => {
    const bad = structuredClone(rawJson);
    bad.characters.sharedBanGroups.push(['mario', 'nobody']);
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: characters.sharedBanGroups[3][1] unknown character nobody');
  });

  test('rejects duplicate character ids', () => {
    const bad = structuredClone(rawJson);
    bad.characters.list.push({ id: 'mario', name: 'x' });
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: characters.list has duplicate ids');
  });

  test('rejects stages without characters', () => {
    const bad = structuredClone(rawJson);
    delete bad.characters;
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: stages needs characters');
  });

  test('rejects missing rating section', () => {
    const bad = structuredClone(rawJson);
    delete bad.rating;
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: rating must be an object');
  });

  test('rejects starter stage that is not a counterpick stage', () => {
    const bad = structuredClone(rawJson);
    bad.stages.counterpick = bad.stages.counterpick.filter((s: string) => s !== 'battlefield');
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: stages.starter battlefield must also be a counterpick stage');
  });

  test('rejects even bestOf', () => {
    const bad = structuredClone(rawJson);
    bad.format.bestOf = 4;
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: format.bestOf must be a positive odd integer');
  });

  test('room password digits', () => {
    expect(def.room.kind === 'code' && def.room.password).toEqual({ minDigits: 4, maxDigits: 8, generatedDigits: 4 });
  });

  test('rejects generated password digits outside the allowed range', () => {
    const bad = structuredClone(rawJson);
    bad.room.password.generatedDigits = 9;
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: room.password.generatedDigits must be between minDigits and maxDigits');
  });

  test('room notes for the in-game room settings', () => {
    expect(def.room.kind === 'code' && def.room.entryRestriction).toBe('だれでも');
    expect(def.room.notes).toEqual([
      'ステージギミック: なし',
      'アイテム・スピリッツ・チャージ切り札: なし',
      '「終点」「戦場」は、終点化・戦場化したステージとしても選べます',
    ]);
  });
});

describe('chess and the list of games', () => {
  test('loads chess without characters or stages, with draws, sides and invite links', () => {
    const chess = parseGameDefinition(chessJson);
    expect([chess.id, chess.characters, chess.stages, chess.results.draw, chess.sides, chess.room.kind, chess.format.bestOf]).toEqual([
      'chess', null, null, true, ['白', '黒'], 'link', 1,
    ]);
  });

  test('every listed game parses', () => {
    expect(games.games).toEqual(['smash_sp', 'chess']);
    for (const id of games.games) {
      const d = parseGameDefinition(JSON.parse(readFileSync(resolve(__dirname, `../../../../configs/${id}.json`), 'utf8')));
      expect(d.id).toBe(id);
    }
  });

  test('rejects ids that cannot be a folder name', () => {
    const bad = structuredClone(chessJson);
    bad.id = '../x';
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: id must be lowercase letters, digits and _');
  });
});

describe('sideOf', () => {
  test('the last hex digit of the match id decides who takes the first side', () => {
    expect([sideOf('a'.repeat(63) + '0', 'p1'), sideOf('a'.repeat(63) + '0', 'p2')]).toEqual([0, 1]);
    expect([sideOf('a'.repeat(63) + 'f', 'p1'), sideOf('a'.repeat(63) + 'f', 'p2')]).toEqual([1, 0]);
    expect(sideOf('a'.repeat(63) + 'e', 'p1')).toBe(0);
  });
});

describe('banGroupKey', () => {
  test('maps echo pairs to the first member', () => {
    expect(banGroupKey(def, 'daisy')).toBe('peach');
    expect(banGroupKey(def, 'peach')).toBe('peach');
    expect(banGroupKey(def, 'richter')).toBe('simon');
    expect(banGroupKey(def, 'mario')).toBe('mario');
  });
});

describe('seasons', () => {
  // 2026-10-01 00:00 JST から3か月ごと
  test('season 1 is 2026-10-01 to 2027-01-01 JST', () => {
    expect(seasonById(def, 1)).toEqual({ id: 1, startsAt: 1790780400, endsAt: 1798729200 });
  });

  test('later seasons follow calendar months without any list to update', () => {
    expect(seasonById(def, 2)).toEqual({ id: 2, startsAt: 1798729200, endsAt: 1806505200 }); // 2027-01-01 → 2027-04-01
    expect(seasonById(def, 5)).toEqual({ id: 5, startsAt: 1822316400, endsAt: 1830265200 }); // 2027-10-01 → 2028-01-01
  });

  test('currentSeason includes startsAt and excludes endsAt', () => {
    expect(currentSeason(def, 1790780400)?.id).toBe(1);
    expect(currentSeason(def, 1798729199)?.id).toBe(1);
    expect(currentSeason(def, 1798729200)?.id).toBe(2);
    expect(currentSeason(def, 1790780399)).toBeNull();
    expect(currentSeason(def, 2_000_000_000)?.id).toBe(27); // 2033-05-18 JST
  });

  test('rejects a season definition whose start day may not exist in every month', () => {
    const bad = structuredClone(rawJson);
    bad.seasons.firstStartsAt = 1793372400; // 2026-10-31 00:00 JST
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: seasons.firstStartsAt must be on day 1-28 of the month');
  });
});
