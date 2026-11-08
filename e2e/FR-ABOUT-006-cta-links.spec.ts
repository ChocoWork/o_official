import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-006 CTAリンク', () => {
  test('FR-ABOUT-006-AC-01 VIEW COLLECTION / VIEW LOOKBOOK の2導線を表示し、CONTACT への導線は置かない', async ({ page }) => {
    await page.goto('/about');

    const collection = page.getByRole('link', { name: 'VIEW COLLECTION' });
    await expect(collection).toHaveAttribute('href', '/item');
    await expect(page.getByRole('link', { name: 'VIEW LOOKBOOK' })).toHaveAttribute('href', '/look');
    // CTA の並び（2つのリンクを囲む行）に /contact へのリンクが無い。ヘッダー・フッターは対象外。
    await expect(collection.locator('..').locator('a[href="/contact"]')).toHaveCount(0);
  });
});
