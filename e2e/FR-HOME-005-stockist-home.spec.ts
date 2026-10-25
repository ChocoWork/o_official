import { test, expect } from '@playwright/test';
import { withHomeCatalogLock, withLocalDb } from './home-test-utils';
import { stockistTag, withStockists } from './stockist-test-utils';

// 公開の取扱店が 7 件以上ある場面を作るため、公開の取扱店を 1 件足して（seed は 6 件）、終わりに消す。
// 取扱店の並びを読む他の HOME の試験と重ならないよう、home-test-utils の withHomeCatalogLock（排他）の中で流す。
test.describe('FR-HOME-005 stockist home section', () => {
  test('FR-HOME-005-AC-01 公開の取扱店が7件以上あっても、ホームの取扱店の区画に出る店は1件以上6件以下', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });

    await withHomeCatalogLock('exclusive', () =>
      withStockists(
        [{ name: stockistTag(), status: 'published' }],
        async () => {
          const published = await withLocalDb(async (db) => {
            const result = await db.query(`select count(*)::int as n from public.stockists where status = 'published'`);
            return Number(result.rows[0].n);
          });
          expect(published, '前提: 公開の取扱店が7件以上ある').toBeGreaterThanOrEqual(7);

          await page.goto('/');
          const stockistSection = page.locator('#stockist');
          await expect(stockistSection).toBeVisible();

          const cards = stockistSection.locator('article');
          await expect(cards.first()).toBeVisible();
          const cardCount = await cards.count();
          expect(cardCount).toBeGreaterThanOrEqual(1);
          expect(cardCount).toBeLessThanOrEqual(6);
        },
      ),
    );
  });
});
