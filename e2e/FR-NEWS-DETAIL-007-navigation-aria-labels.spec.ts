import { expect, test } from '@playwright/test';
import { getNewsDetailHrefs, gotoNewsList } from './news-detail-test-utils';

test.describe('FR-NEWS-DETAIL-007 navigation aria labels', () => {
  test('前後リンクにaria-labelを付与する', async ({ page }) => {
    await gotoNewsList(page);
    const hrefs = await getNewsDetailHrefs(page);
    test.skip(hrefs.length === 0, 'ニュース記事が存在しないためスキップ');

    const targetHref = hrefs.length >= 3 ? hrefs[1] : hrefs[0];
    await page.goto(targetHref, { waitUntil: 'domcontentloaded' });

    const prevLink = page.locator('a[aria-label^="前の記事"], a[aria-label^="Previous article"]');
    const nextLink = page.locator('a[aria-label^="次の記事"], a[aria-label^="Next article"]');

    if (await prevLink.count()) {
      await expect(prevLink.first()).toHaveAttribute('aria-label', /前の記事|Previous article/);
    }

    if (await nextLink.count()) {
      await expect(nextLink.first()).toHaveAttribute('aria-label', /次の記事|Next article/);
    }

    if (hrefs.length > 1) {
      expect((await prevLink.count()) + (await nextLink.count())).toBeGreaterThan(0);
    }
  });
});
