import type { NostrEvent } from 'nostr-tools/pure';
import { MemoryEventStore } from './memory.js';
import type { EventQuery, EventStore } from './types.js';

export type { EventStore } from './types.js';

class WorkerEventStore implements EventStore {
  readonly persistent = true;
  #worker: Worker;
  #seq = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.#pending.get(e.data.id);
      if (!p) return;
      this.#pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  call<T>(op: string, args?: unknown, timeoutMs = 10_000): Promise<T> {
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`storage ${op} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#worker.postMessage({ id, op, args });
    });
  }

  put(evs: NostrEvent[]): Promise<void> {
    return this.call('put', evs);
  }
  query(q: EventQuery): Promise<NostrEvent[]> {
    return this.call('query', q);
  }
  purgeBefore(createdAt: number, kinds: number[]): Promise<number> {
    return this.call('purge', { createdAt, kinds });
  }
}

/**
 * OPFS が使えれば Worker 内の SQLite に保存する。使えない（プライベートブラウズ等）か
 * 初期化に失敗したら、メモリ内に切り替える（persistent: false）。
 */
export async function openEventStore(): Promise<EventStore> {
  const hasOpfs = typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  if (!hasOpfs || typeof Worker === 'undefined') return new MemoryEventStore();
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });
    const store = new WorkerEventStore(worker);
    await store.call('init');
    await navigator.storage.persist?.().catch(() => false);
    return store;
  } catch (e) {
    console.warn('OPFS storage unavailable, falling back to memory', e);
    worker?.terminate();
    return new MemoryEventStore();
  }
}
