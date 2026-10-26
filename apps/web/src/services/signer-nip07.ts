import type { EventTemplate, NostrEvent, Pubkey, Signer } from '@nostr-rating/core';

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<NostrEvent>;
  nip44?: { encrypt(peer: string, text: string): Promise<string>; decrypt(peer: string, cipher: string): Promise<string> };
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

/** ブラウザ拡張（NIP-07）に署名を任せる。鍵はアプリに渡らない */
export function nip07Signer(): Signer | null {
  const n = typeof window !== 'undefined' ? window.nostr : undefined;
  if (!n) return null;
  const nip44 = () => {
    if (!n.nip44) throw new Error('この拡張機能は NIP-44 の暗号化に対応していません');
    return n.nip44;
  };
  return {
    getPublicKey: () => n.getPublicKey() as Promise<Pubkey>,
    signEvent: (t) => n.signEvent(t),
    nip44Encrypt: (peer, text) => nip44().encrypt(peer, text),
    nip44Decrypt: (peer, cipher) => nip44().decrypt(peer, cipher),
  };
}
