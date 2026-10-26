import type { GameDefinition } from '../game/definition.js';
import type { Pubkey } from '../types.js';

/** マッチ判定に使う、ある待機者の条件。レートとマナーは判定する側のクライアントが計算した値 */
export interface SeekerView {
  pubkey: Pubkey;
  rating: number;
  rangeChoice: number | null;
  rematchHours: number;
  waitingSince: number;
  mannersTotal: number;
}

/** 手元のレート計算結果から、マッチ判定に必要な値を引くための窓口 */
export interface LocalView {
  ratingOf(pk: Pubkey): number;
  mannersTotalOf(pk: Pubkey): number;
  lastMatchBetween(a: Pubkey, b: Pubkey): number | null;
  /** NIP-39 の主張が手元で確認できている（レート戦の参加条件） */
  hasIdentity(pk: Pubkey): boolean;
}

/** 「制限なし」は unlimitedStart から待機1分ごとに広がる */
export function allowedRange(def: GameDefinition, v: SeekerView, now: number): number {
  if (v.rangeChoice !== null) return v.rangeChoice;
  const minutes = Math.floor(Math.max(0, now - v.waitingSince) / 60);
  return def.matching.unlimitedStart + def.matching.unlimitedExpandPerMinute * minutes;
}

export function canMatch(
  def: GameDefinition,
  a: SeekerView,
  b: SeekerView,
  now: number,
  lastMatchBetween: number | null,
): boolean {
  if (a.pubkey === b.pubkey) return false;
  const range = Math.min(allowedRange(def, a, now), allowedRange(def, b, now));
  if (Math.abs(a.rating - b.rating) > range) return false;
  const rematchSec = Math.max(a.rematchHours, b.rematchHours) * 3600;
  if (rematchSec > 0 && lastMatchBetween !== null && now - lastMatchBetween < rematchSec) return false;
  return Math.abs(a.mannersTotal - b.mannersTotal) <= def.matching.mannersMaxDiff;
}
