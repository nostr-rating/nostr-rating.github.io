import { parseGameDefinition, type GameDefinition } from '@nostr-rating/core';
import gameList from '../../../../configs/games.json';
import bundledRelays from '../../../../configs/relays.json';

/** configs/ の定義ファイルをすべて同梱する（どれを使うかは configs/games.json の順に並べる） */
const bundledDefs = import.meta.glob('../../../../configs/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

const OVERRIDE_KEY = 'nostr-rating:overrides';

export interface Overrides {
  relays?: string[];
  snapshotBase?: string;
}

function readOverrides(): Overrides {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY) ?? '{}') as Overrides;
  } catch {
    return {};
  }
}

export function saveOverrides(o: Overrides): void {
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(o));
  } catch {
    // 保存できなくても既定値で動く
  }
}

/** 利用者が選べるゲーム（docs/adr/0010） */
export function gameDefinitions(): GameDefinition[] {
  return gameList.games.map((id) => {
    const raw = bundledDefs[`../../../../configs/${id}.json`];
    if (!raw) throw new Error(`configs/${id}.json is missing`);
    return parseGameDefinition(raw);
  });
}

const GAME_KEY = 'nostr-rating:game';

/** 最後に選んだゲーム。なければ一覧の最初 */
export function rememberedGame(games: GameDefinition[]): GameDefinition {
  let id: string | null = null;
  try {
    id = localStorage.getItem(GAME_KEY);
  } catch {
    id = null;
  }
  return games.find((g) => g.id === id) ?? games[0]!;
}

export function rememberGame(id: string): void {
  try {
    localStorage.setItem(GAME_KEY, id);
  } catch {
    // 次回は一覧の最初から
  }
}

/** 取得元の優先順: 設定画面の上書き → ビルド時の環境変数 → 同じ配信元 */
export function snapshotBase(): string {
  const base = readOverrides().snapshotBase ?? import.meta.env.VITE_SNAPSHOT_BASE ?? new URL(import.meta.env.BASE_URL, location.origin).href;
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * リレー一覧: 設定画面の上書き → ビルド時の VITE_RELAYS → スナップショットと同じ取得元の
 * configs/relays.json（PR で更新される）→ 同梱の relays.json
 */
export async function relayUrls(fetchFn: typeof fetch = fetch): Promise<string[]> {
  const o = readOverrides().relays;
  if (o && o.length > 0) return o;
  const env = import.meta.env.VITE_RELAYS as string | undefined;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean).map((u) => resolveRelayUrl(u, location.origin));
  try {
    const res = await fetchFn(`${snapshotBase()}configs/relays.json`);
    if (res.ok) {
      const j = (await res.json()) as { relays?: unknown };
      if (Array.isArray(j.relays) && j.relays.every((r) => typeof r === 'string')) return j.relays as string[];
    }
  } catch {
    // 同梱の一覧を使う
  }
  return bundledRelays.relays;
}

/** `/relay` のようなパスは、ページと同じ配信元のリレーとして扱う（npm run dev:lan で、開発サーバーがリレーへ中継する） */
export function resolveRelayUrl(url: string, origin: string): string {
  if (!url.startsWith('/')) return url;
  const o = new URL(origin);
  return `${o.protocol === 'https:' ? 'wss' : 'ws'}://${o.host}${url}`;
}

export function currentOverrides(): Overrides {
  return readOverrides();
}
