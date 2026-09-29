import { defineConfig } from '@playwright/test';

// Runs against an already-running stack: infra (docker compose), API, worker and web.
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.WEB_URL ?? 'http://localhost:4001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
