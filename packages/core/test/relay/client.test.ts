import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { queryUntilEose, withRetries, type EoseRelay } from '../../src/relay/client.js';

const ev = (n: number) => ({ id: String(n).padStart(64, '0') }) as NostrEvent;

/** リレーの代わり。REQ を受けたら script のとおりに返す */
function fakeRelay(script: (p: Parameters<EoseRelay['subscribe']>[1]) => void): EoseRelay & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    subscribe(_filters, params) {
      setTimeout(() => script(params), 0);
      return {
        close(reason = 'closed by caller') {
          closed.push(reason);
          params.onclose?.(reason);
        },
      };
    },
  };
}

describe('queryUntilEose', () => {
  test('returns the events sent before EOSE', async () => {
    const relay = fakeRelay((p) => {
      p.onevent?.(ev(1));
      p.onevent?.(ev(2));
      p.oneose?.();
    });
    expect(await queryUntilEose(relay, {}, 1000)).toEqual([ev(1), ev(2)]);
    expect(relay.closed).toEqual(['closed by caller']);
  });

  test('fails when EOSE does not come in time instead of returning what arrived', async () => {
    const relay = fakeRelay((p) => p.onevent?.(ev(1)));
    await expect(queryUntilEose(relay, {}, 50)).rejects.toThrow('no EOSE within 50ms');
    expect(relay.closed).toEqual(['closed by caller']);
  });

  test('fails when the relay closes the subscription before EOSE', async () => {
    const relay = fakeRelay((p) => {
      p.onevent?.(ev(1));
      p.onclose?.('rate-limited: slow down');
    });
    await expect(queryUntilEose(relay, {}, 1000)).rejects.toThrow('closed before EOSE: rate-limited: slow down');
  });
});

describe('withRetries', () => {
  test('tries again after a failure and returns the first success', async () => {
    let calls = 0;
    const result = await withRetries(async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return 'ok';
    }, 3, 1);
    expect([result, calls]).toEqual(['ok', 3]);
  });

  test('gives up with the last error', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      }, 3, 1),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });
});
