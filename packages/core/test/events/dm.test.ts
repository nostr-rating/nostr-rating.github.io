import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { generateRoomPassword, unwrapRoomMessage, validRoomId, validRoomPassword, wrapRoomMessage } from '../../src/events/dm.js';
import { KIND } from '../../src/events/kinds.js';
import { def } from '../helpers/def.js';
import { newKeys as newUser } from '../helpers/keys.js';

const NOW = 1_790_800_000;
const MATCH = 'f'.repeat(64);

describe('room DM', () => {
  test('roundtrip to recipient', async () => {
    const a = newUser();
    const b = newUser();
    const wrap = await wrapRoomMessage(a.signer, b.pk, MATCH, { type: 'room', roomId: 'AB12C', password: '1122' }, NOW);
    expect(wrap.kind).toBe(KIND.giftWrap);
    expect(wrap.pubkey).not.toBe(a.pk);
    expect(wrap.tags).toEqual([['p', b.pk]]);
    expect(await unwrapRoomMessage(b.signer, wrap)).toEqual({
      from: a.pk,
      peer: b.pk,
      matchId: MATCH,
      msg: { type: 'room', roomId: 'AB12C', password: '1122' },
      createdAt: NOW,
    });
  });

  test('sender can read a copy wrapped to self', async () => {
    const a = newUser();
    const b = newUser();
    const wrap = await wrapRoomMessage(a.signer, a.pk, MATCH, { type: 'chat', text: 'よろしくお願いします' }, NOW, b.pk);
    const got = await unwrapRoomMessage(a.signer, wrap);
    expect(got?.msg).toEqual({ type: 'chat', text: 'よろしくお願いします' });
    // 自分宛ての控えでも、rumor の宛先は対戦相手
    expect(got?.peer).toBe(b.pk);
  });

  test('third party cannot read', async () => {
    const a = newUser();
    const b = newUser();
    const c = newUser();
    const wrap = await wrapRoomMessage(a.signer, b.pk, MATCH, { type: 'chat', text: 'x' }, NOW);
    expect(await unwrapRoomMessage(c.signer, wrap)).toBeNull();
  });

  test('rumor author different from seal signer is rejected', async () => {
    const mallory = newUser();
    const victim = newUser();
    const b = newUser();
    const rumorBase = {
      kind: KIND.chat,
      created_at: NOW,
      tags: [['p', b.pk], ['e', MATCH]],
      content: JSON.stringify({ type: 'chat', text: 'なりすまし' }),
      pubkey: victim.pk,
    };
    const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
    const seal = await mallory.signer.signEvent({
      kind: KIND.seal,
      created_at: NOW,
      tags: [],
      content: await mallory.signer.nip44Encrypt(b.pk, JSON.stringify(rumor)),
    });
    const eph = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND.giftWrap,
        created_at: NOW,
        tags: [['p', b.pk]],
        content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, b.pk)),
      },
      eph,
    );
    expect(getPublicKey(eph)).toBe(wrap.pubkey);
    expect(await unwrapRoomMessage(b.signer, wrap)).toBeNull();
  });

  test('validRoomId', () => {
    expect(validRoomId(def, 'ab12C')).toBe(true);
    expect(validRoomId(def, 'ab12')).toBe(false);
    expect(validRoomId(def, 'ab-12')).toBe(false);
    expect(validRoomId(def, 'ab12CD')).toBe(false);
  });

  test('validRoomPassword accepts 4 to 8 digits', () => {
    expect(['1234', '12345678', '0000'].map((p) => validRoomPassword(def, p))).toEqual([true, true, true]);
    expect(['123', '123456789', '12a4', ' 1234', ''].map((p) => validRoomPassword(def, p))).toEqual([false, false, false, false, false]);
  });

  test('generateRoomPassword makes the configured number of random digits', () => {
    const made = Array.from({ length: 200 }, () => generateRoomPassword(def));
    expect(made.every((p) => /^[0-9]{4}$/.test(p))).toBe(true);
    // 偏りなく散らばる（同じ値ばかりにならない）
    expect(new Set(made).size).toBeGreaterThan(150);
    expect(new Set(made.flatMap((p) => [...p])).size).toBe(10);
  });

  test('generateRoomPassword drops random bytes that would bias the digits', () => {
    // 250 以上の値は 10 で割ると 0〜5 に寄るので使わない
    const bytes = [250, 255, 7, 251, 3, 9, 0];
    const random = (n: number) => Uint8Array.from(bytes.splice(0, n));
    expect(generateRoomPassword(def, random)).toBe('7390');
  });
});

