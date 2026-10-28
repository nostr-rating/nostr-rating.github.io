import type { GameDefinition } from '../../src/game/definition.js';
import type { NostrEvent } from 'nostr-tools/pure';
import { attributor, buildKelBook } from '../../src/kel/book.js';
import { initialState as realInitialState, type RatingState } from '../../src/rating/pipeline.js';
import { registeredKels } from './keys.js';

/** テスト用。作ったアカウントの KEL を記録済みとして入れた初期状態 */
export function initialState(def: GameDefinition, season: number, cutoff: number, summaries: RatingState['seasonSummaries'] = {}): RatingState {
  return realInitialState(def, season, cutoff, summaries, registeredKels(), {});
}

/** テスト用。作ったアカウントの KEL で、イベントを aid に結び付ける */
export function authorOf(ev: NostrEvent): string | null {
  return attributor(buildKelBook(registeredKels(), [], -Infinity, Infinity).states)(ev);
}
