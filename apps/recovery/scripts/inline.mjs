// dist/index.html が読む JS と CSS を中に埋め込み、dist/nostr-rating-recovery.html を1ファイルで書き出す
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatNotices, thirdPartyPackages } from '../../../tools/third-party-notices.mjs';

const dist = join(import.meta.dirname, '../dist');
let html = readFileSync(join(dist, 'index.html'), 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, p) => {
  // </script> を含む文字列が JS の中にあっても HTML が切れないようにする
  const js = readFileSync(join(dist, p), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/, (_, p) => `<style>${readFileSync(join(dist, p), 'utf8')}</style>`);
if (/src="\.\/assets|href="\.\/assets/.test(html)) throw new Error('some assets were not inlined');
// 1ファイルで配るので、使っているソフトウェアのライセンスも中に入れる
const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const notices = formatNotices(thirdPartyPackages(join(import.meta.dirname, '../../..'), ['apps/recovery']));
html = html.replace('</body>', `<details class="notices"><summary>使っているソフトウェアのライセンス</summary><pre>${escape(notices)}</pre></details>\n</body>`);
writeFileSync(join(dist, 'nostr-rating-recovery.html'), html);
console.log(`wrote dist/nostr-rating-recovery.html (${Math.round(html.length / 1024)} KiB)`);
