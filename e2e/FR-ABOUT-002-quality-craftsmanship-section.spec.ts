import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-002 WHY WE MAKE', () => {
  test('服づくりの理由と Founder の言葉を表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: 'WHY WE MAKE / なぜ、つくるのか' })).toBeVisible();
    await expect(page.getByText(/Founder, Le Fil des Heures/)).toBeVisible();
  });
});
