import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  attestationTemplate,
  DEVICE_LIFETIME_SEC,
  deviceId,
  digestOf,
  type DeviceRecord,
  type IcpBody,
  type IxnBody,
  type KelBody,
  type KelEntry,
  type KelSig,
  type KeyRef,
  type NextKeys,
  type RotBody,
} from '../../src/kel/kel.js';

/** WebCrypto の P-256 端末の代わり（同じ r||s の署名を作る） */
export function newDevice(at: number, label = 'dev', lifetime = DEVICE_LIFETIME_SEC) {
  const sk = p256.utils.randomSecretKey();
  const key: KeyRef = { type: 'p256', pub: bytesToHex(p256.getPublicKey(sk, false)) };
  const publisherSk = generateSecretKey();
  const record: DeviceRecord = {
    id: deviceId(key),
    key,
    publisher: getPublicKey(publisherSk),
    label,
    expiresAt: at + lifetime,
  };
  const sign = (digest: string): KelSig => ({
    signer: record.id,
    p256: bytesToHex(p256.sign(hexToBytes(digest), sk, { format: 'compact', lowS: false })),
  });
  return { record, sign, publisherSk };
}

/** 署名アプリ（NIP-07 / NIP-46）に鍵を任せた端末。device は署名アプリの署名、publisher はアプリの中の掲載用の鍵の署名 */
export function newSignerAppDevice(at: number, label = 'ext') {
  const sk = generateSecretKey();
  const publisherSk = generateSecretKey();
  const key: KeyRef = { type: 'schnorr', pub: getPublicKey(sk) };
  const record: DeviceRecord = { id: deviceId(key), key, publisher: getPublicKey(publisherSk), label, expiresAt: at + DEVICE_LIFETIME_SEC };
  const attest = (secret: Uint8Array, signer: string) => ({
    sign: (digest: string): KelSig => {
      const ev = finalizeEvent(attestationTemplate(digest, at), secret);
      return { signer, created_at: ev.created_at, sig: ev.sig };
    },
  });
  return { record, sk, publisherSk, device: attest(sk, record.id), publisher: attest(publisherSk, record.publisher) };
}

/** 復活の言葉の鍵（secp256k1） */
export function newNextKey() {
  const sk = generateSecretKey();
  const pub = getPublicKey(sk);
  const sign = (digest: string, createdAt = 1): KelSig => {
    const ev = finalizeEvent(attestationTemplate(digest, createdAt), sk);
    return { signer: pub, created_at: ev.created_at, sig: ev.sig };
  };
  return { pub, sign, sk };
}

type Signer = { sign: (digest: string) => KelSig };

export function signed(body: KelBody, signers: Signer[]): KelEntry {
  const d = digestOf(body);
  return { body, sigs: signers.map((s) => s.sign(d)) };
}

export function icp(devices: DeviceRecord[], next: NextKeys, nonce = 'n'): IcpBody {
  return { v: 1, t: 'icp', sn: 0, devices, next, nonce };
}

export function ixn(aid: string, sn: number, prior: string, change: Partial<Pick<IxnBody, 'add' | 'revoke' | 'renew'>>): IxnBody {
  return { v: 1, t: 'ixn', aid, sn, prior, add: change.add ?? [], revoke: change.revoke ?? [], renew: change.renew ?? [] };
}

export function rot(aid: string, sn: number, prior: string, devices: DeviceRecord[], next: NextKeys): RotBody {
  return { v: 1, t: 'rot', aid, sn, prior, devices, next };
}
