import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  timeout: 10 * 60 * 1000,
  use: {
    headless: false,
  },
});
