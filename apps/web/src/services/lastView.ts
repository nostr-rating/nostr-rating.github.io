import type { IdentityClaim, MannersCount, Pubkey, RatingState } from '@nostr-rating/core';

/** ロビーの上の欄に出す、自分の値 */
export interface LobbySummary {
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  manners: MannersCount;
  /** 対戦のある選手の中での順位。対戦がなければ 0 */
  rank: number;
  linked: boolean;
}

export function lobbySummary(ratings: RatingState, initialRating: number, me: Pubkey, claims: IdentityClaim[] | undefined): LobbySummary {
  const mine = ratings.players[me];
  const rank =
    Object.entries(ratings.players)
      .filter(([, p]) => p.matches > 0)
      .sort(([, a], [, b]) => b.rating - a.rating)
      .findIndex(([pk]) => pk === me) + 1;
  return {
    rating: mine?.rating ?? initialRating,
    matches: mine?.matches ?? 0,
    wins: mine?.wins ?? 0,
    losses: mine?.losses ?? 0,
    draws: mine?.draws ?? 0,
    manners: mine?.manners ?? { noReport: 0, cancel: 0, mismatch: 0 },
    rank,
    linked: (claims?.length ?? 0) > 0,
  };
}

/**
 * 前回の同期のあとのロビーの値と、そのとき読んだスナップショット（latest.json の sha256）。
 * 次に開いたとき、新しいスナップショットが出ていなければ、同期を待たずに先に出す。
 * 結果が決まっていない自分の対戦があったときは、閉じている間に値が変わりうるので残さない
 */
export interface LastView {
  sha256: string | null;
  summary: LobbySummary;
}

const key = (game: string, aid: Pubkey) => `nostr-rating:last-view:${game}:${aid}`;

export function loadLastView(game: string, aid: Pubkey): LastView | null {
  try {
    const raw = localStorage.getItem(key(game, aid));
    if (!raw) return null;
    const v = JSON.parse(raw) as LastView;
    return typeof v?.summary?.rating === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** null を渡すと消す */
export function saveLastView(game: string, aid: Pubkey, v: LastView | null): void {
  try {
    if (v) localStorage.setItem(key(game, aid), JSON.stringify(v));
    else localStorage.removeItem(key(game, aid));
  } catch {
    // 保存できないブラウザでは、毎回同期を待つだけ
  }
}
