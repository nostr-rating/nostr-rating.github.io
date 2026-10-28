import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { KIND } from '../events/kinds.js';
import type { RelayClient } from '../relay/client.js';
import type { Pubkey } from '../types.js';
import { kelEventTemplate, parseKelEvent, seenOrder } from './event.js';
import {
  attestationTemplate,
  deviceId,
  DEVICE_LIFETIME_SEC,
  digestOf,
  evaluateKel,
  type DeviceRecord,
  type KelEntry,
  type KelInput,
  type KelState,
  type KeyRef,
  type NextKeys,
  type RotBody,
} from './kel.js';

/** 新しい端末が表示する「端末の申請」（QR コードと文字列） */
export interface DeviceRequest {
  key: KeyRef;
  publisher: Pubkey;
  label: string;
}

const REQUEST_PREFIX = 'nr-device:';

export function encodeDeviceRequest(r: DeviceRequest): string {
  // 端末の名前は日本語なので、UTF-8 のバイト列にしてから base64url にする
  const bytes = new TextEncoder().encode(JSON.stringify(r));
  return REQUEST_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeDeviceRequest(code: string): DeviceRequest | null {
  const s = code.trim();
  if (!s.startsWith(REQUEST_PREFIX)) return null;
  try {
    const b64 = s.slice(REQUEST_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as DeviceRequest;
    if (!v?.key || typeof v.key.pub !== 'string' || (v.key.type !== 'p256' && v.key.type !== 'schnorr')) return null;
    if (typeof v.publisher !== 'string' || !/^[0-9a-f]{64}$/.test(v.publisher) || typeof v.label !== 'string') return null;
    return { key: v.key, publisher: v.publisher, label: v.label.slice(0, 64) };
  } catch {
    return null;
  }
}

export function deviceRecordFor(r: DeviceRequest, at: number): DeviceRecord {
  return { id: deviceId(r.key), key: r.key, publisher: r.publisher, label: r.label, expiresAt: at + DEVICE_LIFETIME_SEC };
}

/** アカウントの KEL をリレーから集めて評価する（x タグと、分かった鍵の持ち主から） */
export async function loadKel(relay: RelayClient, aid: string): Promise<{ state: KelState | null; chain: KelInput[] }> {
  const holders = (s: KelState | null) => (s ? [...new Set([...s.next.keys, ...[...s.devices.values()].map((d) => d.record.publisher)])] : []);
  const evaluate = (events: NostrEvent[]) => {
    const inputs = seenOrder(events)
      .map((e) => parseKelEvent(e))
      .filter((p) => p !== null && p.aid === aid)
      .map((p) => p!.input);
    const state = evaluateKel(aid, inputs);
    const byDigest = new Map(inputs.map((i) => [digestOf(i.entry.body), i] as const));
    return { state, chain: state ? state.digests.map((d) => byDigest.get(d)!) : [] };
  };
  let events = await relay.query([{ kinds: [KIND.kel], '#x': [aid] }]);
  let result = evaluate(events);
  // 鍵の持ち主が分かったら、その分も取り直す（x タグはだれでも付けられるので、それだけに頼らない）
  for (let i = 0; i < 2 && result.state; i++) {
    const more = await relay.query([{ kinds: [KIND.kel], authors: holders(result.state) }]);
    events = [...events, ...more];
    result = evaluate(events);
  }
  return result;
}

/** 復活の言葉の公開鍵から、それを次の鍵に持つアカウントを探す（n タグ） */
export async function findAccountsByNextKeys(relay: RelayClient, pubs: Pubkey[]): Promise<string[]> {
  const events = await relay.query([{ kinds: [KIND.kel], '#n': pubs }]);
  return [...new Set(events.map((e) => parseKelEvent(e)?.aid).filter((a): a is string => typeof a === 'string'))];
}

/**
 * 次の鍵で入れ替えのイベント（rot）を作って署名する。devices は新しい端末だけになり、
 * それ以外の端末はすべて取り消される。next は新しい復活の言葉の公開鍵。
 */
export function recoveryRotation(
  state: KelState,
  devices: DeviceRecord[],
  next: NextKeys,
  signers: Uint8Array[],
  at: number,
  notify: Pubkey[] = [],
): { entry: KelEntry; event: NostrEvent } {
  const pubs = signers.map((sk) => getPublicKey(sk));
  if (pubs.filter((p) => state.next.keys.includes(p)).length < state.next.threshold) {
    throw new Error('この復活の言葉では入れ替えられません（もう使えない言葉か、別のアカウントの言葉です）');
  }
  const body: RotBody = { v: 1, t: 'rot', aid: state.aid, sn: state.sn + 1, prior: state.tip, devices, next };
  const digest = digestOf(body);
  const sigs = signers
    .filter((sk) => state.next.keys.includes(getPublicKey(sk)))
    .map((sk) => {
      const ev = finalizeEvent(attestationTemplate(digest, at), sk);
      return { signer: ev.pubkey, created_at: ev.created_at, sig: ev.sig };
    });
  const entry: KelEntry = { body, sigs };
  const event = finalizeEvent(kelEventTemplate(entry, Math.max(at, state.at), notify), signers[0]!);
  return { entry, event };
}

/** chain に rot を足すと、新しい端末だけが有効な状態になるかを確かめる */
export function verifyRotation(aid: string, chain: KelInput[], entry: KelEntry, at: number): KelState | null {
  const s = evaluateKel(aid, [...chain, { entry, at }]);
  return s && s.digests[s.digests.length - 1] === digestOf(entry.body) ? s : null;
}
