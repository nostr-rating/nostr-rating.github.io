import { generateSeedWords, privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06';
import { getPublicKey } from 'nostr-tools/pure';
import type { Pubkey } from '../types.js';

/** 復活の言葉（BIP-39 の12語）を新しく作る */
export function newRecoveryWords(): string {
  return generateSeedWords();
}

/** 空白や大文字の違いをならした12語。形が正しくなければ null */
export function normalizeRecoveryWords(input: string): string | null {
  const words = input.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12) return null;
  const joined = words.join(' ');
  return validateWords(joined) ? joined : null;
}

/** 12語から次の鍵（NIP-06 の最初のアカウント）を作る */
export function recoveryKey(words: string): { sk: Uint8Array; pub: Pubkey } {
  const normalized = normalizeRecoveryWords(words);
  if (!normalized) throw new Error('invalid recovery words');
  const sk = privateKeyFromSeedWords(normalized);
  return { sk, pub: getPublicKey(sk) };
}
