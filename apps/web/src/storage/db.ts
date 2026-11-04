import type { NostrEvent } from 'nostr-tools/pure';
import { MemoryEventStore } from './memory.js';
import type { EventQuery, EventStore } from './types.js';

export type { EventStore } from './types.js';

export type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & { onmessage: ((e: MessageEvent) => void) | null };

interface Pending {
  op: string;
  args: unknown;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** 前のページの Worker がファイルを手放すまで待つ間隔。opfs-sahpool はファイルを1つの Worker しか開けない */
const RETRY_DELAYS_MS = [100, 300, 1000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 保存先のファイルをほかの Worker が開いている。待っても手放されなければ、別のタブで開いている。
 * そのタブと同時には使えないので、メモリに切り替えず、画面でそう伝える
 */
export class StorageInUseError extends Error {
  constructor(cause: unknown) {
    super('the storage is open in another tab', { cause });
    this.name = 'StorageInUseError';
  }
}

const inUse = (e: unknown) => String(e).includes('NoModificationAllowedError');

/**
 * Worker 内の SQLite（opfs-sahpool）に保存する。ページが戻る・進むキャッシュに入るときは Worker を止めてファイルを手放し
 * （残したままだと、リンクで開き直した新しいページが開けない）、キャッシュから戻ったら開き直す。その間の呼び出しは待たせる
 */
class WorkerEventStore implements EventStore {
  #worker: WorkerLike | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  /** 開き直せなかったときは、メモリに切り替える */
  #fallback: MemoryEventStore | null = null;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly retryDelaysMs: number[],
    private readonly onInUse: () => void,
  ) {}

  get persistent(): boolean {
    return this.#fallback === null;
  }

  /**
   * Worker を作って開く。ファイルがほかの Worker に開かれていれば、前のページの分が片付くのを待ってやり直し、
   * それでも開けなければ StorageInUseError。ほかの失敗はやり直さない
   */
  async open(): Promise<void> {
    let last: unknown;
    for (const delay of [0, ...this.retryDelaysMs]) {
      if (delay > 0) await sleep(delay);
      const worker = this.createWorker();
      try {
        await new Promise<void>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<{ ok: boolean; error?: string }>) => (e.data.ok ? resolve() : reject(new Error(e.data.error)));
          worker.postMessage({ id: 0, op: 'init' });
        });
      } catch (e) {
        worker.terminate();
        if (!inUse(e)) throw e;
        last = e;
        continue;
      }
      worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => this.#settle(e.data);
      this.#worker = worker;
      for (const [id, p] of this.#pending) this.#send(id, p);
      return;
    }
    throw new StorageInUseError(last);
  }

  /** 戻る・進むキャッシュに入るとき。返事を待っている呼び出しは、開き直してから送り直す */
  suspend(): void {
    this.#worker?.terminate();
    this.#worker = null;
    for (const p of this.#pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
    }
  }

  resume(): void {
    if (this.#worker || this.#fallback) return;
    this.open().catch((e) => {
      if (e instanceof StorageInUseError) {
        // キャッシュに入っている間に、別のタブが開いた。返事を待っている呼び出しは、そのまま待たせる
        this.onInUse();
        return;
      }
      console.warn('OPFS storage unavailable after restoring the page, falling back to memory', e);
      this.#fallback = new MemoryEventStore();
      const waiting = [...this.#pending.values()];
      this.#pending.clear();
      for (const p of waiting) this.#runOnFallback(p.op, p.args).then(p.resolve, p.reject);
    });
  }

  #settle(d: { id: number; ok: boolean; result?: unknown; error?: string }): void {
    const p = this.#pending.get(d.id);
    if (!p) return;
    this.#pending.delete(d.id);
    if (p.timer) clearTimeout(p.timer);
    if (d.ok) p.resolve(d.result);
    else p.reject(new Error(d.error));
  }

  #send(id: number, p: Pending): void {
    p.timer = setTimeout(() => {
      this.#pending.delete(id);
      p.reject(new Error(`storage ${p.op} timed out`));
    }, p.timeoutMs);
    this.#worker!.postMessage({ id, op: p.op, args: p.args });
  }

  #runOnFallback(op: string, args: any): Promise<unknown> {
    const m = this.#fallback!;
    if (op === 'put') return m.put(args);
    if (op === 'query') return m.query(args);
    return m.purgeBefore(args.createdAt, args.kinds);
  }

  call<T>(op: string, args?: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.#fallback) return this.#runOnFallback(op, args) as Promise<T>;
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { op, args, timeoutMs, timer: null, resolve: resolve as (v: unknown) => void, reject };
      this.#pending.set(id, p);
      if (this.#worker) this.#send(id, p);
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
 * Worker の保存先を開き、ページが戻る・進むキャッシュに出入りするのに合わせて手放す・開き直す。
 * 別のタブが開いていれば StorageInUseError、ほかの理由で開けなければその例外
 */
export async function openWorkerEventStore(o: {
  createWorker: () => WorkerLike;
  target: Pick<EventTarget, 'addEventListener'>;
  retryDelaysMs?: number[];
  /** キャッシュから戻ったときに、別のタブが開いていて開き直せなかった */
  onInUse?: () => void;
}): Promise<EventStore> {
  const store = new WorkerEventStore(o.createWorker, o.retryDelaysMs ?? RETRY_DELAYS_MS, o.onInUse ?? (() => {}));
  await store.open();
  o.target.addEventListener('pagehide', (e) => {
    if ((e as PageTransitionEvent).persisted) store.suspend();
  });
  o.target.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) store.resume();
  });
  return store;
}

/**
 * OPFS が使えれば Worker 内の SQLite に保存する。使えない（プライベートブラウズ等）か
 * 初期化に失敗したら、メモリ内に切り替える（persistent: false）。別のタブで開いていれば StorageInUseError
 */
export async function openEventStore(onInUse: () => void): Promise<EventStore> {
  const hasOpfs = typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  if (!hasOpfs || typeof Worker === 'undefined') return new MemoryEventStore();
  try {
    const store = await openWorkerEventStore({
      createWorker: () => new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' }),
      target: window,
      onInUse,
    });
    await navigator.storage.persist?.().catch(() => false);
    return store;
  } catch (e) {
    if (e instanceof StorageInUseError) throw e;
    console.warn('OPFS storage unavailable, falling back to memory', e);
    return new MemoryEventStore();
  }
}
