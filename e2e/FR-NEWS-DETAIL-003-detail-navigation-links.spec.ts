import { expect, test } from '@playwright/test';
import { getNewsDetailHrefs, gotoNewsList } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-003 detail navigation links', () => {
  test('前後記事ナビゲーションと一覧遷移を提供する', async ({ page }) => {
    await gotoNewsList(page);
    const hrefs = await getNewsDetailHrefs(page);
    test.skip(hrefs.length === 0, 'ニュース記事が存在しないためスキップ');

    const targetHref = hrefs.length >= 3 ? hrefs[1] : hrefs[0];
    await page.goto(targetHref, { waitUntil: 'domcontentloaded' });

    const prevLink = page.locator('a[aria-label^="前の記事"]:visible, a[aria-label^="Previous article"]:visible');
    const nextLink = page.locator('a[aria-label^="次の記事"]:visible, a[aria-label^="Next article"]:visible');
    const viewAllLink = page.getByRole('link', { name: 'VIEW ALL' }).first();

    if (hrefs.length > 1) {
      expect((await prevLink.count()) + (await nextLink.count())).toBeGreaterThan(0);
    }
    await expect(viewAllLink).toBeVisible();

    await viewAllLink.click();
    await expect(page).toHaveURL(/\/news(\?.*)?$/);
  });
});
