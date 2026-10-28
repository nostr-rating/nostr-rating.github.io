import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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
  plugins: [react(), serveRepoData(), ...(lan && !lanCert ? [basicSsl()] : [])],
  server: lan
    ? {
        host: true,
        allowedHosts: lanHosts,
        ...(lanCert ? { https: lanCert } : {}),
        proxy: { '/relay': { target: 'ws://localhost:7777', ws: true, rewrite: () => '/' } },
      }
    : {},
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
});
