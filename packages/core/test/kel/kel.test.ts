import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { certOf, certTags, SESSION_LIFETIME_SEC, verifyCert, type SessionCert } from '../../src/kel/cert.js';
import { kelEventTemplate, parseKelEvent } from '../../src/kel/event.js';
import {
  canonicalJson,
  DEVICE_LIFETIME_SEC,
  deviceId,
  deviceValidAt,
  digestOf,
  evaluateKel,
  verifyKeySig,
  type KelInput,
  type KeyRef,
} from '../../src/kel/kel.js';
import { icp, ixn, newDevice, newNextKey, rot, signed } from '../helpers/kel.js';

const T0 = 1_800_000_000;
const DAY = 86400;

function setup() {
  const a = newDevice(T0, 'phone');
  const next = newNextKey();
  const body = icp([a.record], { keys: [next.pub], threshold: 1 });
  const aid = digestOf(body);
  const inputs: KelInput[] = [{ entry: signed(body, [a]), at: T0 }];
  return { a, next, aid, inputs };
}

describe('canonicalJson', () => {
  it('sorts keys at every level and rejects non-integers', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
  });
});

describe('evaluateKel', () => {
  it('accepts an inception signed by its devices', () => {
    const { a, aid, inputs } = setup();
    const s = evaluateKel(aid, inputs)!;
    expect(s.sn).toBe(0);
    expect(deviceValidAt(s, a.record.id, T0)).toBe(true);
    expect(deviceValidAt(s, a.record.id, T0 + DEVICE_LIFETIME_SEC)).toBe(false);
  });

  it('rejects an inception that a listed device did not sign', () => {
    const a = newDevice(T0);
    const b = newDevice(T0);
    const body = icp([a.record, b.record], { keys: [newNextKey().pub], threshold: 1 });
    expect(evaluateKel(digestOf(body), [{ entry: signed(body, [a]), at: T0 }])).toBeNull();
  });

  it('rejects a device registered for longer than the limit', () => {
    const a = newDevice(T0, 'x', DEVICE_LIFETIME_SEC + 1);
    const body = icp([a.record], { keys: [newNextKey().pub], threshold: 1 });
    expect(evaluateKel(digestOf(body), [{ entry: signed(body, [a]), at: T0 }])).toBeNull();
  });

  it('adds, renews and revokes devices with interaction events', () => {
    const { a, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const b = newDevice(T0 + DAY, 'pc');
    const add = ixn(aid, 1, s0.tip, { add: [b.record] });
    inputs.push({ entry: signed(add, [a]), at: T0 + DAY });
    const s1 = evaluateKel(aid, inputs)!;
    expect(deviceValidAt(s1, b.record.id, T0 + DAY)).toBe(true);

    const renewAt = T0 + 70 * DAY;
    const renew = ixn(aid, 2, s1.tip, { renew: [{ id: a.record.id, expiresAt: renewAt + DEVICE_LIFETIME_SEC }] });
    inputs.push({ entry: signed(renew, [b]), at: renewAt });
    const s2 = evaluateKel(aid, inputs)!;
    expect(deviceValidAt(s2, a.record.id, T0 + 120 * DAY)).toBe(true);

    const revokeAt = T0 + 80 * DAY;
    const revoke = ixn(aid, 3, s2.tip, { revoke: [a.record.id] });
    inputs.push({ entry: signed(revoke, [b]), at: revokeAt });
    const s3 = evaluateKel(aid, inputs)!;
    expect(deviceValidAt(s3, a.record.id, revokeAt - 1)).toBe(true);
    expect(deviceValidAt(s3, a.record.id, revokeAt)).toBe(false);
  });

  it('ignores an interaction signed by a revoked or expired device', () => {
    const { a, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const late = ixn(aid, 1, s0.tip, { add: [newDevice(T0 + DEVICE_LIFETIME_SEC).record] });
    inputs.push({ entry: signed(late, [a]), at: T0 + DEVICE_LIFETIME_SEC });
    expect(evaluateKel(aid, inputs)!.sn).toBe(0);
  });

  it('ignores an interaction dated before the previous event', () => {
    const { a, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const back = ixn(aid, 1, s0.tip, { add: [newDevice(T0 - 10).record] });
    inputs.push({ entry: signed(back, [a]), at: T0 - 10 });
    expect(evaluateKel(aid, inputs)!.sn).toBe(0);
  });

  it('rotates to new devices with the next key and closes the old ones', () => {
    const { a, next, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const fresh = newDevice(T0 + DAY);
    const next2 = newNextKey();
    const r = rot(aid, 1, s0.tip, [fresh.record], { keys: [next2.pub], threshold: 1 });
    inputs.push({ entry: signed(r, [next]), at: T0 + DAY });
    const s1 = evaluateKel(aid, inputs)!;
    expect(s1.next.keys).toEqual([next2.pub]);
    expect(deviceValidAt(s1, a.record.id, T0 + DAY)).toBe(false);
    expect(deviceValidAt(s1, fresh.record.id, T0 + DAY)).toBe(true);
  });

  it('needs the threshold of next keys to rotate', () => {
    const a = newDevice(T0);
    const [k1, k2, k3] = [newNextKey(), newNextKey(), newNextKey()];
    const body = icp([a.record], { keys: [k1.pub, k2.pub, k3.pub], threshold: 2 });
    const aid = digestOf(body);
    const inputs: KelInput[] = [{ entry: signed(body, [a]), at: T0 }];
    const r = rot(aid, 1, digestOf(body), [newDevice(T0 + 1).record], { keys: [newNextKey().pub], threshold: 1 });
    expect(evaluateKel(aid, [...inputs, { entry: signed(r, [k1]), at: T0 + 1 }])!.sn).toBe(0);
    expect(evaluateKel(aid, [...inputs, { entry: signed(r, [k1, k3]), at: T0 + 1 }])!.sn).toBe(1);
  });

  it('lets a rotation supersede interactions at and after its number, even when seen later', () => {
    const { a, next, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    // 盗まれた端末 a が、攻撃者の端末を足し、本人の端末を消すまでを先に出す
    const evil = newDevice(T0 + 10, 'evil');
    const i1 = ixn(aid, 1, s0.tip, { add: [evil.record] });
    const i2 = ixn(aid, 2, digestOf(i1), { revoke: [a.record.id] });
    const fresh = newDevice(T0 + 20);
    const r = rot(aid, 1, s0.tip, [fresh.record], { keys: [newNextKey().pub], threshold: 1 });
    const s = evaluateKel(aid, [
      ...inputs,
      { entry: signed(i1, [a]), at: T0 + 10 },
      { entry: signed(i2, [evil]), at: T0 + 11 },
      { entry: signed(r, [next]), at: T0 + 20 },
    ])!;
    expect(s.sn).toBe(1);
    expect(s.devices.has(evil.record.id)).toBe(false);
    expect(deviceValidAt(s, fresh.record.id, T0 + 20)).toBe(true);
  });

  it('keeps the first seen rotation when two rotations share a number', () => {
    const { next, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const d1 = newDevice(T0 + 5);
    const d2 = newDevice(T0 + 5);
    const r1 = rot(aid, 1, s0.tip, [d1.record], { keys: [newNextKey().pub], threshold: 1 });
    const r2 = rot(aid, 1, s0.tip, [d2.record], { keys: [newNextKey().pub], threshold: 1 });
    const e1 = { entry: signed(r1, [next]), at: T0 + 5 };
    const e2 = { entry: signed(r2, [next]), at: T0 + 5 };
    expect(evaluateKel(aid, [...inputs, e1, e2])!.devices.has(d1.record.id)).toBe(true);
    expect(evaluateKel(aid, [...inputs, e2, e1])!.devices.has(d2.record.id)).toBe(true);
  });

  it('keeps the first seen interaction when two interactions share a number', () => {
    const { a, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const d1 = newDevice(T0 + 5);
    const d2 = newDevice(T0 + 5);
    const e1 = { entry: signed(ixn(aid, 1, s0.tip, { add: [d1.record] }), [a]), at: T0 + 5 };
    const e2 = { entry: signed(ixn(aid, 1, s0.tip, { add: [d2.record] }), [a]), at: T0 + 5 };
    const s = evaluateKel(aid, [...inputs, e1, e2])!;
    expect(s.devices.has(d1.record.id)).toBe(true);
    expect(s.devices.has(d2.record.id)).toBe(false);
  });

  it('treats a rotation to an empty next set as abandonment', () => {
    const { a, next, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const r = rot(aid, 1, s0.tip, [], { keys: [], threshold: 0 });
    inputs.push({ entry: signed(r, [next]), at: T0 + 1 });
    const s1 = evaluateKel(aid, inputs)!;
    expect(s1.abandoned).toBe(true);
    expect(deviceValidAt(s1, a.record.id, T0 + 1)).toBe(false);
    const after = ixn(aid, 2, s1.tip, { add: [newDevice(T0 + 2).record] });
    inputs.push({ entry: signed(after, [a]), at: T0 + 2 });
    expect(evaluateKel(aid, inputs)!.sn).toBe(1);
  });

  it('applies events whose prior arrives later in the input', () => {
    const { a, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const i1 = ixn(aid, 1, s0.tip, { add: [newDevice(T0 + 1).record] });
    const i2 = ixn(aid, 2, digestOf(i1), { renew: [{ id: a.record.id, expiresAt: T0 + 2 + DAY }] });
    const s = evaluateKel(aid, [
      ...inputs,
      { entry: signed(i2, [a]), at: T0 + 2 },
      { entry: signed(i1, [a]), at: T0 + 1 },
    ])!;
    expect(s.sn).toBe(2);
  });
});

describe('verifyKeySig', () => {
  it('verifies a WebCrypto ECDSA P-256 signature', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const key: KeyRef = { type: 'p256', pub: bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))) };
    const digest = digestOf({ hello: 'world' });
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, hexToBytes(digest)));
    expect(verifyKeySig(key, digest, { signer: deviceId(key), p256: bytesToHex(sig) })).toBe(true);
    expect(verifyKeySig(key, digestOf({ hello: 'x' }), { signer: deviceId(key), p256: bytesToHex(sig) })).toBe(false);
  });
});

describe('session certificates', () => {
  function issue(dev: ReturnType<typeof newDevice>, aid: string, from: number, until = from + SESSION_LIFETIME_SEC) {
    const sk = generateSecretKey();
    const cert: SessionCert = { v: 1, aid, device: dev.record.id, session: getPublicKey(sk), tip: '', from, until };
    return { sk, signedCert: { cert, sig: dev.sign(digestOf(cert)) } };
  }

  it('accepts events signed during the certificate period by a valid device', () => {
    const { a, aid, inputs } = setup();
    const s = evaluateKel(aid, inputs)!;
    const { sk, signedCert } = issue(a, aid, T0 + 100);
    const ev = finalizeEvent({ kind: 3752, created_at: T0 + 200, tags: certTags(signedCert), content: '' }, sk);
    expect(verifyCert(s, certOf(ev)!, ev)).toBe(true);
    expect(verifyCert(s, signedCert, { ...ev, created_at: T0 + 100 + SESSION_LIFETIME_SEC + 1 })).toBe(false);
    expect(verifyCert(s, signedCert, { ...ev, pubkey: getPublicKey(generateSecretKey()) })).toBe(false);
  });

  it('rejects a certificate longer than one day', () => {
    const { a, aid, inputs } = setup();
    const s = evaluateKel(aid, inputs)!;
    const { signedCert } = issue(a, aid, T0, T0 + SESSION_LIFETIME_SEC + 1);
    expect(verifyCert(s, signedCert, { pubkey: signedCert.cert.session, created_at: T0 + 1 })).toBe(false);
  });

  it('keeps certificates issued before a revocation until they expire, and rejects later ones', () => {
    const { a, aid, inputs } = setup();
    const s0 = evaluateKel(aid, inputs)!;
    const b = newDevice(T0);
    inputs.push({ entry: signed(ixn(aid, 1, s0.tip, { add: [b.record] }), [a]), at: T0 + 1 });
    const s1 = evaluateKel(aid, inputs)!;
    const revokeAt = T0 + 1000;
    inputs.push({ entry: signed(ixn(aid, 2, s1.tip, { revoke: [a.record.id] }), [b]), at: revokeAt });
    const s2 = evaluateKel(aid, inputs)!;
    const before = issue(a, aid, revokeAt - 1).signedCert;
    const after = issue(a, aid, revokeAt).signedCert;
    expect(verifyCert(s2, before, { pubkey: before.cert.session, created_at: revokeAt + 3600 })).toBe(true);
    expect(verifyCert(s2, after, { pubkey: after.cert.session, created_at: revokeAt + 1 })).toBe(false);
  });
});

describe('KEL events on Nostr', () => {
  it('round-trips an entry through a kind 3753 event', () => {
    const { aid, inputs } = setup();
    const ev = finalizeEvent(kelEventTemplate(inputs[0]!.entry, T0), generateSecretKey());
    const parsed = parseKelEvent(ev)!;
    expect(parsed.aid).toBe(aid);
    expect(evaluateKel(aid, [parsed.input])!.sn).toBe(0);
    expect(parseKelEvent({ ...ev, tags: [['aid', 'x']] })).toBeNull();
  });
});
