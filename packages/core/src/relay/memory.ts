import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { isValidEvent, tagValue } from '../events/kinds.js';
import type { RelayClient } from './client.js';

const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k: number) => k >= 30000 && k < 40000;

/** テストと開発用のメモリ内リレー。NIP-01 の置き換えと NIP-40 の失効を再現する */
export class MemoryRelay implements RelayClient {
  #events: NostrEvent[] = [];
  #subs = new Set<{ filters: Filter[]; onEvent: (ev: NostrEvent) => void }>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  #alive(ev: NostrEvent): boolean {
    const exp = tagValue(ev, 'expiration');
    return exp === undefined || Number(exp) > this.#now();
  }

  #sameSlot(a: NostrEvent, b: NostrEvent): boolean {
    if (a.kind !== b.kind || a.pubkey !== b.pubkey) return false;
    if (isReplaceable(a.kind)) return true;
    if (isAddressable(a.kind)) return (tagValue(a, 'd') ?? '') === (tagValue(b, 'd') ?? '');
    return false;
  }

  async publish(ev: NostrEvent): Promise<void> {
    if (!isValidEvent(ev)) throw new Error('invalid: bad signature');
    if (this.#events.some((e) => e.id === ev.id)) return;
    const prev = this.#events.find((e) => this.#sameSlot(e, ev));
    if (prev) {
      if (prev.created_at > ev.created_at) return;
      this.#events = this.#events.filter((e) => e !== prev);
    }
    this.#events.push(ev);
    for (const s of this.#subs) {
      if (s.filters.some((f) => matchFilter(f, ev))) s.onEvent(ev);
    }
  }

  /** 実際のリレーと同じく、limit があれば新しい順にその件数だけ返す */
  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      let hits = this.#events.filter((e) => this.#alive(e) && matchFilter(f, e));
      if (f.limit !== undefined) {
        hits = hits.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, f.limit);
      }
      for (const e of hits) out.set(e.id, e);
    }
    return [...out.values()];
  }

  subscribe(filters: Filter[], onEvent: (ev: NostrEvent) => void): () => void {
    for (const e of this.#events) {
      if (this.#alive(e) && filters.some((f) => matchFilter(f, e))) onEvent(e);
    }
    const sub = { filters, onEvent };
    this.#subs.add(sub);
    return () => this.#subs.delete(sub);
  }

  close(): void {
    this.#subs.clear();
  }

  /** テスト用: 保存されているすべてのイベント */
  all(): NostrEvent[] {
    return [...this.#events];
  }
}
