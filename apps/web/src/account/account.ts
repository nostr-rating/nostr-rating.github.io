import {
  attestationTemplate,
  decodeDeviceRequest,
  encodeDeviceRequest,
  certTags,
  DEVICE_LIFETIME_SEC,
  DEVICE_RENEW_BEFORE_SEC,
  deviceId,
  deviceValidAt,
  digestOf,
  evaluateKel,
  KIND,
  APP_TAG,
  kelEventTemplate,
  LocalSigner,
  notInFuture,
  parseKelEvent,
  recoveryKey,
  seenOrder,
  SESSION_LIFETIME_SEC,
  signAs,
  type DeviceRecord,
  type EventTemplate,
  type IcpBody,
  type IxnBody,
  type KelEntry,
  type KelInput,
  type KelSig,
  type KelState,
  type KeyRef,
  type NostrEvent,
  type Pubkey,
  type RelayClient,
  type SessionCert,
  type SessionIdentity,
  type SignedCert,
  type Signer,
} from '@nostr-rating/core';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { externalSigner, type ExternalDevice } from './external.js';

/** 端末の中にしまう値。秘密鍵は WebCrypto の取り出せない鍵（docs/adr/0008） */
export interface KeyStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface StoredDevice {
  id: string;
  key: KeyRef;
  /** WebCrypto の取り出せない鍵。署名アプリを使う端末では持たない */
  privateKey?: CryptoKey;
  /** 端末の鍵に使う署名アプリ（NIP-07 / NIP-46） */
  external?: ExternalDevice;
  /** 掲載用の鍵（権限を持たない） */
  publisherSk: string;
  label: string;
}

interface StoredSession {
  from: number;
  sk: string;
  cert: SignedCert;
}

interface StoredAccount {
  aid: string;
  device: StoredDevice;
  /** 手元で見た KEL（sn の順） */
  kel: KelInput[];
  /** 利用者が知っている端末（知らない端末が増えたら知らせる） */
  knownDevices: string[];
  sessions: StoredSession[];
}

const ACCOUNT = 'account';
const PENDING_DEVICE = 'pendingDevice';
/** DM を読むために残す、古い使い捨ての鍵の数 */
const KEEP_SESSIONS = 3;

export async function createDevice(label: string, external?: ExternalDevice): Promise<StoredDevice> {
  if (external) {
    const pub = await (await externalSigner(external)).getPublicKey();
    const key: KeyRef = { type: 'schnorr', pub };
    return { id: deviceId(key), key, external, publisherSk: bytesToHex(generateSecretKey()), label };
  }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const key: KeyRef = { type: 'p256', pub };
  return { id: deviceId(key), key, privateKey: kp.privateKey, publisherSk: bytesToHex(generateSecretKey()), label };
}

async function signDigest(d: StoredDevice, digest: string): Promise<KelSig> {
  if (d.external) {
    // 署名アプリは任意のバイト列に署名できないので、digest を入れたイベントに署名してもらう
    const ev = await (await externalSigner(d.external)).signEvent(attestationTemplate(digest, Math.floor(Date.now() / 1000)));
    return { signer: d.id, created_at: ev.created_at, sig: ev.sig };
  }
  if (!d.privateKey) throw new Error('この端末の鍵がありません');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.privateKey, hexToBytes(digest));
  return { signer: d.id, p256: bytesToHex(new Uint8Array(sig)) };
}

const publisherOf = (d: { publisherSk: string }) => getPublicKey(hexToBytes(d.publisherSk));

function recordOf(d: StoredDevice, at: number): DeviceRecord {
  return { id: d.id, key: d.key, publisher: publisherOf(d), label: d.label, expiresAt: at + DEVICE_LIFETIME_SEC };
}

export { decodeDeviceRequest, encodeDeviceRequest } from '@nostr-rating/core';

/** aid の KEL を集める（x タグと、分かっている鍵の持ち主から） */
/** 先の日時のイベントは使わない（その上に続けると、こちらの取り消しや延長の日時まで先になる） */
async function fetchKel(relay: RelayClient, aid: string, holders: Pubkey[], now: number): Promise<NostrEvent[]> {
  const filters = [{ kinds: [KIND.kel], '#x': [aid] }, ...(holders.length > 0 ? [{ kinds: [KIND.kel], authors: holders }] : [])];
  return notInFuture(await relay.query(filters), now).filter((e) => parseKelEvent(e)?.aid === aid);
}

function holdersOf(state: KelState | null): Pubkey[] {
  if (!state) return [];
  return [...new Set([...state.next.keys, ...[...state.devices.values()].map((d) => d.record.publisher)])];
}

/** 手元の版を先に見たものとして、リレーの版を足して評価する */
function evaluateWith(aid: string, local: KelInput[], events: NostrEvent[]): { state: KelState | null; chain: KelInput[] } {
  const fresh = seenOrder(events)
    .map((e) => parseKelEvent(e))
    .filter((p) => p !== null)
    .map((p) => p.input);
  const all = [...local, ...fresh];
  const state = evaluateKel(aid, all);
  if (!state) return { state: null, chain: local };
  const byDigest = new Map<string, KelInput>();
  for (const i of all) {
    const d = digestOf(i.entry.body);
    if (!byDigest.has(d)) byDigest.set(d, i);
  }
  return { state, chain: state.digests.map((d) => byDigest.get(d)!) };
}

export class Account {
  #data: StoredAccount;
  #state: KelState | null;

  private constructor(
    private readonly store: KeyStore,
    data: StoredAccount,
    private readonly relay: RelayClient,
    private readonly now: () => number,
  ) {
    this.#data = data;
    this.#state = evaluateKel(data.aid, data.kel);
  }

  static async load(store: KeyStore, relay: RelayClient, now: () => number): Promise<Account | null> {
    const data = await store.get<StoredAccount>(ACCOUNT);
    return data ? new Account(store, data, relay, now) : null;
  }

  /**
   * 「この端末で始める」。端末の鍵を作り、書き写したと確かめた復活の言葉を次の鍵にして作成の宣言を載せる。
   * 言葉は端末に残さない（配信される JavaScript をすり替えられたときに読まれ、復元できない乗っ取りになるため）
   */
  static async create(
    store: KeyStore,
    relay: RelayClient,
    now: () => number,
    label: string,
    recovery: { cards: string[]; threshold: number },
    external?: ExternalDevice,
  ): Promise<Account> {
    const at = now();
    const device = await createDevice(label, external);
    const next = { keys: recovery.cards.map((w) => recoveryKey(w).pub), threshold: recovery.threshold };
    const body: IcpBody = { v: 1, t: 'icp', sn: 0, devices: [recordOf(device, at)], next, nonce: bytesToHex(generateSecretKey()).slice(0, 16) };
    const aid = digestOf(body);
    const entry: KelEntry = { body, sigs: [await signDigest(device, aid)] };
    await relay.publish(finalizeEvent(kelEventTemplate(entry, at), hexToBytes(device.publisherSk)));
    const data: StoredAccount = { aid, device, kel: [{ entry, at }], knownDevices: [device.id], sessions: [] };
    await store.set(ACCOUNT, data);
    return new Account(store, data, relay, now);
  }

  get aid(): string {
    return this.#data.aid;
  }

  get deviceId(): string {
    return this.#data.device.id;
  }

  get kel(): KelInput[] {
    return [...this.#data.kel];
  }

  get state(): KelState | null {
    return this.#state;
  }

  /** この端末が今も有効か（取り消された・期限が切れた・放棄した） */
  get active(): boolean {
    return !!this.#state && !this.#state.abandoned && deviceValidAt(this.#state, this.deviceId, this.now());
  }

  /** 有効な端末のうち、利用者がまだ知らないもの */
  get unknownDevices(): DeviceRecord[] {
    if (!this.#state) return [];
    const t = this.now();
    return [...this.#state.devices.values()]
      .filter((d) => deviceValidAt(this.#state!, d.record.id, t) && !this.#data.knownDevices.includes(d.record.id))
      .map((d) => d.record);
  }

  async acknowledgeDevices(): Promise<void> {
    this.#data.knownDevices = [...new Set([...this.#data.knownDevices, ...this.unknownDevices.map((d) => d.id)])];
    await this.#save();
  }

  async #save(): Promise<void> {
    await this.store.set(ACCOUNT, this.#data);
  }

  async #publishIxn(change: Partial<Pick<IxnBody, 'add' | 'revoke' | 'renew'>>, notify: Pubkey[] = []): Promise<void> {
    await this.refreshKel();
    const state = this.#state;
    if (!state || !this.active) throw new Error('この端末は登録が切れています');
    const at = Math.max(this.now(), state.at);
    const body: IxnBody = { v: 1, t: 'ixn', aid: this.aid, sn: state.sn + 1, prior: state.tip, add: change.add ?? [], revoke: change.revoke ?? [], renew: change.renew ?? [] };
    const entry: KelEntry = { body, sigs: [await signDigest(this.#data.device, digestOf(body))] };
    await this.relay.publish(finalizeEvent(kelEventTemplate(entry, at, notify), hexToBytes(this.#data.device.publisherSk)));
    this.#data.kel = [...this.#data.kel, { entry, at }];
    this.#state = evaluateKel(this.aid, this.#data.kel);
    await this.#save();
  }

  /** 端末の申請を受けて、その端末を足す */
  async addDevice(code: string): Promise<DeviceRecord> {
    const req = decodeDeviceRequest(code);
    if (!req) throw new Error('端末の申請の形が正しくありません');
    const at = this.now();
    const record: DeviceRecord = { id: deviceId(req.key), key: req.key, publisher: req.publisher, label: req.label, expiresAt: at + DEVICE_LIFETIME_SEC };
    await this.#publishIxn({ add: [record] }, [req.publisher]);
    this.#data.knownDevices = [...new Set([...this.#data.knownDevices, record.id])];
    await this.#save();
    return record;
  }

  async revoke(id: string): Promise<void> {
    await this.#publishIxn({ revoke: [id] });
  }

  /** 期限まで 30 日を切っていれば、この端末を延長する */
  async renewIfNeeded(): Promise<boolean> {
    const d = this.#state?.devices.get(this.deviceId);
    if (!d || !this.active || d.record.expiresAt - this.now() > DEVICE_RENEW_BEFORE_SEC) return false;
    await this.#publishIxn({ renew: [{ id: this.deviceId, expiresAt: this.now() + DEVICE_LIFETIME_SEC }] });
    return true;
  }

  /** リレーから自分の KEL を読み直す（ほかの端末での追加・取り消し、復活による入れ替え） */
  async refreshKel(): Promise<void> {
    const events = await fetchKel(this.relay, this.aid, holdersOf(this.#state), this.now());
    const { state, chain } = evaluateWith(this.aid, this.#data.kel, events);
    this.#state = state;
    this.#data.kel = chain;
    await this.#save();
  }

  /** 今日の使い捨ての鍵。なければ作り、証明書を出して知らせる */
  async session(): Promise<{ identity: SessionIdentity; signer: Signer; sessionSigners: Signer[] }> {
    if (!this.active) throw new Error('この端末は登録が切れています');
    const t = this.now();
    const day = Math.floor(t / SESSION_LIFETIME_SEC) * SESSION_LIFETIME_SEC;
    // 証明書は端末が有効な時点から始める（その日に登録した端末は、日付の境目ではまだ有効でない）
    const since = this.#state!.devices.get(this.deviceId)!.intervals.find((i) => i.from <= t && t < i.to)!.from;
    const from = Math.max(day, since);
    const until = day + SESSION_LIFETIME_SEC;
    let s = this.#data.sessions.find((x) => x.cert.cert.until === until && x.from >= since);
    if (!s) {
      const sk = generateSecretKey();
      const device = this.#data.device;
      const cert: SessionCert = { v: 1, aid: this.aid, device: device.id, publisher: publisherOf(device), session: getPublicKey(sk), tip: this.#state!.tip, from, until };
      const signed: SignedCert = { cert, sig: await signDigest(device, digestOf(cert)) };
      s = { from, sk: bytesToHex(sk), cert: signed };
      await this.relay.publish(
        finalizeEvent({ kind: KIND.cert, created_at: from, tags: [['t', APP_TAG], ['aid', this.aid]], content: JSON.stringify(signed) }, hexToBytes(device.publisherSk)),
      );
      this.#data.sessions = [s, ...this.#data.sessions].sort((a, b) => b.from - a.from).slice(0, KEEP_SESSIONS);
      await this.#save();
    }
    const raw = new LocalSigner(hexToBytes(s.sk));
    const identity: SessionIdentity = { aid: this.aid, signer: raw, cert: s.cert };
    return { identity, signer: certSigner(identity), sessionSigners: this.#data.sessions.map((x) => new LocalSigner(hexToBytes(x.sk))) };
  }

  /** この端末の登録を消す（端末から出るとき）。KEL からは別の端末で取り消す */
  static async forget(store: KeyStore): Promise<void> {
    await store.delete(ACCOUNT);
    await store.delete(PENDING_DEVICE);
  }

  // ---- 2台目・復活: 新しい端末の側 ----

  /** 新しい端末の鍵を作り、申請のコードを返す。登録されるまで待つには waitForRegistration */
  static async prepareDevice(store: KeyStore, label: string, external?: ExternalDevice): Promise<string> {
    let device = await store.get<StoredDevice>(PENDING_DEVICE);
    // 署名アプリを使うかどうかや、使う署名アプリを変えたときは、申請を作り直す
    if (!device || JSON.stringify(device.external ?? null) !== JSON.stringify(external ?? null)) {
      device = await createDevice(label, external);
      await store.set(PENDING_DEVICE, device);
    }
    return encodeDeviceRequest({ key: device.key, publisher: publisherOf(device), label: device.label });
  }

  /**
   * 申請した端末が KEL に載るのを待つ（ixn での追加か、復活の道具の rot）。
   * 載ったら、この端末をそのアカウントの端末として保存する
   */
  static waitForRegistration(store: KeyStore, relay: RelayClient, now: () => number, onDone: (a: Account) => void): () => void {
    let stopped = false;
    let unsub = () => undefined as void;
    void store.get<StoredDevice>(PENDING_DEVICE).then((device) => {
      if (!device || stopped) return;
      unsub = relay.subscribe([{ kinds: [KIND.kel], '#p': [publisherOf(device)] }], (ev) => {
        const parsed = parseKelEvent(ev);
        if (!parsed || stopped) return;
        void (async () => {
          const events = await fetchKel(relay, parsed.aid, [ev.pubkey], now());
          let { state, chain } = evaluateWith(parsed.aid, [], [...events, ...notInFuture([ev], now())]);
          // 鍵の持ち主が分かったら、その分も取り直す
          ({ state, chain } = evaluateWith(parsed.aid, [], [...events, ...notInFuture([ev], now()), ...(await fetchKel(relay, parsed.aid, holdersOf(state), now()))]));
          if (!state || !deviceValidAt(state, device.id, now()) || stopped) return;
          const data: StoredAccount = { aid: parsed.aid, device, kel: chain, knownDevices: [...state.devices.keys()], sessions: [] };
          await store.set(ACCOUNT, data);
          await store.delete(PENDING_DEVICE);
          stopped = true;
          unsub();
          onDone(new Account(store, data, relay, now));
        })();
      });
    });
    return () => {
      stopped = true;
      unsub();
    };
  }
}

/** アプリのイベントに証明書のタグを付けて、使い捨ての鍵で署名する */
export function certSigner(id: SessionIdentity): Signer {
  return {
    getPublicKey: () => id.signer.getPublicKey(),
    signEvent: (t: EventTemplate) => signAs(id, t),
    nip44Encrypt: (peer, text) => id.signer.nip44Encrypt(peer, text),
    nip44Decrypt: (peer, cipher) => id.signer.nip44Decrypt(peer, cipher),
  };
}

export function memoryKeyStore(): KeyStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}
