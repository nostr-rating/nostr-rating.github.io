import type { EventTemplate, NostrEvent, Pubkey } from '@nostr-rating/core';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { BunkerSigner, parseBunkerInput, type BunkerPointer } from 'nostr-tools/nip46';
import { generateSecretKey } from 'nostr-tools/pure';

/**
 * 端末の鍵として使う署名アプリ（docs/adr/0008「鍵の役割」）。鍵はアプリの外にあり、
 * このアプリは本文の digest を入れた kind 23753 のイベントへの署名を頼むだけ
 */
export type ExternalDevice = { kind: 'nip07' } | { kind: 'nip46'; clientSk: string; bunker: BunkerPointer };

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<NostrEvent>;
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

interface ExternalSigner {
  getPublicKey(): Promise<Pubkey>;
  signEvent(t: EventTemplate): Promise<NostrEvent>;
}

const bunkers = new Map<string, Promise<BunkerSigner>>();

export async function externalSigner(ext: ExternalDevice): Promise<ExternalSigner> {
  if (ext.kind === 'nip07') {
    const n = typeof window !== 'undefined' ? window.nostr : undefined;
    if (!n) throw new Error('ブラウザ拡張（NIP-07）が見つかりません');
    return { getPublicKey: () => n.getPublicKey(), signEvent: (t) => n.signEvent(t) };
  }
  let signer = bunkers.get(ext.clientSk);
  if (!signer) {
    signer = (async () => {
      const s = BunkerSigner.fromBunker(hexToBytes(ext.clientSk), ext.bunker);
      await s.connect();
      return s;
    })();
    bunkers.set(ext.clientSk, signer);
    signer.catch(() => bunkers.delete(ext.clientSk));
  }
  const s = await signer;
  return { getPublicKey: () => s.getPublicKey(), signEvent: (t) => s.signEvent(t) };
}

/** 署名アプリにつなぎ、その公開鍵を返す */
export async function connectExternal(input: { kind: 'nip07' } | { kind: 'nip46'; bunker: string }): Promise<{ ext: ExternalDevice; pubkey: Pubkey }> {
  let ext: ExternalDevice;
  if (input.kind === 'nip07') {
    ext = { kind: 'nip07' };
  } else {
    const bunker = await parseBunkerInput(input.bunker.trim());
    if (!bunker) throw new Error('bunker:// で始まる接続先を読み取れませんでした');
    ext = { kind: 'nip46', clientSk: bytesToHex(generateSecretKey()), bunker };
  }
  const signer = await externalSigner(ext);
  return { ext, pubkey: await signer.getPublicKey() };
}
