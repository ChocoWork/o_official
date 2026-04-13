import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

test.describe('FR-LOOK-DETAIL-006 metadata / Back link / aria-label', () => {
  test('title/descriptionメタと通常時Backリンク、PREV/NEXT aria-labelを提供する', async ({ page }) => {
    await gotoFirstLookDetail(page);

    await expect(page).toHaveTitle(/LOOK|Look|Le Fil des Heures/i);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);

    const backLink = page.getByRole('link', { name: /Back to Lookbook/i });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/look');

    const prevLink = page.locator('a[aria-label^="Previous look"]');
    const nextLink = page.locator('a[aria-label^="Next look"]');
    const prevCount = await prevLink.count();
    const nextCount = await nextLink.count();

    expect(prevCount + nextCount).toBeGreaterThan(0);
  });
});
