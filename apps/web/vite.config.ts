import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { recoveryUrl, withRecoveryLink } from './src/recoveryLink.js';

const REPO = resolve(import.meta.dirname, '../..');

/** 開発時とプレビュー時に、リポジトリの snapshots/ と configs/ を同じ配信元から返す */
function serveRepoData(): Plugin {
  const handler = (req: { url?: string }, res: any, next: () => void) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]!).replace(/^\/[^/]*\/(?=(snapshots|configs)\/)/, '/');
    if (!/^\/(snapshots|configs)\//.test(path)) return next();
    const file = normalize(join(REPO, path));
    if (!file.startsWith(REPO) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/plain');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'serve-repo-data',
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  };
}

/**
 * 文字のフォント（Zen Kaku Gothic New）を、アプリとヘルプの両方から fonts/ で読めるように配る。
 * 外部のフォント配信を使うと、開くたびに利用者の IP がそこへ届くため、同じ配信元から出す
 */
const FONT_DIR = resolve(REPO, 'node_modules/@fontsource/zen-kaku-gothic-new');
const FONT_CSS = 'fonts/zen-kaku-gothic-new.css';

function fontCss(): string {
  return ['400', '700']
    .map((w) => readFileSync(join(FONT_DIR, `${w}.css`), 'utf8'))
    .join('\n')
    .replace(/, url\([^)]*\.woff\) format\('woff'\)/g, '')
    .replace(/url\(\.\/files\//g, 'url(./zen-kaku-gothic-new/')
    // 字の範囲ごとの宣言が数百あるので、コメントと空白を落として小さくする
    .replace(/\/\*[^*]*\*\//g, '')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .trim();
}

function fontFiles(): string[] {
  const used = new Set([...fontCss().matchAll(/zen-kaku-gothic-new\/([^)]+\.woff2)/g)].map((m) => m[1]!));
  return readdirSync(join(FONT_DIR, 'files')).filter((f) => used.has(f));
}

function serveFonts(): Plugin {
  let base = '/';
  return {
    name: 'serve-fonts',
    configResolved: (c) => void (base = c.base),
    configureServer: (s) =>
      void s.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!;
        if (path === `${base}${FONT_CSS}`) {
          res.setHeader('Content-Type', 'text/css');
          return void res.end(fontCss());
        }
        const m = path.match(/\/fonts\/zen-kaku-gothic-new\/([\w.-]+\.woff2)$/);
        if (!m || !existsSync(join(FONT_DIR, 'files', m[1]!))) return next();
        res.setHeader('Content-Type', 'font/woff2');
        createReadStream(join(FONT_DIR, 'files', m[1]!)).pipe(res);
      }),
    transformIndexHtml: () => [{ tag: 'link', attrs: { rel: 'stylesheet', href: `${base}${FONT_CSS}` }, injectTo: 'head-prepend' }],
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FONT_CSS, source: fontCss() });
      this.emitFile({ type: 'asset', fileName: 'fonts/zen-kaku-gothic-new/LICENSE.txt', source: readFileSync(join(FONT_DIR, 'LICENSE')) });
      for (const f of fontFiles()) this.emitFile({ type: 'asset', fileName: `fonts/zen-kaku-gothic-new/${f}`, source: readFileSync(join(FONT_DIR, 'files', f)) });
    },
  };
}

/** ヘルプに復活の道具の入手先を書き込む。public/ のファイルは変換されないので、開発時は配るときに、ビルドでは書き出したあとに置き換える */
const RECOVERY_URL = recoveryUrl(process.env);
const HELP = 'help/account.html';

function helpRecoveryLink(): Plugin {
  let base = '/';
  let outDir = '';
  return {
    name: 'help-recovery-link',
    configResolved: (c) => void ((base = c.base), (outDir = resolve(c.root, c.build.outDir))),
    configureServer: (s) =>
      void s.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== `${base}${HELP}`) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(withRecoveryLink(readFileSync(resolve(import.meta.dirname, 'public', HELP), 'utf8'), RECOVERY_URL));
      }),
    writeBundle() {
      const file = join(outDir, HELP);
      writeFileSync(file, withRecoveryLink(readFileSync(file, 'utf8'), RECOVERY_URL));
    },
  };
}

/**
 * npm run dev:lan: 同じ LAN のスマホから開くための開発サーバー。
 * 端末の鍵（WebCrypto）と OPFS は https でしか使えないので自己署名の証明書で配り、
 * https のページから ws:// にはつなげないので、/relay をローカルのリレーへ中継する
 */
const lan = process.env.NR_LAN === '1';
/** iPhone のように自己署名の証明書を受け付けない端末向けに、mkcert などで作った証明書を渡せる */
const lanCert = process.env.NR_LAN_CERT && process.env.NR_LAN_KEY ? { cert: readFileSync(process.env.NR_LAN_CERT), key: readFileSync(process.env.NR_LAN_KEY) } : null;

/**
 * IP アドレスと localhost 以外の名前で開くと、Vite は画面の自動更新の接続を断る（DNS リバインディング対策）。
 * 開発機のホスト名（とその .local）と、NR_LAN_HOSTS に書いた名前だけを許す
 */
const lanHosts = (() => {
  const name = hostname().replace(/\.local$/, '');
  return [name, `${name}.local`, ...(process.env.NR_LAN_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)];
})();

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), serveRepoData(), serveFonts(), helpRecoveryLink(), ...(lan && !lanCert ? [basicSsl()] : [])],
  server: lan
    ? {
        host: true,
        allowedHosts: lanHosts,
        ...(lanCert ? { https: lanCert } : {}),
        proxy: { '/relay': { target: 'ws://localhost:7777', ws: true, rewrite: () => '/' } },
      }
    : {},
  define: { 'import.meta.env.VITE_RECOVERY_URL': JSON.stringify(RECOVERY_URL ?? '') },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
});
