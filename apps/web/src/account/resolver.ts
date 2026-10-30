import {
  attributor,
  KelBook,
  certOf,
  KIND,
  type KelRecords,
  type KelStates,
  type NostrEvent,
  type Pubkey,
  type RelayClient,
  warmKelSignatures,
} from '@nostr-rating/core';

const RETRY_MS = 60_000;
/** リレーへの1つの問い合わせに入れるアカウントの数 */
export const AUTHORS_CHUNK = 100;

/**
 * 他人のイベントを証明書から aid に結び付ける。知らないアカウントは、証明書の掲載用の鍵と
 * x タグから KEL を探して覚える。スナップショットに記録済みの KEL を「先に見た版」にする。
 */
export class Resolver {
  #known: KelRecords = {};
  /** スナップショットからあとで読んだ記録済みの KEL。同じスナップショットの間は setKnown をまたいで残す */
  #loaded: KelRecords = {};
  #extra: NostrEvent[] = [];
  #book = new KelBook({}, -Infinity, Infinity);
  #author = attributor(this.#book.states);
  /** 探した時刻。見つからなかったアカウントは RETRY_MS たってから探し直す */
  #looked = new Map<string, number>();
  #inflight = new Map<string, Promise<void>>();
  #loadKels: ((aids: Pubkey[]) => Promise<KelRecords>) | null = null;

  constructor(private readonly relay: RelayClient) {}

  /**
   * スナップショットと手元の計算で分かっている KEL を入れ直す。
   * loadKels は、知らないアカウントの記録済みの KEL をスナップショットから読む（docs/adr/0011）。
   * 省くと、今の loadKels を使い続ける
   */
  setKnown(records: KelRecords, loadKels?: (aids: Pubkey[]) => Promise<KelRecords>): void {
    if (loadKels && loadKels !== this.#loadKels) {
      this.#loadKels = loadKels;
      this.#loaded = {};
    }
    this.#known = { ...this.#loaded, ...records };
    this.#book = new KelBook(this.#known, -Infinity, Infinity).add(this.#extra);
    this.#author = attributor(this.#book.states);
  }

  get states(): KelStates {
    return this.#book.states;
  }

  /** すでに分かっている KEL だけで結び付ける */
  authorNow = (ev: NostrEvent): Pubkey | null => this.#author(ev);

  /** 必要なら KEL を取りに行って結び付ける */
  author = async (ev: NostrEvent): Promise<Pubkey | null> => (await this.authorAll([ev]))[0]!;

  /**
   * 複数のイベントをまとめて結び付ける。知らないアカウントの KEL は、スナップショットから1回、
   * リレーから AUTHORS_CHUNK 件ずつまとめて探す
   */
  async authorAll(evs: NostrEvent[]): Promise<(Pubkey | null)[]> {
    const certs = evs.map((ev) => certOf(ev)?.cert);
    const recorded = [...new Set(certs.flatMap((c) => (c && this.#known[c.aid] ? [c.aid] : [])))];
    if (recorded.length > 0) await warmKelSignatures(this.#known, recorded, evs);
    const t = Date.now();
    const unknown = new Map<string, string | null>();
    const waits: Promise<void>[] = [];
    for (const [i, c] of certs.entries()) {
      if (!c || this.#author(evs[i]!) || this.#book.states.has(c.aid) || unknown.has(c.aid)) continue;
      const pending = this.#inflight.get(c.aid);
      if (pending) {
        waits.push(pending);
        continue;
      }
      const last = this.#looked.get(c.aid);
      if (last !== undefined && t - last < RETRY_MS) continue;
      unknown.set(c.aid, typeof c.publisher === 'string' ? c.publisher : null);
    }
    if (unknown.size > 0) {
      const aids = [...unknown.keys()];
      for (const aid of aids) this.#looked.set(aid, t);
      const lookup = this.#lookup(unknown, evs);
      for (const aid of aids) this.#inflight.set(aid, lookup);
      waits.push(
        lookup
          .catch((e: unknown) => {
            // 探せなかった（リレーに届かないなど）ときは、探したことにしない
            for (const aid of aids) this.#looked.delete(aid);
            throw e;
          })
          .finally(() => {
            for (const aid of aids) this.#inflight.delete(aid);
          }),
      );
    }
    await Promise.all(waits);
    return evs.map((ev) => this.#author(ev));
  }

  async #lookup(unknown: Map<string, string | null>, evs: NostrEvent[]): Promise<void> {
    const aids = [...unknown.keys()];
    // 記録済みの KEL を先に入れる。読めなければ（古いスナップショットの部品が消えたなど）リレーだけで探す
    let recorded: KelRecords = {};
    try {
      recorded = (await this.#loadKels?.(aids)) ?? {};
    } catch (e) {
      console.warn('could not read recorded key event logs from the snapshot', e);
    }
    if (Object.keys(recorded).length > 0) {
      this.#loaded = { ...this.#loaded, ...recorded };
      this.#known = { ...this.#known, ...recorded };
      this.#book.addRecorded(recorded);
    }
    // そのあとの新しいイベントはリレーから探す（x タグと証明書の掲載用の鍵）
    const publishers = [...new Set([...unknown.values()].filter((p): p is string => p !== null))];
    const filters = [];
    for (let i = 0; i < aids.length; i += AUTHORS_CHUNK) filters.push({ kinds: [KIND.kel], '#x': aids.slice(i, i + AUTHORS_CHUNK) });
    for (let i = 0; i < publishers.length; i += AUTHORS_CHUNK) filters.push({ kinds: [KIND.kel], authors: publishers.slice(i, i + AUTHORS_CHUNK) });
    const found = await this.relay.query(filters);
    await warmKelSignatures(this.#known, aids, [...found, ...evs]);
    // 増えたアカウントの分だけを評価し直す。結び付けの控えは、知らなかったアカウントの分が変わるので作り直す
    this.#extra.push(...found);
    this.#book.add(found);
    this.#author = attributor(this.#book.states);
  }
}
