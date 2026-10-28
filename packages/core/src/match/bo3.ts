import type { GameDefinition } from '../game/definition.js';
import type { FighterId, StageId } from '../types.js';
import { counterpickStages, game1Stages, type StageBans } from './stages.js';

export type Side = 'p1' | 'p2';

export interface SetState {
  games: { winner: Side; p1Fighter: FighterId; p2Fighter: FighterId }[];
  p1Fighter: FighterId;
  p2Fighter: FighterId;
}

const other = (s: Side): Side => (s === 'p1' ? 'p2' : 'p1');

export function initialSet(p1Fighter: FighterId, p2Fighter: FighterId): SetState {
  return { games: [], p1Fighter, p2Fighter };
}

export function setWinner(def: GameDefinition, s: SetState): Side | null {
  const need = Math.ceil(def.format.bestOf / 2);
  for (const side of ['p1', 'p2'] as const) {
    if (s.games.filter((g) => g.winner === side).length >= need) return side;
  }
  return null;
}

export function recordGame(def: GameDefinition, s: SetState, winner: Side): SetState {
  if (setWinner(def, s) !== null) throw new Error('set is already decided');
  return { ...s, games: [...s.games, { winner, p1Fighter: s.p1Fighter, p2Fighter: s.p2Fighter }] };
}

/** 押し間違えた試合の記録を1つ取り消す。キャラはその試合で使っていたものに戻す */
export function undoGame(s: SetState): SetState {
  const last = s.games.at(-1);
  if (!last) return s;
  const games = s.games.slice(0, -1);
  return { games, p1Fighter: last.p1Fighter, p2Fighter: last.p2Fighter };
}

export function changeFighter(def: GameDefinition, s: SetState, side: Side, fighter: FighterId): SetState {
  if (setWinner(def, s) !== null) throw new Error('set is already decided');
  if (!def.characters?.list.some((f) => f.id === fighter)) throw new Error(`unknown fighter ${fighter}`);
  const last = s.games.at(-1);
  if (last === undefined || last.winner === side) throw new Error('only the previous loser may change fighter');
  return side === 'p1' ? { ...s, p1Fighter: fighter } : { ...s, p2Fighter: fighter };
}

export function nextStageOptions(
  def: GameDefinition,
  s: SetState,
  bans: { p1: StageBans; p2: StageBans },
): { picker: 'both' | Side; stages: StageId[] } {
  const last = s.games.at(-1);
  if (last === undefined) {
    return {
      picker: 'both',
      stages: game1Stages(def, { p1Fighter: s.p1Fighter, p2Fighter: s.p2Fighter, p1Bans: bans.p1, p2Bans: bans.p2 }),
    };
  }
  const loser = other(last.winner);
  return {
    picker: loser,
    stages: counterpickStages(def, {
      winnerBans: bans[last.winner],
      loserFighter: loser === 'p1' ? s.p1Fighter : s.p2Fighter,
    }),
  };
}
