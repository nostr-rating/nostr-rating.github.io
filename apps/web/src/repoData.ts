import { resolve, sep } from 'node:path';

/**
 * 開発サーバーが返す、リポジトリの snapshots/ と configs/ の中のファイルの場所。
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
  const file = resolve(repo, `.${path}`);
  return file.startsWith(resolve(repo, dir) + sep) ? file : null;
}
