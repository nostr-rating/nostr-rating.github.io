import type { NostrEvent } from 'nostr-tools/pure';
import type { Pubkey } from '../types.js';
import { deviceValidAt, digestOf, publisherSigned, verifyKeySig, type KelSig, type KelState } from './kel.js';

/** 使い捨ての鍵の証明書が有効な長さ */
export const SESSION_LIFETIME_SEC = 86400;

export interface SessionCert {
  v: 1;
  aid: string;
  /** 証明書を出した端末の id */
  device: string;
  /** その端末の掲載用の鍵。まだ知らないアカウントの KEL を探す手がかり（有効性には使わない） */
  publisher: Pubkey;
  /** 使い捨ての鍵（secp256k1 の公開鍵） */
  session: Pubkey;
  /** 出したときの KEL の先端（見つけるための手がかり。有効性には使わない） */
  tip: string;
  from: number;
  until: number;
}

export interface SignedCert {
  cert: SessionCert;
  sig: KelSig;
  /** schnorr の端末だけ: 同じ digest への、KEL に記録した掲載用の鍵の署名（docs/adr/0016） */
  publisherSig?: KelSig;
}

export const CERT_TAG = 'cert';
export const AID_TAG = 'aid';

/**
 * 証明書が、event（使い捨ての鍵が署名したイベント）を aid のものとして認めるか。
 * 出した端末が from の時点で有効なら認める。取り消しの前に出した証明書は、取り消したあとも until まで残る。
 */
export function verifyCert(state: KelState, signed: SignedCert, event: Pick<NostrEvent, 'pubkey' | 'created_at'>): boolean {
  const c = signed.cert;
  if (c.v !== 1 || c.aid !== state.aid || c.session !== event.pubkey) return false;
  if (!Number.isSafeInteger(c.from) || !Number.isSafeInteger(c.until)) return false;
  if (c.until <= c.from || c.until - c.from > SESSION_LIFETIME_SEC) return false;
  if (event.created_at < c.from || event.created_at > c.until) return false;
  if (signed.sig.signer !== c.device || !deviceValidAt(state, c.device, c.from)) return false;
  const device = state.devices.get(c.device)!;
  const digest = digestOf(c);
  return verifyKeySig(device.record.key, digest, signed.sig) && publisherSigned(device.record, digest, signed.publisherSig ? [signed.publisherSig] : []);
}

export function certTags(signed: SignedCert): string[][] {
  return [
    [AID_TAG, signed.cert.aid],
    [CERT_TAG, JSON.stringify(signed)],
  ];
}

/** イベントのタグから証明書を取り出す。形が合わなければ null */
export function certOf(event: Pick<NostrEvent, 'tags'>): SignedCert | null {
  if (!Array.isArray(event?.tags)) return null;
  const raw = event.tags.find((t) => t[0] === CERT_TAG)?.[1];
  const aid = event.tags.find((t) => t[0] === AID_TAG)?.[1];
  if (!raw || !aid) return null;
  try {
    const signed = JSON.parse(raw) as SignedCert;
    if (!signed?.cert || !signed.sig || signed.cert.aid !== aid) return null;
    return signed;
  } catch {
    return null;
  }
}
