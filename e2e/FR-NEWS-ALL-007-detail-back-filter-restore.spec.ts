import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-007 detail back filter restore', () => {
  test('単一カテゴリ選択時に詳細遷移後のブラウザ戻るでフィルタが復元される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'EVENT', exact: true }).click();
    await expect(page).toHaveURL(/\/news\?category=EVENT$/);

    await page.locator('a[href^="/news/"]').first().click();
    await expect(page).toHaveURL(/\/news\/[0-9a-f-]+\?category=EVENT$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/news\?category=EVENT$/);
    await expect(page.getByRole('button', { name: 'EVENT', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('複数カテゴリ選択時に詳細遷移後のブラウザ戻るでフィルタが復元される', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    const trigger = page.locator('button[aria-haspopup="listbox"]');
    await trigger.click();
    await page.waitForTimeout(200);

    const dropdownItems = page.locator('[aria-haspopup="listbox"] ~ div label');
    await dropdownItems.nth(1).click();
    await page.waitForTimeout(100);
    await dropdownItems.nth(2).click();
    await page.waitForTimeout(200);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await expect(page).toHaveURL(/\/news\?category=[A-Z]+(%2C|,)[A-Z]+$/);

    const detailHref = await page.locator('a[href^="/news/"]').first().getAttribute('href');
    expect(detailHref).not.toBeNull();
    await page.goto(detailHref!, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/news\/[0-9a-f-]+\?category=[A-Z]+(%2C|,)[A-Z]+$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/news\?category=[A-Z]+(%2C|,)[A-Z]+$/);
    await expect(trigger).not.toContainText('ALL');
  });
});
