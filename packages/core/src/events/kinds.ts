import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { fastVerifyEvent } from './fast.js';

export const KIND = {
  profile: 0,
  seal: 13,
  chat: 14,
  giftWrap: 1059,
  application: 3751,
  match: 3752,
  /** 鍵の出来事の記録（KEL。docs/adr/0008） */
  kel: 3753,
  report: 3754,
  /** 使い捨ての鍵の証明書のお知らせ（掲載用の鍵が載せる） */
  cert: 3755,
  settings: 30078,
  /** アカウントの公開情報（表示名と紐づけ）。d は aid */
  account: 30756,
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

/**
 * 署名を確かめた結果の控え（id:pubkey:sig → 結果）。Schnorr の検証は重く、同じイベントが問い合わせのたびに
 * 別のオブジェクトとして届くので、オブジェクトではなく id と署名で覚える
 */
const verified = new Map<string, boolean>();
const VERIFIED_MAX = 50_000;

/**
 * 署名を必ず検証し直す。nostr-tools は検証済みの印をシンボルで持つため、
 * スプレッドで書き換えたイベントも「検証済み」と扱われてしまう。
 * 一度確かめた id と署名の組は、id の計算（安い sha256）だけで中身が id と合うことを確かめる。
 */
export function isValidEvent(ev: unknown): ev is NostrEvent {
  if (typeof ev !== 'object' || ev === null) return false;
  const e = ev as NostrEvent;
  if (!Array.isArray(e.tags) || typeof e.content !== 'string') return false;
  const key = `${e.id}:${e.pubkey}:${e.sig}`;
  const cached = verified.get(key);
  if (cached !== undefined) {
    try {
      return cached && getEventHash(e) === e.id;
    } catch {
      return false;
    }
  }
  let ok: boolean;
  try {
    const plain = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
    ok = fastVerifyEvent(plain) ?? verifyEvent(plain);
  } catch {
    ok = false;
  }
  // 中身が id と合わないものは、同じ id と署名の正しい中身を後から受け付けられるように覚えない
  if (ok || safeHash(e) === e.id) {
    if (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value!);
    verified.set(key, ok);
  }
  return ok;
}

function safeHash(e: NostrEvent): string | null {
  try {
    return getEventHash(e);
  } catch {
    return null;
  }
}

/** アプリ独自 kind 用: 署名・kind・アプリタグ・ゲームを確かめる */
export function isAppEvent(ev: unknown, kind: number, game: string): ev is NostrEvent {
  if (!isValidEvent(ev) || ev.kind !== kind) return false;
  return ev.tags.some((t) => t[0] === 't' && t[1] === APP_TAG) && tagValue(ev, 'game') === game;
}
