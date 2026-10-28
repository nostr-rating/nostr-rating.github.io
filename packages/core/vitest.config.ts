import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    root: import.meta.dirname,
    // 鍵の生成と署名の確認が多く、並べて流すと1件が5秒を超えることがある
    testTimeout: 20_000,
  },
});
