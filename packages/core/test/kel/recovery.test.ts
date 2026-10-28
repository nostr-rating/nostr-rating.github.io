import { describe, expect, it } from 'vitest';
import { newRecoveryWords, normalizeRecoveryWords, recoveryKey } from '../../src/kel/recovery.js';

// NIP-06 の仕様にあるテストベクトル
const WORDS = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const PUB = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

describe('recovery words', () => {
  it('derives the NIP-06 key and ignores spacing and case', () => {
    expect(recoveryKey(WORDS).pub).toBe(PUB);
    expect(recoveryKey(`  ${WORDS.toUpperCase().replace(/ /g, '\n')} `).pub).toBe(PUB);
  });

  it('rejects wrong words and wrong counts', () => {
    expect(normalizeRecoveryWords(WORDS.replace('bean', 'beans'))).toBeNull();
    expect(normalizeRecoveryWords(WORDS.split(' ').slice(0, 11).join(' '))).toBeNull();
    expect(() => recoveryKey('a b c')).toThrow();
  });

  it('creates fresh 12-word phrases', () => {
    const w = newRecoveryWords();
    expect(w.split(' ')).toHaveLength(12);
    expect(normalizeRecoveryWords(w)).toBe(w);
  });
});
