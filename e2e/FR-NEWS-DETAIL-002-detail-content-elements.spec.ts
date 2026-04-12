import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-002 detail content elements', () => {
  test('タイトル・公開日・カテゴリタグ・本文を表示する', async ({ page }) => {
    await gotoFirstNewsDetail(page);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/^\d{4}\.\d{2}\.\d{2}$/)).toBeVisible();
    await expect(page.locator('span').filter({ hasText: /^(ALL|COLLECTION|EVENT|COLLABORATION|SUSTAINABILITY|STORE)$/ }).first()).toBeVisible();
    await expect(page.locator('main p, p').first()).toBeVisible();
  });
});
