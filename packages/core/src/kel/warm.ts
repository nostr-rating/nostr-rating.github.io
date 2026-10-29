import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'nostr-tools/pure';
import { KIND } from '../events/kinds.js';
import type { KelRecords } from './book.js';
import { certOf } from './cert.js';
import { parseKelEvent } from './event.js';
import { digestOf, isCheckedKeySig, rememberKeySig, type DeviceRecord, type KelSig, type KeyRef } from './kel.js';

const keys = new Map<string, Promise<CryptoKey | null>>();

function importP256(pub: string): Promise<CryptoKey | null> {
  let k = keys.get(pub);
  if (!k) {
    k = crypto.subtle.importKey('raw', hexToBytes(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null);
    keys.set(pub, k);
  }
  return k;
}

/**
 * 指定したアカウントの KEL と証明書の P-256 の署名を、WebCrypto で前もって確かめ、結果を控えに入れる（docs/adr/0011）。
 * KEL の評価は同期で行うので、そこで遅い実装を使わずに済むようにする。結果は控えに入れるだけなので、
 * ここで確かめられなかった署名は、評価のときにこれまでどおり確かめる
 */
export async function warmKelSignatures(records: KelRecords, aids: Iterable<string>, events: NostrEvent[] = []): Promise<void> {
  if (!globalThis.crypto?.subtle) return;
  const want = new Set(aids);
  const fresh = new Map<string, { body: unknown; sigs: KelSig[]; devices: DeviceRecord[] }[]>();
  for (const ev of events) {
    const parsed = ev.kind === KIND.kel ? parseKelEvent(ev) : null;
    if (!parsed || !want.has(parsed.aid)) continue;
    const b = parsed.input.entry.body;
    fresh.set(parsed.aid, [...(fresh.get(parsed.aid) ?? []), { body: b, sigs: parsed.input.entry.sigs, devices: b.t === 'ixn' ? b.add : b.devices }]);
  }
  const devices = new Map<string, Map<string, KeyRef>>();
  const tasks: { key: KeyRef; digest: string; sig: KelSig }[] = [];
  for (const aid of want) {
    const entries = [
      ...(records[aid] ?? []).map(({ entry }) => ({ body: entry.body as unknown, sigs: entry.sigs, devices: entry.body.t === 'ixn' ? entry.body.add : entry.body.devices })),
      ...(fresh.get(aid) ?? []),
    ];
    const byId = new Map<string, KeyRef>();
    for (const e of entries) for (const d of Array.isArray(e.devices) ? e.devices : []) if (d?.key?.type === 'p256') byId.set(d.id, d.key);
    devices.set(aid, byId);
    for (const e of entries) {
      const p256Sigs = Array.isArray(e.sigs) ? e.sigs.filter((s) => 'p256' in s) : [];
      if (p256Sigs.length === 0) continue;
      const digest = digestOf(e.body);
      for (const sig of p256Sigs) {
        const key = byId.get(sig.signer);
        if (key && !isCheckedKeySig(key, digest, sig)) tasks.push({ key, digest, sig });
      }
    }
  }
  for (const ev of events) {
    const c = certOf(ev);
    const key = c && 'p256' in c.sig ? devices.get(c.cert.aid)?.get(c.sig.signer) : undefined;
    if (c && key && !isCheckedKeySig(key, digestOf(c.cert), c.sig)) tasks.push({ key, digest: digestOf(c.cert), sig: c.sig });
  }
  await Promise.all(
    tasks.map(async ({ key, digest, sig }) => {
      if (!('p256' in sig) || !/^[0-9a-f]{128}$/.test(sig.p256)) return;
      const k = await importP256(key.pub);
      if (!k) return;
      try {
        const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, hexToBytes(sig.p256), hexToBytes(digest));
        rememberKeySig(key, digest, sig, ok);
      } catch {
        // 確かめられなかったものは、評価のときに確かめる
      }
    }),
  );
}

/** イベントに出てくるアカウント（KEL のイベントの aid と、持ち歩く証明書の aid） */
export function aidsIn(events: NostrEvent[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    const aid = ev.kind === KIND.kel ? ev.tags.find((t) => t[0] === 'aid')?.[1] : certOf(ev)?.cert.aid;
    if (typeof aid === 'string') out.add(aid);
  }
  return out;
}
