import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

test.describe('FR-LOOK-DETAIL-006 metadata / aria-label', () => {
  // FREQ-178: 通常表示の「Back to Lookbook」リンクは削除された（検証は FR-LOOK-DETAIL-010）
  test('title/descriptionメタと PREV/NEXT aria-label を提供する', async ({ page }) => {
    await gotoFirstLookDetail(page);

    await expect(page).toHaveTitle(/LOOK|Look|Le Fil des Heures/i);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);

    const prevLink = page.locator('a[aria-label^="Previous look"]');
    const nextLink = page.locator('a[aria-label^="Next look"]');
    const prevCount = await prevLink.count();
    const nextCount = await nextLink.count();

    expect(prevCount + nextCount).toBeGreaterThan(0);
  });
});
