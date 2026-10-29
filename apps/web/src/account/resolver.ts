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

/**
 * 他人のイベントを証明書から aid に結び付ける。知らないアカウントは、証明書の掲載用の鍵と
 * x タグから KEL を探して覚える。スナップショットに記録済みの KEL を「先に見た版」にする。
 */
export class Resolver {
  #known: KelRecords = {};
  #extra: NostrEvent[] = [];
  #book = new KelBook({}, -Infinity, Infinity);
  #author = attributor(this.#book.states);
  /** 探した時刻。見つからなかったアカウントは RETRY_MS たってから探し直す */
  #looked = new Map<string, number>();
  #inflight = new Map<string, Promise<void>>();

  constructor(private readonly relay: RelayClient) {}

  /** スナップショットと手元の計算で分かっている KEL を入れ直す */
  setKnown(records: KelRecords): void {
    this.#known = records;
    this.#book = new KelBook(records, -Infinity, Infinity).add(this.#extra);
    this.#author = attributor(this.#book.states);
  }

  get states(): KelStates {
    return this.#book.states;
  }

  /** すでに分かっている KEL だけで結び付ける */
  authorNow = (ev: NostrEvent): Pubkey | null => this.#author(ev);

  /** 必要なら KEL を取りに行って結び付ける */
  author = async (ev: NostrEvent): Promise<Pubkey | null> => {
    const aid = certOf(ev)?.cert.aid;
    if (aid && this.#known[aid]) await warmKelSignatures(this.#known, [aid], [ev]);
    const now = this.#author(ev);
    if (now) return now;
    const c = certOf(ev);
    if (!c?.cert || this.#book.states.has(c.cert.aid)) return null;
    // 同じアカウントを同時に調べているときは、その結果を待つ
    const pending = this.#inflight.get(c.cert.aid);
    if (pending) {
      await pending;
      return this.#author(ev);
    }
    const last = this.#looked.get(c.cert.aid);
    if (last !== undefined && Date.now() - last < RETRY_MS) return null;
    this.#looked.set(c.cert.aid, Date.now());
    const filters = [{ kinds: [KIND.kel], '#x': [c.cert.aid] }, ...(typeof c.cert.publisher === 'string' ? [{ kinds: [KIND.kel], authors: [c.cert.publisher] }] : [])];
    const lookup = this.relay.query(filters).then(async (evs) => {
      await warmKelSignatures(this.#known, [c.cert.aid], [...evs, ev]);
      // 増えたアカウントの分だけを評価し直す。結び付けの控えは、知らなかったアカウントの分が変わるので作り直す
      this.#extra.push(...evs);
      this.#book.add(evs);
      this.#author = attributor(this.#book.states);
    });
    this.#inflight.set(c.cert.aid, lookup);
    try {
      await lookup;
    } finally {
      this.#inflight.delete(c.cert.aid);
    }
    return this.#author(ev);
  };
}
