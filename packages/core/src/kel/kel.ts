import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import type { Pubkey } from '../types.js';

/** 端末の登録の既定の長さと、1回の登録・延長で許す上限 */
export const DEVICE_LIFETIME_SEC = 90 * 86400;
/** 期限までこれを切ったら、アプリが自動で延長する */
export const DEVICE_RENEW_BEFORE_SEC = 30 * 86400;
/** schnorr の鍵が本文に署名するときの、Nostr のイベントの kind（リレーには載せない） */
export const ATTESTATION_KIND = 23753;

/** 端末の鍵。WebCrypto の P-256 か、Nostr の鍵（NIP-07 の署名アプリ） */
export type KeyRef = { type: 'p256'; pub: string } | { type: 'schnorr'; pub: Pubkey };

export interface DeviceRecord {
  /** deviceId(key) */
  id: string;
  key: KeyRef;
  /** KEL のイベントを Nostr に載せる鍵。権限は持たない */
  publisher: Pubkey;
  label: string;
  expiresAt: number;
}

export interface NextKeys {
  /** 復活の言葉（NIP-06）の公開鍵 */
  keys: Pubkey[];
  threshold: number;
}

export interface IcpBody {
  v: 1;
  t: 'icp';
  sn: 0;
  devices: DeviceRecord[];
  next: NextKeys;
  /** 同じ鍵で作り直したときに aid が重ならないように */
  nonce: string;
}

export interface IxnBody {
  v: 1;
  t: 'ixn';
  aid: string;
  sn: number;
  prior: string;
  add: DeviceRecord[];
  revoke: string[];
  renew: { id: string; expiresAt: number }[];
}

export interface RotBody {
  v: 1;
  t: 'rot';
  aid: string;
  sn: number;
  prior: string;
  devices: DeviceRecord[];
  /** 空ならアカウントの放棄 */
  next: NextKeys;
}

export type KelBody = IcpBody | IxnBody | RotBody;

/**
 * 本文への署名。P-256 は digest のバイト列への ECDSA（WebCrypto の r||s）。
 * schnorr の鍵は任意のバイト列に署名できない署名アプリがあるので、content に digest を入れた
 * Nostr のイベント（kind ATTESTATION_KIND）への署名で代える。
 */
export type KelSig = { signer: string; p256: string } | { signer: string; created_at: number; sig: string };

export interface KelEntry {
  body: KelBody;
  sigs: KelSig[];
}

/** 鍵の並びを除き、キーを辞書順に並べた空白のない JSON */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('only integers are allowed');
  return JSON.stringify(value);
}

export function digestOf(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

export function deviceId(key: KeyRef): string {
  return digestOf(key).slice(0, 32);
}

/** schnorr の鍵が digest に署名するときに作るイベント */
export function attestationTemplate(digest: string, createdAt: number) {
  return { kind: ATTESTATION_KIND, created_at: createdAt, tags: [] as string[][], content: digest };
}

export function verifyKeySig(key: KeyRef, digest: string, sig: KelSig): boolean {
  try {
    if (key.type === 'p256') {
      if (!('p256' in sig)) return false;
      return p256.verify(hexToBytes(sig.p256), hexToBytes(digest), hexToBytes(key.pub), { lowS: false });
    }
    if (!('sig' in sig)) return false;
    const t = attestationTemplate(digest, sig.created_at);
    const ev = { ...t, pubkey: key.pub, sig: sig.sig, id: '' } as NostrEvent;
    ev.id = eventId(ev);
    return verifyEvent(ev);
  } catch {
    return false;
  }
}

function eventId(ev: Omit<NostrEvent, 'id' | 'sig'>): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX_P256 = /^04[0-9a-f]{128}$/;

function validKey(k: unknown): k is KeyRef {
  if (!k || typeof k !== 'object') return false;
  const key = k as KeyRef;
  return (key.type === 'p256' && HEX_P256.test(key.pub)) || (key.type === 'schnorr' && HEX64.test(key.pub));
}

function validDevice(d: DeviceRecord, at: number): boolean {
  return (
    validKey(d.key) &&
    d.id === deviceId(d.key) &&
    HEX64.test(d.publisher) &&
    typeof d.label === 'string' &&
    d.label.length <= 64 &&
    Number.isSafeInteger(d.expiresAt) &&
    d.expiresAt > at &&
    d.expiresAt - at <= DEVICE_LIFETIME_SEC
  );
}

function validNext(n: NextKeys, allowEmpty: boolean): boolean {
  if (!n || !Array.isArray(n.keys) || !n.keys.every((k) => HEX64.test(k))) return false;
  if (new Set(n.keys).size !== n.keys.length) return false;
  if (n.keys.length === 0) return allowEmpty && n.threshold === 0;
  return Number.isSafeInteger(n.threshold) && n.threshold >= 1 && n.threshold <= n.keys.length;
}

/** 端末が有効な期間 [from, to) の並び */
export interface DeviceState {
  record: DeviceRecord;
  intervals: { from: number; to: number }[];
}

export interface KelState {
  aid: string;
  sn: number;
  /** 先端の本文の digest */
  tip: string;
  /** 先端のイベントの時刻 */
  at: number;
  devices: Map<string, DeviceState>;
  next: NextKeys;
  abandoned: boolean;
  /** 採用した本文の digest（sn の順） */
  digests: string[];
}

export interface KelInput {
  entry: KelEntry;
  /** このイベントの時刻（Nostr のイベントの created_at）。ただし受け付けの幅はスナップショットが決める */
  at: number;
}

function cloneState(s: KelState): KelState {
  const devices = new Map<string, DeviceState>();
  for (const [id, d] of s.devices) devices.set(id, { record: d.record, intervals: d.intervals.map((i) => ({ ...i })) });
  return { ...s, devices, next: { keys: [...s.next.keys], threshold: s.next.threshold }, digests: [...s.digests] };
}

/** t の時点で有効な端末か */
export function deviceValidAt(state: KelState, id: string, t: number): boolean {
  const d = state.devices.get(id);
  return !!d && d.intervals.some((i) => i.from <= t && t < i.to);
}

function closeAt(d: DeviceState, at: number): void {
  for (const i of d.intervals) if (i.to > at) i.to = Math.max(i.from, at);
}

function openUntil(d: DeviceState, at: number, until: number): void {
  const last = d.intervals[d.intervals.length - 1];
  if (last && last.to >= at) last.to = Math.max(last.to, until);
  else d.intervals.push({ from: at, to: until });
}

function signedBy(digest: string, sigs: KelSig[], key: KeyRef, signer: string): boolean {
  return sigs.some((s) => s.signer === signer && verifyKeySig(key, digest, s));
}

function applyIcp(aid: string, input: KelInput): KelState | null {
  const b = input.entry.body;
  if (b.t !== 'icp' || b.v !== 1 || b.sn !== 0 || typeof b.nonce !== 'string') return null;
  const digest = digestOf(b);
  if (digest !== aid) return null;
  if (!Array.isArray(b.devices) || b.devices.length === 0 || !validNext(b.next, false)) return null;
  if (new Set(b.devices.map((d) => d.id)).size !== b.devices.length) return null;
  for (const d of b.devices) {
    if (!validDevice(d, input.at) || !signedBy(digest, input.entry.sigs, d.key, d.id)) return null;
  }
  const devices = new Map<string, DeviceState>();
  for (const d of b.devices) devices.set(d.id, { record: d, intervals: [{ from: input.at, to: d.expiresAt }] });
  return { aid, sn: 0, tip: digest, at: input.at, devices, next: b.next, abandoned: false, digests: [digest] };
}

function applyIxn(s: KelState, input: KelInput): KelState | null {
  const b = input.entry.body;
  if (b.t !== 'ixn' || b.v !== 1 || s.abandoned) return null;
  if (b.aid !== s.aid || b.sn !== s.sn + 1 || b.prior !== s.tip || input.at < s.at) return null;
  if (!Array.isArray(b.add) || !Array.isArray(b.revoke) || !Array.isArray(b.renew)) return null;
  if (b.add.length + b.revoke.length + b.renew.length === 0) return null;
  const digest = digestOf(b);
  // 有効な端末のどれか1つが署名していればよい
  const signer = input.entry.sigs.find((sig) => {
    const d = s.devices.get(sig.signer);
    return !!d && deviceValidAt(s, sig.signer, input.at) && verifyKeySig(d.record.key, digest, sig);
  });
  if (!signer) return null;
  const n = cloneState(s);
  for (const d of b.add) {
    if (!validDevice(d, input.at) || n.devices.has(d.id)) return null;
    n.devices.set(d.id, { record: d, intervals: [{ from: input.at, to: d.expiresAt }] });
  }
  for (const r of b.renew) {
    const d = n.devices.get(r.id);
    if (!d || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= input.at || r.expiresAt - input.at > DEVICE_LIFETIME_SEC) return null;
    d.record = { ...d.record, expiresAt: r.expiresAt };
    openUntil(d, input.at, r.expiresAt);
  }
  for (const id of b.revoke) {
    const d = n.devices.get(id);
    if (!d) return null;
    closeAt(d, input.at);
  }
  return { ...n, sn: b.sn, tip: digest, at: input.at, digests: [...n.digests, digest] };
}

function applyRot(s: KelState, input: KelInput): KelState | null {
  const b = input.entry.body;
  if (b.t !== 'rot' || b.v !== 1 || s.abandoned) return null;
  if (b.aid !== s.aid || b.sn !== s.sn + 1 || b.prior !== s.tip || input.at < s.at) return null;
  const abandon = b.next?.keys?.length === 0;
  if (!validNext(b.next, true) || !Array.isArray(b.devices)) return null;
  if (abandon ? b.devices.length !== 0 : b.devices.length === 0) return null;
  if (new Set(b.devices.map((d) => d.id)).size !== b.devices.length) return null;
  const digest = digestOf(b);
  const signers = new Set(
    s.next.keys.filter((k) => signedBy(digest, input.entry.sigs, { type: 'schnorr', pub: k }, k)),
  );
  if (signers.size < s.next.threshold) return null;
  const n = cloneState(s);
  const keep = new Set(b.devices.map((d) => d.id));
  for (const [id, d] of n.devices) if (!keep.has(id)) closeAt(d, input.at);
  for (const d of b.devices) {
    if (!validDevice(d, input.at)) return null;
    const cur = n.devices.get(d.id);
    if (cur) {
      cur.record = d;
      openUntil(cur, input.at, d.expiresAt);
    } else {
      n.devices.set(d.id, { record: d, intervals: [{ from: input.at, to: d.expiresAt }] });
    }
  }
  return { ...n, sn: b.sn, tip: digest, at: input.at, next: b.next, abandoned: abandon, digests: [...n.digests, digest] };
}

/**
 * 1つのアカウントの KEL を評価する。inputs は「先に見た」順（スナップショットが記録した順、
 * そのあとは created_at, id の順）に並べて渡す。
 *
 * - 同じ番号では rot が ixn を上書きできる（それより後ろの ixn もまとめて捨てる）
 * - rot は rot を上書きできない。ixn は何も上書きできない
 * - 上書きできない同じ番号のイベントは、先に見たほうを正とする
 */
export function evaluateKel(aid: string, inputs: KelInput[]): KelState | null {
  const icp = inputs.find((i) => i.entry.body.t === 'icp' && applyIcp(aid, i));
  if (!icp) return null;
  // history[k] は sn = k を適用した直後の状態。kinds[k] はそのイベントの種類
  const history: KelState[] = [applyIcp(aid, icp)!];
  const kinds: KelBody['t'][] = ['icp'];
  const used = new Set<KelInput>([icp]);

  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const input of inputs) {
      if (used.has(input)) continue;
      const b = input.entry.body;
      if (b.t === 'icp') continue;
      const tip = history[history.length - 1]!;
      if (b.sn === tip.sn + 1) {
        const next = b.t === 'ixn' ? applyIxn(tip, input) : applyRot(tip, input);
        if (next) {
          history.push(next);
          kinds.push(b.t);
          used.add(input);
          progressed = true;
        }
        continue;
      }
      // 上書き: rot が、その番号から先端までがすべて ixn の区間を置き換える
      if (b.t === 'rot' && b.sn >= 1 && b.sn <= tip.sn && kinds.slice(b.sn).every((k) => k === 'ixn')) {
        const base = history[b.sn - 1]!;
        const next = applyRot(base, input);
        if (next) {
          history.length = b.sn;
          kinds.length = b.sn;
          history.push(next);
          kinds.push('rot');
          used.add(input);
          progressed = true;
        }
      }
    }
  }
  return history[history.length - 1]!;
}
