import { resolve } from 'node:path';

/**
 * コマンドに渡されたパスを絶対パスにする。npm run -w はワークスペースのフォルダで動くので、
 * 相対パスは npm を実行した場所（INIT_CWD）から数える
 */
export function cliPath(path: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return resolve(env.INIT_CWD ?? cwd, path);
}
