import { resolve, sep } from 'node:path';

/** npm run site -- --out .snapshot-parts/site で書き出した、配信と同じ並びのスナップショット（docs/adr/0011） */
export const LOCAL_SITE = '.snapshot-parts/site';

/**
 * 開発サーバーが返すファイルの場所。snapshots/ は書き出したスナップショット、configs/ はリポジトリのもの。
 * 「..」でその外に出るものは返さない（dev:lan では同じ LAN の誰でも開けるため）
 */
export function repoDataFile(repo: string, url: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.split('?')[0]!);
  } catch {
    return null;
  }
  path = path.replace(/^\/[^/]*\/(?=(snapshots|configs)\/)/, '/');
  const dir = path.match(/^\/(snapshots|configs)\//)?.[1];
  if (!dir) return null;
  const root = dir === 'snapshots' ? resolve(repo, LOCAL_SITE) : repo;
  const file = resolve(root, `.${path}`);
  return file.startsWith(resolve(root, dir) + sep) ? file : null;
}
