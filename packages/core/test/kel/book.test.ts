import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools/pure';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isValidEvent } from '../../src/events/kinds.js';
import { buildKelBook, KelBook } from '../../src/kel/book.js';
import { kelEventTemplate } from '../../src/kel/event.js';
import { digestOf } from '../../src/kel/kel.js';
import { newUser, registeredKels } from '../helpers/keys.js';
import { ixn, newDevice, signed } from '../helpers/kel.js';

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

beforeEach(() => {
  counts.p256 = 0;
  counts.event = 0;
});

describe('KelBook', () => {
  test('does not check the signatures of recorded KELs until one is used', () => {
    const [a, b] = [newUser(), newUser()];
    const book = buildKelBook(registeredKels(), [], -Infinity, Infinity);
    expect(book.records[a.pk]).toEqual(registeredKels()[a.pk]);
    expect(counts.p256).toBe(0);
    expect(book.states.get(a.pk)?.aid).toBe(a.pk);
    const one = counts.p256;
    expect(one).toBeGreaterThan(0);
    expect(book.states.get(b.pk)?.aid).toBe(b.pk);
    expect(counts.p256).toBe(2 * one);
  });

  test('checks each signature once, even across books', () => {
    const a = newUser();
    buildKelBook(registeredKels(), [], -Infinity, Infinity).states.get(a.pk);
    const first = counts.p256;
    buildKelBook(registeredKels(), [], -Infinity, Infinity).states.get(a.pk);
    expect(counts.p256).toBe(first);
  });

  test('re-evaluates only the accounts that got new events', () => {
    const [a, b] = [newUser(), newUser()];
    const book = new KelBook(registeredKels(), -Infinity, Infinity);
    const before = book.states.get(b.pk);
    const added = newDevice(T0 + 10);
    const tip = registeredKels()[a.pk]!.at(-1)!;
    // a の端末を足す ixn は、a の最初の端末の鍵では署名できないので、a の KEL を作り直す代わりに別の端末で署名して捨てられることを見る
    const bad = signed(ixn(a.pk, 1, digestOf(tip.entry.body), { add: [added.record] }), [added]);
    book.add([finalizeEvent(kelEventTemplate(bad, T0 + 10), generateSecretKey())]);
    expect(book.states.get(b.pk)).toBe(before);
    expect(book.states.get(a.pk)?.sn).toBe(0);
  });

  test('notices a recorded KEL whose signatures do not hold', () => {
    const a = newUser();
    const kels = registeredKels();
    const forged = structuredClone(kels[a.pk]!);
    const sig = forged[0]!.entry.sigs[0]!;
    if ('p256' in sig) sig.p256 = sig.p256.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    expect(() => new KelBook({ ...kels, [a.pk]: forged }, -Infinity, Infinity).verifyRecorded()).toThrow(a.pk);
    expect(() => new KelBook(kels, -Infinity, Infinity).verifyRecorded()).not.toThrow();
  });
});

describe('isValidEvent', () => {
  test('checks the signature of the same event once, even when it arrives as a new object', () => {
    const ev = finalizeEvent({ kind: 1, created_at: T0, tags: [], content: 'x' }, generateSecretKey());
    const copy = () => JSON.parse(JSON.stringify(ev)) as NostrEvent;
    expect([isValidEvent(copy()), isValidEvent(copy())]).toEqual([true, true]);
    expect(counts.event).toBe(1);
  });

  test('still rejects a copy whose content or signature was changed', () => {
    const ev = finalizeEvent({ kind: 1, created_at: T0, tags: [], content: 'x' }, generateSecretKey());
    const other = finalizeEvent({ kind: 1, created_at: T0, tags: [], content: 'y' }, generateSecretKey());
    expect(isValidEvent(JSON.parse(JSON.stringify(ev)))).toBe(true);
    expect(isValidEvent({ ...JSON.parse(JSON.stringify(ev)), content: 'y' })).toBe(false);
    expect(isValidEvent({ ...JSON.parse(JSON.stringify(ev)), sig: other.sig })).toBe(false);
  });
});
