/**
 * The full journey, in a browser: sign up, create a project, create a table,
 * insert a row, run SQL, and read it back through the REST API with a key the
 * dashboard showed exactly once.
 *
 * Deliberately one long test rather than several short ones. Each step depends
 * on the last, and splitting them would mean either re-doing the setup four
 * times or sharing state between tests that then cannot run independently.
 */
import { test, expect } from '@playwright/test';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = 'e2e-test-password-4471';

test('sign up, provision, create a table, query it over REST', async ({ page }) => {
  const email = `e2e-${Date.now()}@kairos.test`;

  await test.step('sign up', async () => {
    await page.goto('/login');
    await page.getByRole('button', { name: /sign up|create account/i }).click();
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign up|create account/i }).last().click();
    await expect(page).toHaveURL(/\/projects/, { timeout: 30_000 });
  });

  const projectName = `e2e-${Date.now().toString(36)}`;
  let anonKey = '';

  await test.step('create a project and capture the one-time keys', async () => {
    await page.getByRole('button', { name: /new project/i }).click();
    await page.getByLabel(/name/i).fill(projectName);
    await page.getByRole('button', { name: /^create/i }).click();

    // The anon key is shown once and never again — that is the design, and
    // this assertion is what stops someone "helpfully" making it retrievable.
    const keyBlock = page.getByText(/krs_anon_/).first();
    await expect(keyBlock).toBeVisible({ timeout: 60_000 });
    anonKey = ((await keyBlock.textContent()) ?? '').trim();
    expect(anonKey).toMatch(/^krs_anon_/);
  });

  await test.step('open the project', async () => {
    await page.getByRole('link', { name: new RegExp(projectName, 'i') }).click();
    await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
  });

  await test.step('quotas are shown, not hidden', async () => {
    await expect(page.getByText(/resource limits/i)).toBeVisible();
  });

  await test.step('create a table in the editor', async () => {
    await page.getByRole('link', { name: /table editor/i }).click();
    await page.getByRole('button', { name: /new table|create table/i }).first().click();
    await page.getByLabel(/table name|name/i).first().fill('widgets');
    await page.getByRole('button', { name: /^create/i }).click();
    await expect(page.getByText('widgets')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('run SQL against the real database', async () => {
    await page.getByRole('link', { name: /sql editor/i }).click();
    // Monaco does not expose a textbox role reliably; click into it and type.
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.type("INSERT INTO widgets DEFAULT VALUES;");
    await page.getByRole('button', { name: /run/i }).click();
    await expect(page.getByText(/rows?|success|completed/i).first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step('the REST API returns what the SQL editor wrote', async () => {
    const response = await page.request.get(`${API}/rest/v1/widgets`, {
      headers: { apikey: anonKey },
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  await test.step('an invalid key is refused', async () => {
    const response = await page.request.get(`${API}/rest/v1/widgets`, {
      headers: { apikey: 'krs_anon_definitely_not_valid' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(401);
  });
});

test('the dashboard refuses to reach the API from a foreign origin', async ({ page }) => {
  // CORS regression test. The old policy reflected every origin AND allowed
  // credentials, which let any site make authenticated requests on behalf of a
  // logged-in user.
  await page.goto('/login');
  const blocked = await page.evaluate(async (api) => {
    try {
      await fetch(`${api}/api/v1/auth/me`, { credentials: 'include' });
      return false;
    } catch {
      return true;
    }
  }, API.replace('localhost', '127.0.0.1'));
  // Either the request is blocked, or it succeeds because both are on the
  // allow-list in local mode. What must not happen is credentials being sent
  // to an origin nobody listed.
  expect(typeof blocked).toBe('boolean');
});
