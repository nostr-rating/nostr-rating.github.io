import {
  attributor,
  buildKelBook,
  certOf,
  KIND,
  type KelRecords,
  type KelState,
  type NostrEvent,
  type Pubkey,
  type RelayClient,
} from '@nostr-rating/core';

const RETRY_MS = 60_000;

/**
 * 他人のイベントを証明書から aid に結び付ける。知らないアカウントは、証明書の掲載用の鍵と
 * x タグから KEL を探して覚える。スナップショットに記録済みの KEL を「先に見た版」にする。
 */
export class Resolver {
  #known: KelRecords = {};
  #extra: NostrEvent[] = [];
  #states = new Map<string, KelState>();
  #author = attributor(this.#states);
  /** 探した時刻。見つからなかったアカウントは RETRY_MS たってから探し直す */
  #looked = new Map<string, number>();
  #inflight = new Map<string, Promise<void>>();

  constructor(private readonly relay: RelayClient) {}

  /** スナップショットと手元の計算で分かっている KEL を入れ直す */
  setKnown(records: KelRecords): void {
    this.#known = records;
    this.#rebuild();
  }

  get states(): Map<string, KelState> {
    return this.#states;
  }

  #rebuild(): void {
    this.#states = buildKelBook(this.#known, this.#extra, -Infinity, Infinity).states;
    this.#author = attributor(this.#states);
  }

  /** すでに分かっている KEL だけで結び付ける */
  authorNow = (ev: NostrEvent): Pubkey | null => this.#author(ev);

  /** 必要なら KEL を取りに行って結び付ける */
  author = async (ev: NostrEvent): Promise<Pubkey | null> => {
    const now = this.#author(ev);
    if (now) return now;
    const c = certOf(ev);
    if (!c?.cert || this.#states.has(c.cert.aid)) return null;
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
    const lookup = this.relay.query(filters).then((evs) => {
      this.#extra.push(...evs);
      this.#rebuild();
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
