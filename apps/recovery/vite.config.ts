import { defineConfig } from 'vite';

/**
 * 復活の道具は、ダウンロードして file:// で開く HTML 1ファイルにする（docs/adr/0008「復活の道具」）。
 * JS と CSS を1つにまとめ、ビルドのあとに scripts/inline.mjs が HTML へ埋め込む
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
