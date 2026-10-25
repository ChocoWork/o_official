import { expect, test } from '@playwright/test';
import { getNewsDetailHrefs, gotoNewsList } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-003 detail navigation links', () => {
  test('FR-NEWS-DETAIL-003-AC-01 前後記事ナビゲーションと一覧遷移を提供する', async ({ page }) => {
    await gotoNewsList(page);
    const hrefs = await getNewsDetailHrefs(page);
    // AC は「記事が2件以上あるとき」。見本は公開 8 件なので 2 件以上あることも確かめる。
    expect(hrefs.length).toBeGreaterThan(1);

    // 並列の試験（FR-HOME-023）が足す公開の記事に前後を変えられないよう、前後が見本の行だけになる見本の id 3 を開く（前後は id 2 と id 4）。
    await page.goto('/news/3', { waitUntil: 'domcontentloaded' });

    const prevLink = page.locator('a[aria-label^="前の記事"]:visible, a[aria-label^="Previous article"]:visible');
    const nextLink = page.locator('a[aria-label^="次の記事"]:visible, a[aria-label^="Next article"]:visible');
    const viewAllLink = page.getByRole('link', { name: 'VIEW ALL' }).first();

    expect((await prevLink.count()) + (await nextLink.count())).toBeGreaterThan(0);
    await expect(viewAllLink).toBeVisible();

    await viewAllLink.click();
    await expect(page).toHaveURL(/\/news(\?.*)?$/);
  });
});
