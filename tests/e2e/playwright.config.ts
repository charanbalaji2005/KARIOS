import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * These run against a real stack, not a mocked one. The point of an E2E suite
 * here is to catch the failures that only appear when the dashboard, the API
 * and PostgreSQL disagree — which is exactly the class of bug that unit tests
 * with mocked boundaries cannot see.
 *
 *   docker compose up -d && pnpm db:migrate
 *   pnpm --filter @kairosdb/tests exec playwright install chromium
 *   pnpm e2e
 */
export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Serial. The suite provisions real databases; running it in parallel would
  // have several specs racing for the connection budget and blaming each other.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
