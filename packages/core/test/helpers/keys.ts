import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import type { KelRecords, SessionIdentity } from '../../src/kel/book.js';
import { certTags, SESSION_LIFETIME_SEC, type SessionCert, type SignedCert } from '../../src/kel/cert.js';
import { kelEventTemplate } from '../../src/kel/event.js';
import { APP_TAG, KIND } from '../../src/events/kinds.js';
import { digestOf, type KelInput } from '../../src/kel/kel.js';
import { LocalSigner, type Signer } from '../../src/identity/signer.js';
import { icp, newDevice, newNextKey, rot, signed } from './kel.js';

/** ただの Nostr の鍵（DM など、KEL を通さない処理のテスト用） */
export function newKeys() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), signer: new LocalSigner(sk) };
}

/** テストの時刻はこれ以降。端末の期限が切れたら、その時刻で入れ替えて登録し直す */
const GENESIS = 1_789_000_000;

/** すべてのテスト用アカウントの KEL（helpers/state.ts が prev に入れる） */
const registry: KelRecords = {};

export function registeredKels(): KelRecords {
  return Object.fromEntries(Object.entries(registry).map(([aid, inputs]) => [aid, [...inputs]]));
}

/**
 * KEL を持つテスト用アカウント。pk は aid。signer は、イベントの時刻に合う使い捨ての鍵と証明書で署名する。
 * 端末の期限を過ぎた時刻で署名するときは、次の鍵で入れ替えて端末を登録し直す。
 */
export function newUser() {
  const first = newDevice(GENESIS);
  let next = newNextKey();
  const body = icp([first.record], { keys: [next.pub], threshold: 1 }, Math.random().toString(36));
  const aid = digestOf(body);
  const kel: KelInput[] = [{ entry: signed(body, [first]), at: GENESIS }];
  registry[aid] = kel;
  /** KEL の各イベントを Nostr に載せる鍵（icp は掲載用の鍵、rot は次の鍵） */
  const kelPublishers: Uint8Array[] = [first.publisherSk];
  /** 端末と、それが有効な期間 [from, to) */
  const devices = [{ device: first, from: GENESIS, to: first.record.expiresAt }];
  const sessions = new Map<number, { sk: Uint8Array; cert: SignedCert }>();

  const deviceAt = (t: number) => {
    const found = devices.find((d) => d.from <= t && t < d.to);
    if (found) return found.device;
    const last = kel[kel.length - 1]!;
    if (t < last.at) throw new Error('test helper cannot register a device in the past');
    const fresh = newDevice(t);
    const next2 = newNextKey();
    const r = rot(aid, last.entry.body.sn + 1, digestOf(last.entry.body), [fresh.record], { keys: [next2.pub], threshold: 1 });
    kel.push({ entry: signed(r, [next]), at: t });
    kelPublishers.push(next.sk);
    for (const d of devices) d.to = Math.min(d.to, t);
    devices.push({ device: fresh, from: t, to: fresh.record.expiresAt });
    next = next2;
    return fresh;
  };

  const sessionAt = (t: number) => {
    const day = Math.floor(t / SESSION_LIFETIME_SEC) * SESSION_LIFETIME_SEC;
    let s = sessions.get(day);
    if (!s) {
      const device = deviceAt(day);
      const sk = generateSecretKey();
      const cert: SessionCert = { v: 1, aid, device: device.record.id, publisher: device.record.publisher, session: getPublicKey(sk), tip: '', from: day, until: day + SESSION_LIFETIME_SEC };
      s = { sk, cert: { cert, sig: device.sign(digestOf(cert)) } };
      sessions.set(day, s);
    }
    return s;
  };

  const signer: Signer = {
    getPublicKey: async () => aid,
    signEvent: async (t: EventTemplate): Promise<NostrEvent> => {
      const s = sessionAt(t.created_at);
      return finalizeEvent({ ...t, tags: [...t.tags, ...certTags(s.cert)] }, s.sk);
    },
    nip44Encrypt: () => Promise.reject(new Error('not used')),
    nip44Decrypt: () => Promise.reject(new Error('not used')),
  };

  return {
    pk: aid,
    signer,
    /** その時刻に使う使い捨ての公開鍵 */
    sessionAt: (t: number) => getPublicKey(sessionAt(t).sk),
    certAt: (t: number) => sessionAt(t).cert,
    /** その時刻の証明書のお知らせ（kind 3755）。端末の掲載用の鍵が載せる */
    certAnnouncement: (t: number): NostrEvent => {
      const s = sessionAt(t);
      const d = devices.find((x) => x.device.record.id === s.cert.cert.device)!.device;
      return finalizeEvent({ kind: KIND.cert, created_at: s.cert.cert.from, tags: [['t', APP_TAG], ['aid', aid]], content: JSON.stringify(s.cert) }, d.publisherSk);
    },
    /** その時刻の使い捨ての鍵で振る舞うための SessionIdentity */
    identityAt: (t: number): SessionIdentity => ({ aid, signer: new LocalSigner(sessionAt(t).sk), cert: sessionAt(t).cert }),
    /** 端末の掲載用の鍵で、同じ秒に n 個のお知らせ（kind 3755）を出す（KEL の問い合わせをあふれさせる） */
    publisherFlood: (n: number, at: number): NostrEvent[] =>
      Array.from({ length: n }, (_, i) => finalizeEvent({ kind: KIND.cert, created_at: at, tags: [['t', APP_TAG], ['aid', aid]], content: String(i) }, first.publisherSk)),
    /** KEL を Nostr のイベント（kind 3753）にする */
    kelEvents: (): NostrEvent[] => kel.map((i, n) => finalizeEvent(kelEventTemplate(i.entry, i.at), kelPublishers[n]!)),
  };
}
