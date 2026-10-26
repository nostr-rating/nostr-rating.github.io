import { describe, expect, test } from 'vitest';
import { changeFighter, initialSet, nextStageOptions, recordGame, setWinner, undoGame } from '../../src/match/bo3.js';
import { def } from '../helpers/def.js';

const starter = ['final_destination', 'battlefield', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city'];

describe('BO3 set', () => {
  test('game 1 picker is both and uses game1 rules', () => {
    const s = initialSet('mario', 'fox');
    expect(nextStageOptions(def, s, { p1: { fox: ['battlefield'] }, p2: {} })).toEqual({
      picker: 'both',
      stages: ['final_destination', 'pokemon_stadium_2', 'small_battlefield', 'hollow_bastion', 'town_and_city'],
    });
  });

  test('only the previous loser may change fighter', () => {
    let s = recordGame(def, initialSet('mario', 'fox'), 'p1');
    expect(() => changeFighter(def, s, 'p1', 'luigi')).toThrow('only the previous loser may change fighter');
    s = changeFighter(def, s, 'p2', 'falco');
    expect(s.p2Fighter).toBe('falco');
    expect(nextStageOptions(def, s, { p1: { falco: ['smashville'] }, p2: {} })).toEqual({
      picker: 'p2',
      stages: starter,
    });
  });

  test('no fighter change after the set is decided or to an unknown fighter', () => {
    let s = recordGame(def, initialSet('mario', 'fox'), 'p1');
    expect(() => changeFighter(def, s, 'p2', 'nobody')).toThrow('unknown fighter nobody');
    s = recordGame(def, s, 'p1');
    expect(() => changeFighter(def, s, 'p2', 'falco')).toThrow('set is already decided');
  });

  test('undoGame removes the last game and restores the fighters used in it', () => {
    let s = recordGame(def, initialSet('mario', 'fox'), 'p1');
    s = changeFighter(def, s, 'p2', 'falco');
    s = recordGame(def, s, 'p1');
    expect(undoGame(s)).toEqual({ games: [{ winner: 'p1', p1Fighter: 'mario', p2Fighter: 'fox' }], p1Fighter: 'mario', p2Fighter: 'falco' });
    expect(undoGame(undoGame(s))).toEqual(initialSet('mario', 'fox'));
    expect(undoGame(initialSet('mario', 'fox'))).toEqual(initialSet('mario', 'fox'));
  });

  test('no fighter change before game 1', () => {
    expect(() => changeFighter(def, initialSet('mario', 'fox'), 'p1', 'luigi')).toThrow('only the previous loser may change fighter');
  });

  test('records fighters used in each game', () => {
    const s = recordGame(def, initialSet('mario', 'fox'), 'p2');
    expect(s.games).toEqual([{ winner: 'p2', p1Fighter: 'mario', p2Fighter: 'fox' }]);
  });

  test('set ends at 2 wins and further games are rejected', () => {
    let s = initialSet('mario', 'fox');
    s = recordGame(def, s, 'p1');
    expect(setWinner(def, s)).toBeNull();
    s = recordGame(def, s, 'p2');
    expect(setWinner(def, s)).toBeNull();
    s = recordGame(def, s, 'p2');
    expect(setWinner(def, s)).toBe('p2');
    expect(() => recordGame(def, s, 'p1')).toThrow('set is already decided');
  });
});
