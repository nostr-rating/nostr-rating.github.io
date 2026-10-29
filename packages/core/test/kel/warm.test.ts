import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools/pure';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { isValidEvent } from '../../src/events/kinds.js';
import { initFastVerify } from '../../src/events/fast.js';
import { evaluateKel } from '../../src/kel/kel.js';
import { warmKelSignatures } from '../../src/kel/warm.js';
import { newUser, registeredKels } from '../helpers/keys.js';

const counts = vi.hoisted(() => ({ p256: 0, event: 0 }));

vi.mock('@noble/curves/nist.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@noble/curves/nist.js')>();
  const verify: typeof orig.p256.verify = (...args) => {
    counts.p256++;
    return orig.p256.verify(...args);
  };
  return { ...orig, p256: { ...orig.p256, verify } };
});

vi.mock('nostr-tools/pure', async (importOriginal) => {
  const orig = await importOriginal<typeof import('nostr-tools/pure')>();
  return {
    ...orig,
    verifyEvent: (ev: NostrEvent) => {
      counts.event++;
      return orig.verifyEvent(ev);
    },
  };
});

const T0 = 1_789_000_000;

beforeAll(async () => {
  await initFastVerify();
});

beforeEach(() => {
  counts.p256 = 0;
  counts.event = 0;
});

describe('fast verification', () => {
  test('checks Nostr events without the slow implementation once the fast one is loaded', () => {
    const ev = finalizeEvent({ kind: 1, created_at: T0, tags: [], content: 'x' }, generateSecretKey());
    const other = finalizeEvent({ kind: 1, created_at: T0, tags: [], content: 'y' }, generateSecretKey());
    const copy = () => JSON.parse(JSON.stringify(ev)) as NostrEvent;
    expect(isValidEvent(copy())).toBe(true);
    expect(isValidEvent({ ...copy(), content: 'z' })).toBe(false);
    expect(isValidEvent({ ...copy(), sig: other.sig })).toBe(false);
    expect(counts.event).toBe(0);
  });

  test('a KEL warmed ahead evaluates the same without the slow P-256 check', async () => {
    const a = newUser();
    a.sessionAt(T0 + 100 * 86400); // 入れ替えを1回含める
    const kel = registeredKels()[a.pk]!;
    await warmKelSignatures({ [a.pk]: kel }, [a.pk]);
    const state = evaluateKel(a.pk, kel);
    expect(counts.p256).toBe(0);
    expect(state?.digests.length).toBe(kel.length);
  });

  test('a warmed signature that does not hold is still rejected', async () => {
    const a = newUser();
    const kel = structuredClone(registeredKels()[a.pk]!);
    const sig = kel[0]!.entry.sigs[0]!;
    if ('p256' in sig) sig.p256 = sig.p256.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    await warmKelSignatures({ [a.pk]: kel }, [a.pk]);
    expect(evaluateKel(a.pk, kel)).toBeNull();
    expect(counts.p256).toBe(0);
  });
});
