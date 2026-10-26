import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'snapshot', root: import.meta.dirname },
});
