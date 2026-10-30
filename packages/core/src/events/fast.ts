import { getEventHash, type NostrEvent } from 'nostr-tools/pure';

/** nostr-wasm（libsecp256k1）。読み込むまでは null で、そのあいだは nostr-tools の検証を使う */
let wasm: { verifyEvent(ev: NostrEvent): void } | null = null;
let loading: Promise<void> | null = null;

/**
 * Nostr のイベントの署名を、速い実装（WebAssembly）で確かめられるようにする（docs/adr/0011）。
 * 読み込めなかったときは、これまでどおり nostr-tools で確かめる
 */
export function initFastVerify(): Promise<void> {
  loading ??= import('nostr-wasm')
    .then(async (m) => {
      wasm = await m.initNostrWasm();
    })
    .catch((e: unknown) => {
      console.warn('fast signature verification is unavailable', e);
    });
  return loading;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** id が中身と合い、署名が正しいか。速い実装をまだ読み込んでいなければ null */
export function fastVerifyEvent(e: NostrEvent): boolean | null {
  if (!wasm) return null;
  try {
    // nostr-wasm は渡された値の長さの分しか読まないので、鍵と署名の形と、id が中身のハッシュそのものかを先に確かめる
    if (!HEX64.test(e.pubkey) || !HEX128.test(e.sig) || getEventHash(e) !== e.id) return false;
    wasm.verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
    return true;
  } catch {
    return false;
  }
}
