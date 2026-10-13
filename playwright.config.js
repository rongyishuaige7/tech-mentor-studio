import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.MENTOR_TEST_URL || 'http://127.0.0.1:3301', headless: true },
  reporter: 'list'
});
