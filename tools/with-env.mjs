// @ts-check
// 環境変数を付けてコマンドを動かす（`VAR=値 コマンド` の書き方は Windows のシェルで動かないため）。
// 使い方: node tools/with-env.mjs VAR=値 [VAR=値 ...] -- コマンド [引数 ...]
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
if (sep < 0 || sep === args.length - 1) {
  console.error('usage: node tools/with-env.mjs VAR=value [VAR=value ...] -- command [args ...]');
  process.exit(2);
}
const env = { ...process.env };
for (const pair of args.slice(0, sep)) {
  const i = pair.indexOf('=');
  if (i <= 0) {
    console.error(`not VAR=value: ${pair}`);
    process.exit(2);
  }
  env[pair.slice(0, i)] = pair.slice(i + 1);
}
const [cmd, ...rest] = args.slice(sep + 1);
// Windows の npm は npm.cmd なので、シェルを通して探す
const child = spawn(/** @type {string} */ (cmd), rest, { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
