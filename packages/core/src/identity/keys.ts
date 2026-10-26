import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey as genSk } from 'nostr-tools/pure';
import type { Pubkey } from '../types.js';

export function generateSecretKey(): Uint8Array {
  return genSk();
}

export function encodeNsec(sk: Uint8Array): string {
  return nip19.nsecEncode(sk);
}

export function decodeNsec(s: string): Uint8Array {
  const decoded = nip19.decode(s.trim());
  if (decoded.type !== 'nsec') throw new Error('nsec ではありません');
  return decoded.data;
}

export function npubOf(pubkey: Pubkey): string {
  return nip19.npubEncode(pubkey);
}
