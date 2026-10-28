import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { kelEventTemplate } from '../../src/kel/event.js';
import { deviceValidAt, digestOf, type KelInput } from '../../src/kel/kel.js';
import {
  decodeDeviceRequest,
  deviceRecordFor,
  encodeDeviceRequest,
  findAccountsByNextKeys,
  loadKel,
  recoveryRotation,
  verifyRotation,
} from '../../src/kel/recover.js';
import { newRecoveryWords, recoveryKey } from '../../src/kel/recovery.js';
import { MemoryRelay } from '../../src/relay/memory.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { icp, ixn, newDevice, signed } from '../helpers/kel.js';

const T0 = 1_790_800_000;

/** 復活の言葉を次の鍵にしたアカウントをリレーに載せる */
async function account(relay: MemoryRelay) {
  const words = newRecoveryWords();
  const phone = newDevice(T0 - 1000, 'スマホ');
  const body = icp([phone.record], { keys: [recoveryKey(words).pub], threshold: 1 }, 'x');
  const aid = digestOf(body);
  const chain: KelInput[] = [{ entry: signed(body, [phone]), at: T0 - 1000 }];
  await relay.publish(finalizeEvent(kelEventTemplate(chain[0]!.entry, T0 - 1000), phone.publisherSk));
  return { words, phone, aid, chain };
}

describe('device requests', () => {
  test('round-trip with a Japanese label and reject garbage', () => {
    const d = newDevice(T0, 'タブレット');
    const code = encodeDeviceRequest({ key: d.record.key, publisher: d.record.publisher, label: d.record.label });
    expect(decodeDeviceRequest(code)).toEqual({ key: d.record.key, publisher: d.record.publisher, label: 'タブレット' });
    expect(decodeDeviceRequest('nr-device:!!!')).toBeNull();
    expect(decodeDeviceRequest('hello')).toBeNull();
  });
});

describe('recovery', () => {
  test('finds the account from the words and rotates to a new device, closing every old one', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const a = await account(relay);
    // 攻撃者が盗んだ端末で自分の端末を足し、本人の端末を取り消した
    const evil = newDevice(T0 - 500, 'evil');
    const add = signed(ixn(a.aid, 1, digestOf(a.chain[0]!.entry.body), { add: [evil.record] }), [a.phone]);
    await relay.publish(finalizeEvent(kelEventTemplate(add, T0 - 500), a.phone.publisherSk));
    const revoke = signed(ixn(a.aid, 2, digestOf(add.body), { revoke: [a.phone.record.id] }), [evil]);
    await relay.publish(finalizeEvent(kelEventTemplate(revoke, T0 - 400), evil.publisherSk));

    const key = recoveryKey(a.words);
    expect(await findAccountsByNextKeys(relay, [key.pub])).toEqual([a.aid]);
    const { state, chain } = await loadKel(relay, a.aid);
    expect(state!.sn).toBe(2);

    const fresh = newDevice(T0, 'パソコン');
    const newWords = newRecoveryWords();
    const rec = recoveryRotation(state!, [deviceRecordFor(decodeDeviceRequest(encodeDeviceRequest({ key: fresh.record.key, publisher: fresh.record.publisher, label: 'パソコン' }))!, T0)], { keys: [recoveryKey(newWords).pub], threshold: 1 }, [key.sk], T0, [fresh.record.publisher]);
    const after = verifyRotation(a.aid, chain, rec.entry, rec.event.created_at)!;
    expect(deviceValidAt(after, fresh.record.id, T0)).toBe(true);
    expect(deviceValidAt(after, evil.record.id, T0)).toBe(false);
    expect(after.next.keys).toEqual([recoveryKey(newWords).pub]);
    // 新しい端末は p タグで待ち受けられる
    expect(rec.event.tags).toContainEqual(['p', fresh.record.publisher]);

    await relay.publish(rec.event);
    expect((await loadKel(relay, a.aid)).state!.sn).toBe(3);
    // 新しい言葉でも同じアカウントを探せる
    expect(await findAccountsByNextKeys(relay, [recoveryKey(newWords).pub])).toEqual([a.aid]);
  });

  test('words of another account cannot rotate', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const a = await account(relay);
    const { state } = await loadKel(relay, a.aid);
    const other = generateSecretKey();
    expect(() => recoveryRotation(state!, [deviceRecordFor({ key: newDevice(T0).record.key, publisher: getPublicKey(other), label: 'x' }, T0)], { keys: [getPublicKey(other)], threshold: 1 }, [other], T0)).toThrow(
      'この復活の言葉では入れ替えられません（もう使えない言葉か、別のアカウントの言葉です）',
    );
  });

  test('two of three cards rotate, one card does not', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const phone = newDevice(T0 - 1000, 'スマホ');
    const cards = [newRecoveryWords(), newRecoveryWords(), newRecoveryWords()];
    const body = icp([phone.record], { keys: cards.map((w) => recoveryKey(w).pub), threshold: 2 }, 'y');
    const aid = digestOf(body);
    await relay.publish(finalizeEvent(kelEventTemplate(signed(body, [phone]), T0 - 1000), phone.publisherSk));
    expect(await findAccountsByNextKeys(relay, [recoveryKey(cards[2]!).pub])).toEqual([aid]);
    const { state, chain } = await loadKel(relay, aid);
    const fresh = newDevice(T0, 'パソコン');
    const next = { keys: [recoveryKey(newRecoveryWords()).pub], threshold: 1 };
    expect(() => recoveryRotation(state!, [fresh.record], next, [recoveryKey(cards[0]!).sk], T0)).toThrow();
    const rec = recoveryRotation(state!, [fresh.record], next, [recoveryKey(cards[0]!).sk, recoveryKey(cards[2]!).sk], T0);
    expect(verifyRotation(aid, chain, rec.entry, rec.event.created_at)).not.toBeNull();
  });
});
