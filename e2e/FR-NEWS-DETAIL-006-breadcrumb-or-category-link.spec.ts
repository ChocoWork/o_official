import { expect, test } from '@playwright/test';
import { gotoFirstNewsDetail } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-006 breadcrumb or category link', () => {
  test('FR-NEWS-DETAIL-006-AC-01 現在位置把握とカテゴリ移動のためのリンクを提供する', async ({ page }) => {
    await gotoFirstNewsDetail(page);

    // ヘッダーの NEWS リンクではなく、詳細ページ内のパンくずを見る。
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    const newsIndexLink = breadcrumb.getByRole('link', { name: 'NEWS', exact: true });
    await expect(newsIndexLink).toBeVisible();
    await expect(newsIndexLink).toHaveAttribute('href', /^\/news(\?category=.+)?$/);

    // 表示中の記事のカテゴリ名と、リンク先の category が一致する。
    const categoryLink = breadcrumb.getByRole('link').nth(1);
    await expect(categoryLink).toBeVisible();
    const shownCategory = ((await categoryLink.textContent()) ?? '').trim();
    expect(shownCategory).toMatch(/^[A-Z]+$/);
    await expect(categoryLink).toHaveAttribute('href', `/news?category=${encodeURIComponent(shownCategory)}`);
  });
});
