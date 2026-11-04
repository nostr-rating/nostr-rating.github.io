import { banGroupKey, type GameDefinition } from '../game/definition.js';
import type { FighterId, StageId } from '../types.js';

/** 相手のファイター（banGroupKey で正規化）→ 拒否するステージ */
export type StageBans = Record<FighterId, StageId[]>;

/** ステージのあるゲームの定義から、ステージの決まりを取り出す（ないゲームで呼ぶのは誤り） */
function stagesOf(def: GameDefinition): NonNullable<GameDefinition['stages']> {
  if (!def.stages) throw new Error(`${def.id} has no stages`);
  return def.stages;
}

/** 拒否ステージの設定の誤り。表示の文言は画面の側で言語ごとに作る */
export type StageBanError =
  | { code: 'no_stages' }
  | { code: 'unknown_fighter'; fighter: FighterId }
  | { code: 'use_group_key'; fighter: FighterId; key: FighterId }
  | { code: 'too_many'; fighter: FighterId; max: number }
  | { code: 'unknown_stage'; fighter: FighterId; stage: string }
  | { code: 'duplicate_stage'; fighter: FighterId };

export function validateStageBans(def: GameDefinition, bans: StageBans): StageBanError[] {
  const errors: StageBanError[] = [];
  if (!def.stages || !def.characters) return Object.keys(bans).length === 0 ? [] : [{ code: 'no_stages' }];
  const fighterIds = new Set(def.characters.list.map((f) => f.id));
  const allowed = new Set<string>(def.stages.counterpick);
  for (const [fighter, stages] of Object.entries(bans)) {
    if (!fighterIds.has(fighter)) {
      errors.push({ code: 'unknown_fighter', fighter });
      continue;
    }
    const key = banGroupKey(def, fighter);
    if (key !== fighter) {
      errors.push({ code: 'use_group_key', fighter, key });
      continue;
    }
    if (stages.length > def.stages.maxBansPerFighter) {
      errors.push({ code: 'too_many', fighter, max: def.stages.maxBansPerFighter });
      continue;
    }
    const unknown = stages.find((s) => !allowed.has(s));
    if (unknown !== undefined) {
      errors.push({ code: 'unknown_stage', fighter, stage: unknown });
      continue;
    }
    if (new Set(stages).size !== stages.length) errors.push({ code: 'duplicate_stage', fighter });
  }
  return errors;
}

/** 相手の改造クライアントが上限を超えて拒否しても、既知のステージを先頭から上限数までしか効かせない */
export function bansAgainst(def: GameDefinition, bans: StageBans, opponentFighter: FighterId): StageId[] {
  if (!def.stages) return [];
  const raw = bans[banGroupKey(def, opponentFighter)];
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(def.stages.counterpick);
  return [...new Set(raw.filter((s) => known.has(s)))].slice(0, def.stages.maxBansPerFighter);
}

function inStageOrder(def: GameDefinition, pool: readonly StageId[], excluded: readonly StageId[]): StageId[] {
  return stagesOf(def).all.map((s) => s.id).filter((id) => pool.includes(id) && !excluded.includes(id));
}

/** 1戦目: 双方が相手の1戦目のキャラに対して設定した拒否ステージを除く */
export function game1Stages(
  def: GameDefinition,
  p: { p1Fighter: FighterId; p2Fighter: FighterId; p1Bans: StageBans; p2Bans: StageBans },
): StageId[] {
  return inStageOrder(def, stagesOf(def).starter, [
    ...bansAgainst(def, p.p1Bans, p.p2Fighter),
    ...bansAgainst(def, p.p2Bans, p.p1Fighter),
  ]);
}

/** 2戦目以降: 勝者が敗者のキャラに対して設定した拒否ステージだけを除く */
export function counterpickStages(
  def: GameDefinition,
  p: { winnerBans: StageBans; loserFighter: FighterId },
): StageId[] {
  return inStageOrder(def, stagesOf(def).counterpick, bansAgainst(def, p.winnerBans, p.loserFighter));
}
