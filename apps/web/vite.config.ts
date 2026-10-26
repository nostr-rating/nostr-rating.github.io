import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
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

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), serveRepoData()],
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
});
