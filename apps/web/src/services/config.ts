import { parseGameDefinition, type GameDefinition } from '@nostr-rating/core';
import bundledDef from '../../../../configs/smash_sp.json';
import bundledRelays from '../../../../configs/relays.json';

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

export function gameDefinition(): GameDefinition {
  return parseGameDefinition(bundledDef);
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
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
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

export function currentOverrides(): Overrides {
  return readOverrides();
}
