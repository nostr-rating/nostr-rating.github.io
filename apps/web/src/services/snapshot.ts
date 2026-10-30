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
  /** シーズンの途中（rolling）か、終わったシーズンの最終版（final）か */
  kind: SnapshotToc['kind'];
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
    const text = await fetchText(fetchFn, `${base}${partPath(sha256)}`);
    if (sha256Hex(text) !== sha256) throw new Error(`sha256 mismatch: part ${sha256}`);
    return JSON.parse(text) as T;
  };
  const seasonIds = Object.keys(toc.parts.seasons);
  const [players, seasons] = await Promise.all([
    part<PlayersPart>(toc.parts.players.sha256),
    Promise.all(seasonIds.map((s) => part<SeasonPart>(toc.parts.seasons[s]!.sha256))),
  ]);
  const state = stateFromParts(toc, { players, seasons: Object.fromEntries(seasonIds.map((s, i) => [s, seasons[i]!])) });

  /** 読んだ部品を覚える。失敗したものは覚えず、次に頼まれたときに読み直す */
  const memo = <K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> => {
    let p = cache.get(key);
    if (!p) {
      p = load();
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
  // 索引は、そのシーズンの選手でないアカウントが出てきたときにだけ読む
  const index = new Map<'index', Promise<KelIndexPart>>();
  const prefixes = new Map<string, Promise<KelPrefixPart>>();
  const kels = new Map<Pubkey, Promise<KelRecords[string] | null>>();
  const shaOf = async (aid: Pubkey): Promise<string | null> => {
    const own = players.kels[aid];
    if (own) return own;
    const ref = (await memo(index, 'index', () => part<KelIndexPart>(toc.kel_index.sha256)))[kelPrefix(aid)];
    if (!ref) return null;
    return (await memo(prefixes, kelPrefix(aid), () => part<KelPrefixPart>(ref.sha256)))[aid] ?? null;
  };
  const kelOf = (aid: Pubkey) => memo(kels, aid, async () => {
    const sha = await shaOf(aid);
    return sha ? part<KelRecords[string]>(sha) : null;
  });
  return {
    state,
    kind: toc.kind,
    async loadKels(aids) {
      const got = await Promise.all(aids.map(async (aid) => [aid, await kelOf(aid)] as const));
      return Object.fromEntries(got.filter((x): x is [Pubkey, KelRecords[string]] => x[1] !== null));
    },
  };
}
