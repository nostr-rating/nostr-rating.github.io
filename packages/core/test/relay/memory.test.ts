import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { MemoryRelay } from '../../src/relay/memory.js';
import { newUser } from '../helpers/keys.js';

const alice = newUser();

describe('MemoryRelay', () => {
  test('replaces addressable events with the same d tag', async () => {
    const relay = new MemoryRelay(() => 100);
    const e1 = await alice.signer.signEvent({ kind: 31751, content: '1', tags: [['d', 'x']], created_at: 10 });
    const e2 = await alice.signer.signEvent({ kind: 31751, content: '2', tags: [['d', 'x']], created_at: 20 });
    const other = await alice.signer.signEvent({ kind: 31751, content: '3', tags: [['d', 'y']], created_at: 15 });
    await relay.publish(e2);
    await relay.publish(e1); // 古いものは無視される
    await relay.publish(other);
    const got = await relay.query([{ kinds: [31751] }]);
    expect(got.map((e) => e.content).sort()).toEqual(['2', '3']);
  });

  test('replaces replaceable kinds (10011)', async () => {
    const relay = new MemoryRelay(() => 100);
    await relay.publish(await alice.signer.signEvent({ kind: 10011, content: '', tags: [], created_at: 1 }));
    await relay.publish(await alice.signer.signEvent({ kind: 10011, content: '', tags: [['i', 'github:a', 'b']], created_at: 2 }));
    expect((await relay.query([{ kinds: [10011] }])).map((e) => e.created_at)).toEqual([2]);
  });

  test('hides expired events', async () => {
    let now = 100;
    const relay = new MemoryRelay(() => now);
    await relay.publish(await alice.signer.signEvent({ kind: 1, content: '', tags: [['expiration', '150']], created_at: 100 }));
    expect(await relay.query([{ kinds: [1] }])).toHaveLength(1);
    now = 150;
    expect(await relay.query([{ kinds: [1] }])).toHaveLength(0);
  });

  test('limit returns the newest events first', async () => {
    const relay = new MemoryRelay(() => 100);
    for (const t of [1, 3, 2]) await relay.publish(await alice.signer.signEvent({ kind: 1, content: String(t), tags: [], created_at: t }));
    expect((await relay.query([{ kinds: [1], limit: 2 }])).map((e) => e.created_at)).toEqual([3, 2]);
  });

  test('rejects invalid signatures', async () => {
    const relay = new MemoryRelay(() => 0);
    const ev = await alice.signer.signEvent({ kind: 1, content: 'a', tags: [], created_at: 1 });
    await expect(relay.publish({ ...ev, content: 'b' })).rejects.toThrow();
  });

  test('subscribe receives stored and later publishes matching #e', async () => {
    const relay = new MemoryRelay(() => 0);
    const got: NostrEvent[] = [];
    const before = await alice.signer.signEvent({ kind: 3754, content: 'old', tags: [['e', 'm1']], created_at: 1 });
    await relay.publish(before);
    const close = relay.subscribe([{ kinds: [3754], '#e': ['m1'] }], (e) => got.push(e));
    await relay.publish(await alice.signer.signEvent({ kind: 3754, content: 'new', tags: [['e', 'm1']], created_at: 2 }));
    await relay.publish(await alice.signer.signEvent({ kind: 3754, content: 'other', tags: [['e', 'm2']], created_at: 3 }));
    close();
    await relay.publish(await alice.signer.signEvent({ kind: 3754, content: 'late', tags: [['e', 'm1']], created_at: 4 }));
    expect(got.map((e) => e.content)).toEqual(['old', 'new']);
  });
});
