import { describe, expect, test } from 'vitest';
import { bansAgainst, counterpickStages, game1Stages, validateStageBans } from '../../src/match/stages.js';
import { def } from '../helpers/def.js';

describe('game1Stages', () => {
  test('excludes both players bans against the opponent fighter', () => {
    const r = game1Stages(def, {
      p1Fighter: 'mario',
      p2Fighter: 'daisy',
      p1Bans: { peach: ['final_destination', 'town_and_city'] },
      p2Bans: { mario: ['battlefield'] },
    });
    expect(r).toEqual(['pokemon_stadium_2', 'small_battlefield', 'hollow_bastion']);
  });

  test('never offers smashville', () => {
    expect(game1Stages(def, { p1Fighter: 'mario', p2Fighter: 'fox', p1Bans: {}, p2Bans: {} })).toEqual([
      'final_destination', 'battlefield', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city',
    ]);
  });
});

describe('counterpickStages', () => {
  test('applies only winner bans against loser fighter, smashville allowed', () => {
    expect(
      counterpickStages(def, { winnerBans: { mario: ['smashville', 'battlefield'] }, loserFighter: 'mario' }),
    ).toEqual(['final_destination', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city']);
  });

  test('uses shared ban group of loser fighter', () => {
    expect(counterpickStages(def, { winnerBans: { samus: ['smashville'] }, loserFighter: 'dark_samus' })).toEqual([
      'final_destination', 'battlefield', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city',
    ]);
  });
});

describe('bansAgainst', () => {
  test('returns empty when not configured', () => {
    expect(bansAgainst(def, {}, 'mario')).toEqual([]);
  });

  test('ignores unknown stages and bans beyond the limit from a hostile opponent', () => {
    const hostile = { mario: ['moon', 'final_destination', 'battlefield', 'smashville', 'town_and_city'] } as never;
    expect(bansAgainst(def, hostile, 'mario')).toEqual(['final_destination', 'battlefield']);
  });
});

describe('validateStageBans', () => {
  test('accepts up to two counterpick stages', () => {
    expect(validateStageBans(def, { mario: ['smashville', 'battlefield'] })).toEqual([]);
  });

  test('rejects three bans, unknown stage, unknown fighter and non-group key', () => {
    expect(
      validateStageBans(def, {
        mario: ['smashville', 'battlefield', 'final_destination'],
        fox: ['moon' as never],
        nobody: ['battlefield'],
        daisy: ['battlefield'],
      }),
    ).toEqual([
      'mario: 拒否ステージは2つまでです',
      'fox: 不明なステージ moon',
      'nobody: 不明なファイター',
      'daisy: peach として設定してください',
    ]);
  });

  test('rejects duplicate stage', () => {
    expect(validateStageBans(def, { mario: ['battlefield', 'battlefield'] })).toEqual(['mario: 同じステージが重複しています']);
  });
});
