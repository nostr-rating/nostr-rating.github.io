import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, type NostrEvent } from 'nostr-tools/pure';
import type { GameDefinition } from '../game/definition.js';
import type { Signer } from '../identity/signer.js';
import type { Pubkey } from '../types.js';
import { isValidEvent, KIND, tagValue } from './kinds.js';

export type RoomMessage =
  | { type: 'room'; roomId: string; password: string }
  | { type: 'link'; url: string }
  | { type: 'chat'; text: string };

/** NIP-17: seal と gift wrap の created_at は最大2日前までランダムにずらす */
const TWO_DAYS = 2 * 24 * 3600;
const randomPast = (now: number) => now - Math.floor(Math.random() * TWO_DAYS);

function parseRoomMessage(text: string): RoomMessage | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v.type === 'room' && typeof v.roomId === 'string' && typeof v.password === 'string') {
      return { type: 'room', roomId: v.roomId, password: v.password };
    }
    if (v.type === 'link' && typeof v.url === 'string') return { type: 'link', url: v.url };
    if (v.type === 'chat' && typeof v.text === 'string') return { type: 'chat', text: v.text };
    return null;
  } catch {
    return null;
  }
}

/**
 * rumor（kind 14）→ seal（kind 13、Signer で暗号化・署名）→ gift wrap（kind 1059、使い捨て鍵）。
 * 送信者が自分の控えを包むときは recipient に自分、peer に相手を渡す。
 */
export async function wrapRoomMessage(
  signer: Signer,
  recipient: Pubkey,
  matchId: string,
  msg: RoomMessage,
  now: number,
  peer: Pubkey = recipient,
): Promise<NostrEvent> {
  const author = await signer.getPublicKey();
  const rumorBase = {
    kind: KIND.chat,
    created_at: now,
    tags: [['p', peer], ['e', matchId]],
    content: JSON.stringify(msg),
    pubkey: author,
  };
  const rumor = { ...rumorBase, id: getEventHash(rumorBase) };
  const seal = await signer.signEvent({
    kind: KIND.seal,
    created_at: randomPast(now),
    tags: [],
    content: await signer.nip44Encrypt(recipient, JSON.stringify(rumor)),
  });
  const eph = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND.giftWrap,
      created_at: randomPast(now),
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, recipient)),
    },
    eph,
  );
}

export async function unwrapRoomMessage(
  signer: Signer,
  wrap: NostrEvent,
): Promise<{ from: Pubkey; peer: Pubkey; matchId: string; msg: RoomMessage; createdAt: number } | null> {
  try {
    if (!isValidEvent(wrap) || wrap.kind !== KIND.giftWrap) return null;
    const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as unknown;
    if (!isValidEvent(seal) || seal.kind !== KIND.seal) return null;
    const rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) as NostrEvent;
    if (rumor.kind !== KIND.chat || rumor.pubkey !== seal.pubkey) return null;
    const matchId = tagValue(rumor, 'e');
    const peer = tagValue(rumor, 'p');
    const msg = parseRoomMessage(rumor.content);
    if (!matchId || !peer || !msg) return null;
    // from が本当にその対戦の参加者かは、呼び出し側が MatchRecord と照らして確かめること
    return { from: rumor.pubkey, peer, matchId, msg, createdAt: rumor.created_at };
  } catch {
    return null;
  }
}

export function validRoomId(def: GameDefinition, id: string): boolean {
  return def.room.kind === 'code' && new RegExp(def.room.roomIdPattern).test(id);
}

export function validRoomPassword(def: GameDefinition, password: string): boolean {
  if (def.room.kind !== 'code') return false;
  const { minDigits, maxDigits } = def.room.password;
  return new RegExp(`^[0-9]{${minDigits},${maxDigits}}$`).test(password);
}

/** 部屋のパスワードを作る。偏らないよう、10 で割り切れない端の値（250〜255）は捨てる */
export function generateRoomPassword(def: GameDefinition, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  if (def.room.kind !== 'code') throw new Error('this game has no room password');
  let out = '';
  while (out.length < def.room.password.generatedDigits) {
    for (const b of random(def.room.password.generatedDigits - out.length)) {
      if (b < 250 && out.length < def.room.password.generatedDigits) out += String(b % 10);
    }
  }
  return out;
}

/** 招待リンクとして受け付ける URL（https だけ）。開く前にホスト名を見せるために、URL として返す */
export function validInviteLink(url: string): URL | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' && u.hostname !== '' && url.length <= 500 ? u : null;
  } catch {
    return null;
  }
}
