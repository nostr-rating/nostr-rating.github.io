import { describe, expect, test } from 'vitest';
import { openWorkerEventStore, StorageInUseError, type WorkerLike } from '../src/storage/db.js';

/**
 * opfs-sahpool はファイルを1つの Worker しか開けない。偽の Worker で、ファイルをつかむ・手放すことを真似る
 */
class FakeOpfs {
  holder: FakeWorker | null = null;
  rows: unknown[] = [];
  created: FakeWorker[] = [];
  create = (): WorkerLike => {
    const w = new FakeWorker(this);
    this.created.push(w);
    return w;
  };
}

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  terminated = false;
  constructor(private opfs: FakeOpfs) {}
  postMessage(m: { id: number; op: string; args?: unknown }): void {
    queueMicrotask(() => {
      if (this.terminated) return;
      const reply = (data: object) => this.onmessage?.({ data: { id: m.id, ...data } } as MessageEvent);
      if (m.op === 'init') {
        if (this.opfs.holder && this.opfs.holder !== this) return reply({ ok: false, error: 'NoModificationAllowedError: Access Handles cannot be created' });
        this.opfs.holder = this;
        return reply({ ok: true, result: null });
      }
      if (this.opfs.holder !== this) return reply({ ok: false, error: 'not open' });
      if (m.op === 'put') this.opfs.rows.push(...(m.args as unknown[]));
      return reply({ ok: true, result: m.op === 'query' ? this.opfs.rows : null });
    });
  }
  terminate(): void {
    this.terminated = true;
    if (this.opfs.holder === this) this.opfs.holder = null;
  }
}

const pageEvent = (type: 'pagehide' | 'pageshow', persisted: boolean) => Object.assign(new Event(type), { persisted });

describe('event store and the back/forward cache', () => {
  test('a page entering the back/forward cache lets go of the file, so a new page can open it', async () => {
    const opfs = new FakeOpfs();
    const pageA = new EventTarget();
    const a = await openWorkerEventStore({ createWorker: opfs.create, target: pageA, retryDelaysMs: [] });
    expect(a.persistent).toBe(true);
    // ヘルプへ移ると、前のページは戻る・進むキャッシュに入る
    pageA.dispatchEvent(pageEvent('pagehide', true));
    // 左上のリンクで戻ると、新しいページが同じファイルを開く
    const b = await openWorkerEventStore({ createWorker: opfs.create, target: new EventTarget(), retryDelaysMs: [] });
    expect(b.persistent).toBe(true);
  });

  test('a page restored from the cache opens the file again and sends what was waiting', async () => {
    const opfs = new FakeOpfs();
    const page = new EventTarget();
    const s = await openWorkerEventStore({ createWorker: opfs.create, target: page, retryDelaysMs: [] });
    page.dispatchEvent(pageEvent('pagehide', true));
    const put = s.put([{ id: 'x' } as never]);
    page.dispatchEvent(pageEvent('pageshow', true));
    await put;
    expect([opfs.created.length, opfs.rows, s.persistent]).toEqual([2, [{ id: 'x' }], true]);
  });

  test('waits for the previous page to let go before giving up', async () => {
    const opfs = new FakeOpfs();
    const old = opfs.create() as FakeWorker;
    opfs.holder = old;
    setTimeout(() => old.terminate(), 20);
    const s = await openWorkerEventStore({ createWorker: opfs.create, target: new EventTarget(), retryDelaysMs: [10, 50] });
    expect(s.persistent).toBe(true);
  });

  test('another tab keeps the file: the store says so instead of falling back to memory', async () => {
    const opfs = new FakeOpfs();
    opfs.holder = opfs.create() as FakeWorker;
    await expect(openWorkerEventStore({ createWorker: opfs.create, target: new EventTarget(), retryDelaysMs: [1, 1] })).rejects.toBeInstanceOf(StorageInUseError);
    // 開けなかった Worker は止める
    expect(opfs.created.slice(1).map((w) => (w as FakeWorker).terminated)).toEqual([true, true, true]);
  });

  test('other failures are not reported as another tab', async () => {
    const failing = (): WorkerLike => {
      const w: WorkerLike = { onmessage: null, terminate: () => {}, postMessage: (m: { id: number }) => queueMicrotask(() => w.onmessage?.({ data: { id: m.id, ok: false, error: 'SecurityError: no OPFS' } } as MessageEvent)) };
      return w;
    };
    const e = await openWorkerEventStore({ createWorker: failing, target: new EventTarget(), retryDelaysMs: [1] }).catch((x: unknown) => x);
    expect([e instanceof StorageInUseError, String(e)]).toEqual([false, 'Error: SecurityError: no OPFS']);
  });

  test('a page restored from the cache while another tab holds the file reports it', async () => {
    const opfs = new FakeOpfs();
    const page = new EventTarget();
    const inUse: string[] = [];
    await openWorkerEventStore({ createWorker: opfs.create, target: page, retryDelaysMs: [1], onInUse: () => inUse.push('in use') });
    page.dispatchEvent(pageEvent('pagehide', true));
    // キャッシュに入っている間に、別のタブがファイルを開く
    await openWorkerEventStore({ createWorker: opfs.create, target: new EventTarget(), retryDelaysMs: [] });
    page.dispatchEvent(pageEvent('pageshow', true));
    await new Promise((r) => setTimeout(r, 20));
    expect(inUse).toEqual(['in use']);
  });
});
