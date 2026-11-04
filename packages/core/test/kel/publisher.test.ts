import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { SESSION_LIFETIME_SEC, verifyCert, type SessionCert, type SignedCert } from '../../src/kel/cert.js';
import { attestationTemplate, deviceValidAt, digestOf, evaluateKel, type KelInput, type KelSig } from '../../src/kel/kel.js';
import { icp, ixn, newDevice, newNextKey, newSignerAppDevice, signed } from '../helpers/kel.js';

const T0 = 1_800_000_000;

/** 署名アプリの端末で作ったアカウント */
function setup() {
  const ext = newSignerAppDevice(T0);
  const body = icp([ext.record], { keys: [newNextKey().pub], threshold: 1 });
  const aid = digestOf(body);
  const inputs: KelInput[] = [{ entry: signed(body, [ext.device, ext.publisher]), at: T0 }];
  return { ext, aid, inputs };
}

describe('a signer-app device also needs its publisher key (docs/adr/0016)', () => {
  it('accepts an inception signed by the signer app and the publisher key', () => {
    const { ext, aid, inputs } = setup();
    expect(deviceValidAt(evaluateKel(aid, inputs)!, ext.record.id, T0)).toBe(true);
  });

  it('rejects an inception signed only by the signer app', () => {
    const ext = newSignerAppDevice(T0);
    const body = icp([ext.record], { keys: [newNextKey().pub], threshold: 1 });
    expect(evaluateKel(digestOf(body), [{ entry: signed(body, [ext.device]), at: T0 }])).toBeNull();
  });

  it('rejects a device whose publisher key is the device key itself', () => {
    const ext = newSignerAppDevice(T0);
    const record = { ...ext.record, publisher: ext.record.key.pub };
    const body = icp([record], { keys: [newNextKey().pub], threshold: 1 });
    const self = { sign: (d: string): KelSig => ({ ...ext.device.sign(d), signer: record.publisher }) };
    expect(evaluateKel(digestOf(body), [{ entry: signed(body, [ext.device, self]), at: T0 }])).toBeNull();
  });

  it('another site that gets the signer app to sign the digest cannot add its own device', () => {
    const { ext, aid, inputs } = setup();
    const attacker = newDevice(T0 + 10, 'attacker');
    const body = ixn(aid, 1, aid, { add: [attacker.record], revoke: [ext.record.id] });
    // 署名アプリが出すのは content に digest を入れた kind 23753 への署名だけ。掲載用の鍵の代わりに自分の鍵で添えても足りない
    const own = generateSecretKey();
    const ownSig = { sign: (d: string): KelSig => ({ ...newSig(d, own), signer: ext.record.publisher }) };
    for (const sigs of [[ext.device], [ext.device, ownSig]]) {
      const s = evaluateKel(aid, [...inputs, { entry: signed(body, sigs), at: T0 + 10 }])!;
      expect([s.sn, deviceValidAt(s, ext.record.id, T0 + 20), s.devices.has(attacker.record.id)]).toEqual([0, true, false]);
    }
    // アプリが掲載用の鍵でも署名すれば通る
    const s = evaluateKel(aid, [...inputs, { entry: signed(body, [ext.device, ext.publisher]), at: T0 + 10 }])!;
    expect([s.sn, deviceValidAt(s, ext.record.id, T0 + 20), deviceValidAt(s, attacker.record.id, T0 + 20)]).toEqual([1, false, true]);
  });

  it('a P-256 device needs no publisher signature', () => {
    const { ext, aid, inputs } = setup();
    const phone = newDevice(T0 + 10, 'phone');
    const add = ixn(aid, 1, aid, { add: [phone.record] });
    const added = [...inputs, { entry: signed(add, [ext.device, ext.publisher]), at: T0 + 10 }];
    const renew = ixn(aid, 2, digestOf(add), { renew: [{ id: phone.record.id, expiresAt: T0 + 30 * 86400 }] });
    expect(evaluateKel(aid, [...added, { entry: signed(renew, [phone]), at: T0 + 20 }])!.sn).toBe(2);
  });

  describe('session certificates', () => {
    const certOf = (aid: string, device: string, publisher: string): SessionCert => ({
      v: 1,
      aid,
      device,
      publisher,
      session: getPublicKey(generateSecretKey()),
      tip: aid,
      from: T0,
      until: T0 + SESSION_LIFETIME_SEC,
    });

    it('needs the publisher signature recorded in the KEL, not the one the certificate names', () => {
      const { ext, aid, inputs } = setup();
      const state = evaluateKel(aid, inputs)!;
      const other = generateSecretKey();
      const cases: [string, (c: SessionCert) => SignedCert][] = [
        ['both', (c) => ({ cert: c, sig: ext.device.sign(digestOf(c)), publisherSig: ext.publisher.sign(digestOf(c)) })],
        ['signer app only', (c) => ({ cert: c, sig: ext.device.sign(digestOf(c)) })],
        ['another key named in the certificate', (c) => ({ cert: c, sig: ext.device.sign(digestOf(c)), publisherSig: newSig(digestOf(c), other) })],
      ];
      const got = cases.map(([name, make]) => {
        const publisher = name === 'another key named in the certificate' ? getPublicKey(other) : ext.record.publisher;
        const signedCert = make(certOf(aid, ext.record.id, publisher));
        return [name, verifyCert(state, signedCert, { pubkey: signedCert.cert.session, created_at: T0 + 1 })];
      });
      expect(got).toEqual([
        ['both', true],
        ['signer app only', false],
        ['another key named in the certificate', false],
      ]);
    });
  });
});

function newSig(digest: string, sk: Uint8Array): KelSig {
  const ev = finalizeEvent(attestationTemplate(digest, T0), sk);
  return { signer: ev.pubkey, created_at: ev.created_at, sig: ev.sig };
}

