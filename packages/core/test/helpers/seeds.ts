import { seedCommit } from '../../src/match/seat.js';

/** テストの対戦で使う、先後を決める乱数（docs/adr/0013） */
export const P1_SEED = '1'.repeat(64);
export const P2_SEED = '2'.repeat(64);
export const SEED_HASH = seedCommit(P1_SEED);
