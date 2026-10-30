import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatNotices, thirdPartyPackages } from '../../../tools/third-party-notices.mjs';

const REPO = resolve(import.meta.dirname, '../../..');

describe('third-party notices', () => {
  test('lists the packages the app ships with their license text, but not the tools used to build or test it', () => {
    const pkgs = thirdPartyPackages(REPO, ['apps/web']);
    const react = JSON.parse(readFileSync(resolve(REPO, 'node_modules/react/package.json'), 'utf8')) as { version: string };
    expect(pkgs.find((p) => p.name === 'react')).toEqual({
      name: 'react',
      version: react.version,
      license: 'MIT',
      text: readFileSync(resolve(REPO, 'node_modules/react/LICENSE'), 'utf8'),
    });
    // core が使う依存もたどる
    expect(pkgs.some((p) => p.name === '@noble/curves')).toBe(true);
    const names = pkgs.map((p) => p.name);
    expect(names.filter((n) => n === 'vite' || n === 'vitest' || n.startsWith('@nostr-rating/'))).toEqual([]);
    expect(names).toEqual([...names].sort());
  });

  test('formats each package with its name, version, license and text', () => {
    expect(
      formatNotices([
        { name: 'a', version: '1.0.0', license: 'MIT', text: 'Copyright a\n' },
        { name: 'b', version: '2.0.0', license: 'Apache-2.0', text: null },
      ]),
    ).toBe(
      [
        'このソフトウェアには、次のソフトウェアが含まれています。',
        '',
        '========================================',
        'a 1.0.0',
        'License: MIT',
        '',
        'Copyright a',
        '',
        '========================================',
        'b 2.0.0',
        'License: Apache-2.0',
        '',
        'パッケージにライセンスの本文がありません。本文は https://spdx.org/licenses/Apache-2.0.html にあります。',
        '',
      ].join('\n'),
    );
  });
});
