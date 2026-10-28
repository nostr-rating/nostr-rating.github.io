import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import {
  APP_TAG,
  certTags,
  DEVICE_LIFETIME_SEC,
  deviceId,
  digestOf,
  KIND,
  kelEventTemplate,
  SESSION_LIFETIME_SEC,
  type DeviceRecord,
  type IcpBody,
  type KeyRef,
  type SignedCert,
} from '@nostr-rating/core';

const DAY = SESSION_LIFETIME_SEC;
const fill = (n: number) => new Uint8Array(32).fill(n);

/**
 * 鍵をすべて固定したアカウント（golden を作れるように）。
 * P-256 の署名は RFC 6979 で決まるので、KEL と証明書も毎回同じになる。
 */
export function fixedAccount(n: number, createdAt: number) {
  const deviceSk = fill(n);
  const publisherSk = fill(n + 50);
  const key: KeyRef = { type: 'p256', pub: bytesToHex(p256.getPublicKey(deviceSk, false)) };
  const device: DeviceRecord = { id: deviceId(key), key, publisher: getPublicKey(publisherSk), label: `d${n}`, expiresAt: createdAt + DEVICE_LIFETIME_SEC };
  const signDigest = (digest: string) => bytesToHex(p256.sign(hexToBytes(digest), deviceSk, { format: 'compact', lowS: false }));
  const body: IcpBody = { v: 1, t: 'icp', sn: 0, devices: [device], next: { keys: [getPublicKey(fill(n + 100))], threshold: 1 }, nonce: String(n) };
  const aid = digestOf(body);
  const kelEvent = finalizeEvent(kelEventTemplate({ body, sigs: [{ signer: device.id, p256: signDigest(aid) }] }, createdAt), publisherSk);

  const sessions = new Map<number, { sk: Uint8Array; cert: SignedCert }>();
  const sessionAt = (t: number) => {
    const from = Math.floor(t / DAY) * DAY;
    let s = sessions.get(from);
    if (!s) {
      const sk = fill((n + 150 + sessions.size) % 256);
      const cert = { v: 1 as const, aid, device: device.id, publisher: device.publisher, session: getPublicKey(sk), tip: aid, from, until: from + DAY };
      s = { sk, cert: { cert, sig: { signer: device.id, p256: signDigest(digestOf(cert)) } } };
      sessions.set(from, s);
    }
    return s;
  };

  return {
    aid,
    kelEvent,
    session: (t: number) => getPublicKey(sessionAt(t).sk),
    sign: (t: EventTemplate): NostrEvent => {
      const s = sessionAt(t.created_at);
      return finalizeEvent({ ...t, tags: [...t.tags, ...certTags(s.cert)] }, s.sk);
    },
    certAnnouncement: (t: number): NostrEvent => {
      const s = sessionAt(t);
      return finalizeEvent({ kind: KIND.cert, created_at: s.cert.cert.from, tags: [['t', APP_TAG], ['aid', aid]], content: JSON.stringify(s.cert) }, publisherSk);
    },
  };
}
