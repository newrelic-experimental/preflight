import { test, expect } from '@playwright/test';

test.describe('Today view — empty state', () => {
  test('shows empty state when no activity today', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('No activity yet today')).toBeVisible();
    await expect(page.getByText('spend today')).not.toBeVisible();
  });

  test('shows header with Today title and timestamp', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    // Timestamp is rendered in the header span
    const header = page.locator('header');
    await expect(header.locator('span')).toBeVisible();
  });

  test('does not show KPI cards or session list in empty state', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('No activity yet today')).toBeVisible();
    await expect(page.getByText('forecast')).not.toBeVisible();
    await expect(page.getByText('session live tail')).not.toBeVisible();
  });

  test('screenshot: empty state', async ({ page }) => {
    // The server asks the live npm registry for the latest release, and the sidebar adds a
    // "v<x> available" line when it is newer than the build, which no baseline can predict.
    // Answer as up to date, the state the baselines were drawn in.
    await page.route('**/api/health', async (route) => {
      const response = await route.fetch();
      const health = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...health, latestVersion: null, updateAvailable: false },
      });
    });
    await page.goto('/');
    await expect(page.getByText('No activity yet today')).toBeVisible();
    // Wait for animations to settle
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot('today-empty-state.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
