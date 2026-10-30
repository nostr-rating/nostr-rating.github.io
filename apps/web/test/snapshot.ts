import { buildSnapshot, publishedFiles, serializeToc, sha256Hex, type RatingState, type SnapshotToc } from '@nostr-rating/core';

/**
 * 状態を、配信に置いたスナップショット（latest.json、目次、クライアントが読む部品）にする。
 * base は取得元（末尾 /）、path は目次のパス
 */
export function snapshotRoutes(base: string, game: string, state: RatingState, path: string, kind: SnapshotToc['kind'] = 'rolling'): Record<string, string> {
  const { toc, texts } = buildSnapshot(state, { game, previous: null, previousSha256: null, eventIds: [], configSha256: 'x', kind, release: 'r' });
  const text = (ref: { sha256: string }) => texts.get(ref.sha256)!;
  const tocText = serializeToc(toc);
  const routes: Record<string, string> = {
    [`${base}snapshots/${game}/latest.json`]: JSON.stringify({ path, sha256: sha256Hex(tocText) }),
    [`${base}${path}`]: tocText,
  };
  const seasons = Object.fromEntries(Object.entries(toc.parts.seasons).map(([s, ref]) => [s, text(ref)]));
  for (const [p, t] of publishedFiles(game, toc, { players: text(toc.parts.players), seasons, kels: state.kels })) routes[`${base}${p}`] = t;
  return routes;
}
