import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { banGroupKey, currentSeason, parseGameDefinition, seasonById } from '../../src/game/definition.js';

const rawJson = JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/smash_sp.json'), 'utf8'));
const def = parseGameDefinition(rawJson);

describe('parseGameDefinition', () => {
  test('loads smash_sp', () => {
    expect(def.fighters).toHaveLength(86);
    expect(def.stages.starter).toEqual([
      'final_destination', 'battlefield', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city',
    ]);
    expect(def.stages.counterpick).toHaveLength(7);
    expect(def.matching.rangeChoices).toEqual([null, 50, 100, 150, 200]);
  });

  test('rejects starter stage not in all', () => {
    const bad = structuredClone(rawJson);
    bad.stages.starter.push('unknown_stage');
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: stages.starter[6] unknown stage unknown_stage');
  });

  test('rejects unknown fighter in sharedBanGroups', () => {
    const bad = structuredClone(rawJson);
    bad.sharedBanGroups.push(['mario', 'nobody']);
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: sharedBanGroups[3][1] unknown fighter nobody');
  });

  test('rejects duplicate fighter ids', () => {
    const bad = structuredClone(rawJson);
    bad.fighters.push({ id: 'mario', name: 'x' });
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: fighters has duplicate ids');
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
    expect(() => parseGameDefinition(bad)).toThrow('invalid game definition: format.bestOf must be odd');
  });

  test('room notes for the in-game room settings', () => {
    expect(def.room.entryRestriction).toBe('だれでも');
    expect(def.room.notes).toEqual([
      'ステージギミック: なし',
      'アイテム・スピリッツ・チャージ切り札: なし',
      '「終点」「戦場」は、終点化・戦場化したステージとしても選べます',
    ]);
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
