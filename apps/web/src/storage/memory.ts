import type { NostrEvent } from 'nostr-tools/pure';
import type { EventQuery, EventStore } from './types.js';

export class MemoryEventStore implements EventStore {
  readonly persistent = false;
  #events = new Map<string, NostrEvent>();

  async put(evs: NostrEvent[]): Promise<void> {
    for (const e of evs) this.#events.set(e.id, e);
  }

  async query(q: EventQuery): Promise<NostrEvent[]> {
    return [...this.#events.values()].filter(
      (e) => (q.kinds === undefined || q.kinds.includes(e.kind)) && (q.since === undefined || e.created_at >= q.since),
    );
  }

  async purgeBefore(createdAt: number, kinds: number[]): Promise<number> {
    let n = 0;
    for (const [id, e] of this.#events) {
      if (e.created_at < createdAt && kinds.includes(e.kind)) {
        this.#events.delete(id);
        n++;
      }
    }
    return n;
  }
}
