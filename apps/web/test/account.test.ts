import { buildKelBook, deviceValidAt, KIND, MemoryRelay } from '@nostr-rating/core';
import { describe, expect, test } from 'vitest';
import { Account, memoryKeyStore } from '../src/account/account.js';

const T0 = 1_790_800_000;

describe('Account', () => {
  test('a key event dated in the future does not push a revocation into the future', async () => {
    const relay = new MemoryRelay(() => T0 + 100);
    const store = memoryKeyStore();
    const { account } = await Account.create(store, relay, () => T0, 'スマホ');
    const added = await account.addDevice(await Account.prepareDevice(memoryKeyStore(), 'タブレット'));
    // 盗んだ端末（保存先の写し）で、80日後の日時のイベントを出しておく
    const later = T0 + 80 * 86400;
    const copy = memoryKeyStore();
    await copy.set('account', structuredClone(await store.get('account')));
    const stolen = (await Account.load(copy, relay, () => later))!;
    await stolen.refreshKel();
    await stolen.addDevice(await Account.prepareDevice(memoryKeyStore(), 'evil'));

    const now = T0 + 100;
    const mine = (await Account.load(store, relay, () => now))!;
    await mine.revoke(added.id);
    const kel = (await relay.query([{ kinds: [KIND.kel] }])).sort((a, b) => a.created_at - b.created_at);
    expect(kel.map((e) => e.created_at)).toEqual([T0, T0, now, later]);
    // 次のスナップショット（締め切りまで1日）で取り消しが効く
    const s = buildKelBook({}, kel, -Infinity, T0 + 86400).states.get(account.aid)!;
    expect(deviceValidAt(s, added.id, now + 10)).toBe(false);
  });
});
