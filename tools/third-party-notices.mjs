// @ts-check
// 配布物（アプリと復活の道具）に入る依存パッケージのライセンスの本文をまとめる。
// MIT や Apache-2.0 は、配るときに著作権表示とライセンスの本文を添えることを求めるため
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * @typedef {{ name: string; version: string; license: string; text: string | null }} ThirdPartyPackage
 */

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i;

/**
 * name のパッケージのフォルダを、from から上の node_modules をたどって探す
 * @param {string} name
 * @param {string} from
 * @returns {string | null}
 */
function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** @param {string} dir */
function licenseText(dir) {
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  return files.length === 0 ? null : files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

/**
 * ワークスペース（repo からのパス）の dependencies をたどり、配布物に入る外部のパッケージを名前の順に返す。
 * devDependencies（ビルドやテストの道具）はたどらない。同じリポジトリのワークスペースは、その依存だけをたどる
 * @param {string} repo
 * @param {string[]} workspaces
 * @returns {ThirdPartyPackage[]}
 */
export function thirdPartyPackages(repo, workspaces) {
  /** @type {Map<string, ThirdPartyPackage>} */
  const found = new Map();
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {string} dir */
  const walk = (dir) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkg.name.startsWith('@nostr-rating/')) {
      const license = typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN';
      found.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, text: licenseText(dir) });
    }
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const at = locate(dep, dir);
      if (at) walk(at);
    }
  };
  for (const w of workspaces) walk(resolve(repo, w));
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

/**
 * @param {ThirdPartyPackage[]} pkgs
 * @returns {string}
 */
export function formatNotices(pkgs) {
  const lines = ['このソフトウェアには、次のソフトウェアが含まれています。', ''];
  for (const p of pkgs) {
    lines.push('========================================', `${p.name} ${p.version}`, `License: ${p.license}`, '');
    lines.push(p.text === null ? `パッケージにライセンスの本文がありません。本文は https://spdx.org/licenses/${p.license}.html にあります。` : p.text.trimEnd(), '');
  }
  return lines.join('\n');
}
