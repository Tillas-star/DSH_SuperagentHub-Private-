import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const appDir = path.resolve(__dirname);
const dataDir = path.join(appDir, '.e2e', 'data');
const cacheDir = path.join(appDir, '.e2e', 'cache');

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8791',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'iPhone 13',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
    {
      name: 'Pixel 7',
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command:
      'node test/e2e/prepare.mjs && node dist/server/index.js --root .e2e/图片 --port 8791',
    url: 'http://127.0.0.1:8791/healthz',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      MOBILE_FILES_DATA_DIR: dataDir,
      MOBILE_FILES_CACHE_DIR: cacheDir,
    },
  },
});
