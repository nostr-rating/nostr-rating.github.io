import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha256Hex,
  stateFromParts,
  type KelRecords,
  type LatestPointer,
  type PartRef,
  type PlayersPart,
  type RatingState,
  type SeasonPart,
  type SnapshotAccount,
  type SnapshotToc,
} from '@nostr-rating/core';

/**
 * スナップショットの部品の置き場（docs/adr/0011）。読むときは手元のフォルダを先に見て、無ければリリースから取る。
 * 書いた部品は、リリースに上げるまで upload/<タグ>/ に置いておく
 */
export interface PartStore {
  /** sha256 を確かめてから返す */
  get(ref: PartRef): Promise<string>;
  put(release: string, sha256: string, text: string): void;
}

/**
 * dir: 手元のフォルダ。releaseBase: リリースの添付ファイルの取得元（`https://github.com/<owner>/<repo>/releases/download/`）。
 * null なら手元のフォルダだけを見る
 */
export function partStore(dir: string, releaseBase: string | null, fetchFn: typeof fetch = fetch): PartStore {
  return {
    async get(ref) {
      const local = join(dir, `${ref.sha256}.json`);
      let text: string;
      if (existsSync(local)) {
        text = readFileSync(local, 'utf8');
      } else {
        if (!releaseBase) throw new Error(`part ${ref.sha256} of ${ref.release} is not in ${dir}, and no release to fetch it from was given`);
        const url = `${releaseBase}${ref.release}/${ref.sha256}.json`;
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        text = await res.text();
      }
      if (sha256Hex(text) !== ref.sha256) throw new Error(`sha256 mismatch: part ${ref.sha256} of ${ref.release}`);
      if (!existsSync(local)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(local, text);
      }
      return text;
    },
    put(release, sha256, text) {
      mkdirSync(join(dir, 'upload', release), { recursive: true });
      writeFileSync(join(dir, `${sha256}.json`), text);
      writeFileSync(join(dir, 'upload', release, `${sha256}.json`), text);
    },
  };
}

/** ゲームごとに snapshots/<game>/ の下に置く（docs/adr/0010） */
export const latestOf = (game: string) => `snapshots/${game}/latest.json`;

export interface LoadedSnapshot {
  pointer: LatestPointer;
  toc: SnapshotToc;
  /** 目次の本文（リポジトリのものそのまま） */
  tocText: string;
  /** 部品の本文（配信でそのまま使う）。KEL は部品をまとめたもの。matches はその部品を作る前の目次では無い */
  texts: { players: string; seasons: Record<string, string>; kels: KelRecords; matches?: string };
  /** すべての部品から作った状態 */
  state: RatingState;
}

/** リポジトリの latest.json が指す目次と、その部品をすべて読む。latest.json が無ければ null */
export async function loadSnapshot(root: string, game: string, store: PartStore): Promise<LoadedSnapshot | null> {
  const latestPath = join(root, latestOf(game));
  if (!existsSync(latestPath)) return null;
  const pointer = JSON.parse(readFileSync(latestPath, 'utf8')) as LatestPointer;
  const tocText = readFileSync(join(root, pointer.path), 'utf8');
  if (sha256Hex(tocText) !== pointer.sha256) throw new Error(`sha256 mismatch: ${pointer.path} does not match ${latestOf(game)}`);
  const toc = JSON.parse(tocText) as SnapshotToc;
  if (toc.schema_version !== 3) throw new Error(`${pointer.path}: schema_version ${toc.schema_version} is not supported`);
  const seasonIds = Object.keys(toc.parts.seasons);
  const shards = async <T,>(refs: Record<string, PartRef>): Promise<Record<string, T>> =>
    Object.assign({}, ...(await Promise.all(Object.values(refs).map(async (r) => JSON.parse(await store.get(r)) as Record<string, T>))));
  const [players, accounts, kels, seasonTexts, matches] = await Promise.all([
    store.get(toc.parts.players),
    shards<SnapshotAccount>(toc.parts.accounts),
    shards<KelRecords[string]>(toc.parts.kels),
    Promise.all(seasonIds.map((s) => store.get(toc.parts.seasons[s]!))),
    toc.parts.matches ? store.get(toc.parts.matches) : Promise.resolve(undefined),
  ]);
  const seasons = Object.fromEntries(seasonIds.map((s, i) => [s, seasonTexts[i]!]));
  const state = stateFromParts(toc, {
    players: JSON.parse(players) as PlayersPart,
    seasons: Object.fromEntries(Object.entries(seasons).map(([s, t]) => [s, JSON.parse(t) as SeasonPart])),
    accounts,
    kels,
  });
  return { pointer, toc, tocText, texts: { players, seasons, kels, ...(matches === undefined ? {} : { matches }) }, state };
}
