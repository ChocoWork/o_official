import { expect, test } from '@playwright/test';

test.describe('FR-NEWS-ALL-007 detail back filter restore', () => {
  test('単一カテゴリ選択時に詳細遷移後のブラウザ戻るでフィルタが復元される', async ({ page }) => {
    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    await page.getByRole('checkbox', { name: 'EVENT', exact: true }).click();
    await expect(page).toHaveURL(/\/news\?category=EVENT$/);

    await page.locator('a[href^="/news/"]').first().click();
    await expect(page).toHaveURL(/\/news\/[0-9a-f-]+\?category=EVENT$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/news\?category=EVENT$/);
    await expect(page.getByRole('checkbox', { name: 'EVENT', exact: true })).toBeChecked();
  });

  test('複数カテゴリ選択時に詳細遷移後のブラウザ戻るでフィルタが復元される', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('/news');
    await page.waitForLoadState('networkidle');

    // モバイルではカテゴリの絞り込みが FILTER の Drawer に入る。
    await page.getByRole('button', { name: 'FILTER' }).click();
    await page.getByRole('checkbox', { name: 'EVENT', exact: true }).click();
    await page.getByRole('checkbox', { name: 'COLLECTION', exact: true }).click();

    await expect(page).toHaveURL(/\/news\?category=[A-Z]+(%2C|,)[A-Z]+$/);

    const detailHref = await page.locator('a[href^="/news/"]').first().getAttribute('href');
    expect(detailHref).not.toBeNull();
    await page.goto(detailHref!, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/news\/[0-9a-f-]+\?category=[A-Z]+(%2C|,)[A-Z]+$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/news\?category=[A-Z]+(%2C|,)[A-Z]+$/);
    // 戻ったあとも選択が復元されている。Drawer は閉じているので開き直して確認する。
    await page.getByRole('button', { name: 'FILTER' }).click();
    await expect(page.getByRole('checkbox', { name: 'EVENT', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'ALL', exact: true })).not.toBeChecked();
  });
});
