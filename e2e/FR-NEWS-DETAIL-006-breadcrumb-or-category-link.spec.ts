import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-006 breadcrumb or category link', () => {
  test('現在位置把握とカテゴリ移動のためのリンクを提供する', async ({ page }) => {
    await gotoFirstNewsDetail(page);

    const newsIndexLink = page.getByRole('link', { name: /NEWS/ }).first();
    await expect(newsIndexLink).toBeVisible();
    await expect(newsIndexLink).toHaveAttribute('href', /\/news(\?.*)?$/);

    const categoryLink = page.getByRole('link', { name: /^(ALL|COLLECTION|EVENT|COLLABORATION|SUSTAINABILITY|STORE)$/ }).first();
    await expect(categoryLink).toBeVisible();
    await expect(categoryLink).toHaveAttribute('href', /\/news\?category=/);
  });
});
