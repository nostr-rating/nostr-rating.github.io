import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { openEventStore } from '../src/storage/db.js';
import { MemoryEventStore } from '../src/storage/memory.js';

const sk = generateSecretKey();
const ev = (kind: number, at: number) => finalizeEvent({ kind, created_at: at, tags: [], content: String(at) }, sk);

describe('event store', () => {
  test('falls back to memory storage when OPFS is unavailable', async () => {
    const store = await openEventStore();
    expect(store.persistent).toBe(false);
  });

  test('memory store put/query/purge', async () => {
    const s = new MemoryEventStore();
    const a = ev(3752, 100);
    const b = ev(3754, 200);
    await s.put([a, b, a]);
    expect((await s.query({})).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect((await s.query({ kinds: [3754] })).map((e) => e.id)).toEqual([b.id]);
    expect((await s.query({ since: 150 })).map((e) => e.id)).toEqual([b.id]);
    expect(await s.purgeBefore(150, [3754])).toBe(0);
    expect(await s.purgeBefore(150, [3752, 3754])).toBe(1);
    expect((await s.query({})).map((e) => e.id)).toEqual([b.id]);
  });
});
