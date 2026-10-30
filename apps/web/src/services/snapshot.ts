import {
  partPath,
  kelPrefix,
  sha256Hex,
  stateFromParts,
  type KelIndexPart,
  type KelPrefixPart,
  type KelRecords,
  type LatestPointer,
  type PlayersPart,
  type Pubkey,
  type RatingState,
  type SeasonPart,
  type SnapshotToc,
} from '@nostr-rating/core';

/** クライアントが読んだスナップショット（docs/adr/0011） */
export interface ClientSnapshot {
  /** KEL は空。公開情報は、そのシーズンの選手と終わったシーズンの選手の分だけ */
  state: RatingState;
  /** 記録済みの KEL を、必要なアカウントの分だけ読む。記録のないアカウントは返さない */
  loadKels(aids: Pubkey[]): Promise<KelRecords>;
}

async function fetchText(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<string> {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** latest.json を読む。まだスナップショットが無ければ（404）null */
export async function fetchLatest(fetchFn: typeof fetch, base: string, game: string): Promise<LatestPointer | null> {
  const url = `${base}snapshots/${game}/latest.json`;
  const res = await fetchFn(url, { cache: 'no-cache' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return JSON.parse(await res.text()) as LatestPointer;
}

/**
 * 目次と、毎回使う部品（players とシーズン）を読み、sha256 を確かめる。
 * 部品は名前が sha256 で中身が変わらないので、ブラウザのキャッシュに任せる
 */
export async function loadClientSnapshot(fetchFn: typeof fetch, base: string, game: string, pointer: LatestPointer): Promise<ClientSnapshot> {
  const tocText = await fetchText(fetchFn, `${base}${pointer.path}`);
  if (sha256Hex(tocText) !== pointer.sha256) throw new Error(`sha256 mismatch: ${pointer.path}`);
  const toc = JSON.parse(tocText) as SnapshotToc;
  if (toc.schema_version !== 3) throw new Error(`${pointer.path}: schema_version ${toc.schema_version} is not supported`);

  const part = async <T,>(sha256: string): Promise<T> => {
    const text = await fetchText(fetchFn, `${base}${partPath(game, sha256)}`);
    if (sha256Hex(text) !== sha256) throw new Error(`sha256 mismatch: part ${sha256}`);
    return JSON.parse(text) as T;
  };
  const seasonIds = Object.keys(toc.parts.seasons);
  const [players, ...seasons] = await Promise.all([
    part<PlayersPart>(toc.parts.players.sha256),
    ...seasonIds.map((s) => part<SeasonPart>(toc.parts.seasons[s]!.sha256)),
  ]);
  const state = stateFromParts(toc, {
    players: players as PlayersPart,
    seasons: Object.fromEntries(seasonIds.map((s, i) => [s, seasons[i] as SeasonPart])),
  });

  // 索引は、そのシーズンの選手でないアカウントが出てきたときにだけ読む
  let index: Promise<KelIndexPart> | null = null;
  const prefixes = new Map<string, Promise<KelPrefixPart>>();
  const kels = new Map<Pubkey, Promise<KelRecords[string] | null>>();
  const shaOf = async (aid: Pubkey): Promise<string | null> => {
    const own = (players as PlayersPart).kels[aid];
    if (own) return own;
    index ??= part<KelIndexPart>(toc.kel_index.sha256);
    const ref = (await index)[kelPrefix(aid)];
    if (!ref) return null;
    let p = prefixes.get(kelPrefix(aid));
    if (!p) {
      p = part<KelPrefixPart>(ref.sha256);
      prefixes.set(kelPrefix(aid), p);
    }
    return (await p)[aid] ?? null;
  };
  const kelOf = (aid: Pubkey) => {
    let k = kels.get(aid);
    if (!k) {
      k = shaOf(aid).then((sha) => (sha ? part<KelRecords[string]>(sha) : null));
      // 失敗したら次に頼まれたときに読み直す
      k.catch(() => kels.delete(aid));
      kels.set(aid, k);
    }
    return k;
  };
  return {
    state,
    async loadKels(aids) {
      const got = await Promise.all(aids.map(async (aid) => [aid, await kelOf(aid)] as const));
      return Object.fromEntries(got.filter((x): x is [Pubkey, KelRecords[string]] => x[1] !== null));
    },
  };
}
