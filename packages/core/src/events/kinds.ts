import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure';

export const KIND = {
  profile: 0,
  seal: 13,
  chat: 14,
  giftWrap: 1059,
  application: 3751,
  match: 3752,
  /** 鍵の引き継ぎ用に予約（MVP では使わない） */
  migration: 3753,
  report: 3754,
  identities: 10011,
  settings: 30078,
  recruitment: 31751,
} as const;

export const APP_TAG = 'nostr-rating';

export function appTags(game: string): string[][] {
  return [
    ['t', APP_TAG],
    ['game', game],
  ];
}

export function settingsD(game: string): string {
  return `${APP_TAG}:${game}:settings`;
}

export function recruitmentAddr(recruiter: string, game: string): string {
  return `${KIND.recruitment}:${recruiter}:${game}`;
}

export function tagValue(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

export function tagValues(ev: NostrEvent, name: string): string[] {
  return ev.tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1]!);
}

/** 署名を確かめたイベント → そのときの id:sig。Schnorr の検証は重いので、同じオブジェクトは2回目から省く */
const verified = new WeakMap<object, string>();

/**
 * 署名を必ず検証し直す。nostr-tools は検証済みの印をシンボルで持つため、
 * スプレッドで書き換えたイベントも「検証済み」と扱われてしまう。
 * 一度確かめたオブジェクトは、id の計算（安い sha256）だけで書き換えがないことを確かめる。
 */
export function isValidEvent(ev: unknown): ev is NostrEvent {
  if (typeof ev !== 'object' || ev === null) return false;
  const e = ev as NostrEvent;
  if (!Array.isArray(e.tags) || typeof e.content !== 'string') return false;
  const cached = verified.get(e);
  if (cached !== undefined) {
    try {
      return cached === `${e.id}:${e.sig}` && getEventHash(e) === e.id;
    } catch {
      return false;
    }
  }
  try {
    const ok = verifyEvent({
      id: e.id,
      pubkey: e.pubkey,
      created_at: e.created_at,
      kind: e.kind,
      tags: e.tags,
      content: e.content,
      sig: e.sig,
    });
    if (ok) verified.set(e, `${e.id}:${e.sig}`);
    return ok;
  } catch {
    return false;
  }
}

/** アプリ独自 kind 用: 署名・kind・アプリタグ・ゲームを確かめる */
export function isAppEvent(ev: unknown, kind: number, game: string): ev is NostrEvent {
  if (!isValidEvent(ev) || ev.kind !== kind) return false;
  return ev.tags.some((t) => t[0] === 't' && t[1] === APP_TAG) && tagValue(ev, 'game') === game;
}
