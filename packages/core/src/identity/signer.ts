import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import type { Pubkey } from '../types.js';

export type { EventTemplate, NostrEvent };

/** アプリ内鍵・NIP-07・NIP-46 を同じ形で扱うための署名インターフェース */
export interface Signer {
  getPublicKey(): Promise<Pubkey>;
  signEvent(t: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peer: Pubkey, text: string): Promise<string>;
  nip44Decrypt(peer: Pubkey, cipher: string): Promise<string>;
}

export class LocalSigner implements Signer {
  readonly #sk: Uint8Array;
  readonly #pk: Pubkey;

  constructor(sk: Uint8Array) {
    this.#sk = sk;
    this.#pk = getPublicKey(sk);
  }

  async getPublicKey(): Promise<Pubkey> {
    return this.#pk;
  }

  async signEvent(t: EventTemplate): Promise<NostrEvent> {
    return finalizeEvent(t, this.#sk);
  }

  async nip44Encrypt(peer: Pubkey, text: string): Promise<string> {
    return nip44.encrypt(text, nip44.getConversationKey(this.#sk, peer));
  }

  async nip44Decrypt(peer: Pubkey, cipher: string): Promise<string> {
    return nip44.decrypt(cipher, nip44.getConversationKey(this.#sk, peer));
  }
}
