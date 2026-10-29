import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { buildKelBook } from '../../src/kel/book.js';
import { kelEventTemplate } from '../../src/kel/event.js';
import { DEVICE_LIFETIME_SEC, deviceValidAt, digestOf, type KelInput } from '../../src/kel/kel.js';
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
    const { state, chain } = await loadKel(relay, a.aid, T0);
    expect(state!.sn).toBe(2);

    const fresh = newDevice(T0, 'パソコン');
    const newWords = newRecoveryWords();
    const rec = recoveryRotation(a.aid, chain, [deviceRecordFor(decodeDeviceRequest(encodeDeviceRequest({ key: fresh.record.key, publisher: fresh.record.publisher, label: 'パソコン' }))!, T0)], { keys: [recoveryKey(newWords).pub], threshold: 1 }, [key.sk], T0, [fresh.record.publisher]);
    const after = verifyRotation(a.aid, chain, rec.entry, rec.event.created_at)!;
    expect(deviceValidAt(after, fresh.record.id, T0)).toBe(true);
    expect(deviceValidAt(after, evil.record.id, T0)).toBe(false);
    expect(after.next.keys).toEqual([recoveryKey(newWords).pub]);
    // 新しい端末は p タグで待ち受けられる
    expect(rec.event.tags).toContainEqual(['p', fresh.record.publisher]);

    await relay.publish(rec.event);
    // rot は最後の icp の次に入り、攻撃者の ixn 2つを上書きする
    expect((await loadKel(relay, a.aid, T0)).state!.sn).toBe(1);
    // 新しい言葉でも同じアカウントを探せる
    expect(await findAccountsByNextKeys(relay, [recoveryKey(newWords).pub])).toEqual([a.aid]);
  });

  test('words of another account cannot rotate', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const a = await account(relay);
    const { chain } = await loadKel(relay, a.aid, T0);
    const other = generateSecretKey();
    expect(() => recoveryRotation(a.aid, chain, [deviceRecordFor({ key: newDevice(T0).record.key, publisher: getPublicKey(other), label: 'x' }, T0)], { keys: [getPublicKey(other)], threshold: 1 }, [other], T0)).toThrow(
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
    const { chain } = await loadKel(relay, aid, T0);
    const fresh = newDevice(T0, 'パソコン');
    const next = { keys: [recoveryKey(newRecoveryWords()).pub], threshold: 1 };
    expect(() => recoveryRotation(aid, chain, [fresh.record], next, [recoveryKey(cards[0]!).sk], T0)).toThrow();
    const rec = recoveryRotation(aid, chain, [fresh.record], next, [recoveryKey(cards[0]!).sk, recoveryKey(cards[2]!).sk], T0);
    expect(verifyRotation(aid, chain, rec.entry, rec.event.created_at)).not.toBeNull();
  });

  test('the rotation takes effect even for whoever saw a different branch of the stolen device first', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const a = await account(relay);
    // 本人がタブレットを足し、スナップショットがそれを記録した
    const tablet = newDevice(T0 - 500, 'タブレット');
    const legit = signed(ixn(a.aid, 1, a.aid, { add: [tablet.record] }), [a.phone]);
    const legitEvent = finalizeEvent(kelEventTemplate(legit, T0 - 500), a.phone.publisherSk);
    await relay.publish(legitEvent);
    const recorded = { [a.aid]: [...a.chain, { entry: legit, at: T0 - 500 }] };
    // 攻撃者は盗んだスマホで、同じ番号の別の ixn を少し早い日時で出した
    const evil = newDevice(T0 - 600, 'evil');
    const fork = signed(ixn(a.aid, 1, a.aid, { add: [evil.record] }), [a.phone]);
    const forkEvent = finalizeEvent(kelEventTemplate(fork, T0 - 600), a.phone.publisherSk);
    await relay.publish(forkEvent);

    const { chain } = await loadKel(relay, a.aid, T0);
    const fresh = newDevice(T0, 'パソコン');
    const rec = recoveryRotation(a.aid, chain, [fresh.record], { keys: [recoveryKey(newRecoveryWords()).pub], threshold: 1 }, [recoveryKey(a.words).sk], T0);
    expect(verifyRotation(a.aid, chain, rec.entry, rec.event.created_at)).not.toBeNull();

    // スナップショット（記録した版を先に見る）でも、道具と同じ版を見た人でも、新しい端末だけが有効になる
    for (const book of [buildKelBook(recorded, [legitEvent, forkEvent, rec.event], T0 - 400, T0 + 86400), buildKelBook({}, [...relay.all(), rec.event], -Infinity, T0 + 86400)]) {
      const s = book.states.get(a.aid)!;
      expect([a.phone, tablet, evil, fresh].map((d) => deviceValidAt(s, d.record.id, T0 + 10))).toEqual([false, false, false, true]);
    }
  });

  test('a key event dated in the future does not push the rotation into the future', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const a = await account(relay);
    // 攻撃者は盗んだスマホで、80日後の日時の ixn を出しておいた
    const later = T0 + 80 * 86400;
    const evil = newDevice(later, 'evil');
    const future = signed(ixn(a.aid, 1, a.aid, { add: [evil.record] }), [a.phone]);
    await relay.publish(finalizeEvent(kelEventTemplate(future, later), a.phone.publisherSk));

    const { state, chain } = await loadKel(relay, a.aid, T0);
    expect(state!.sn).toBe(0);
    const fresh = newDevice(T0, 'パソコン');
    const rec = recoveryRotation(a.aid, chain, [fresh.record], { keys: [recoveryKey(newRecoveryWords()).pub], threshold: 1 }, [recoveryKey(a.words).sk], T0);
    expect(rec.event.created_at).toBe(T0);
    // 次のスナップショット（締め切りまで1日）で入れ替えが効く
    const s = buildKelBook({ [a.aid]: a.chain }, [rec.event], T0 - 2000, T0 + 86400).states.get(a.aid)!;
    expect([deviceValidAt(s, a.phone.record.id, T0 + 10), deviceValidAt(s, fresh.record.id, T0 + 10)]).toEqual([false, true]);
    expect(DEVICE_LIFETIME_SEC).toBeGreaterThan(later - T0);
  });
});
