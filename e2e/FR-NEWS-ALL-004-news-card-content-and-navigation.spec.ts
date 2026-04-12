import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-004 card content and navigation', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('記事カードが必要情報を表示し、クリックで詳細へ遷移する', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const firstCard = page.locator('article').first();
    await expect(firstCard).toBeVisible();

    const dateText = (await firstCard.locator('span').first().textContent())?.trim() ?? '';
    expect(dateText).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);

    const title = firstCard.getByRole('heading', { level: 2 }).first();
    await expect(title).toBeVisible();
    const titleText = (await title.textContent())?.trim() ?? '';
    expect(titleText.length).toBeGreaterThan(0);

    const summary = firstCard.locator('p').first();
    await expect(summary).toBeVisible();
    const summaryText = (await summary.textContent())?.trim() ?? '';
    expect(summaryText.length).toBeGreaterThan(0);

    const firstLink = page.locator('a[href^="/news/"]').first();
    await firstLink.click();
    await expect(page).toHaveURL(/\/news\/[0-9a-f-]+(\?category=[A-Z]+)?$/);
  });
});
