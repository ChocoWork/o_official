import { expect, test } from '@playwright/test';

test.describe('FR-STOCKIST-002 カード情報表示', () => {
  test('店舗名・住所・電話・営業時間・定休日を表示する', async ({ page }) => {
    await page.goto('/stockist');

    const firstCard = page.locator('article').first();
    await expect(firstCard.locator('h2')).toBeVisible();
    await expect(firstCard.locator('.ri-map-pin-line')).toBeVisible();
    await expect(firstCard.locator('.ri-phone-line')).toBeVisible();
    await expect(firstCard.locator('.ri-time-line')).toBeVisible();
    await expect(firstCard.locator('.ri-calendar-line')).toBeVisible();
  });
});
