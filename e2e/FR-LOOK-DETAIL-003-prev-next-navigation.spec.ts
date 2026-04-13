import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

test.describe('FR-LOOK-DETAIL-003 前後ルックナビゲーション', () => {
  test('PREV/NEXTリンクを表示し遷移できる', async ({ page }) => {
    const currentPath = await gotoFirstLookDetail(page);

    const prevLink = page.getByRole('link', { name: /prev/i });
    const nextLink = page.getByRole('link', { name: /next/i });

    const hasPrev = await prevLink.isVisible().catch(() => false);
    const hasNext = await nextLink.isVisible().catch(() => false);

    expect(hasPrev || hasNext).toBeTruthy();

    if (hasNext) {
      await nextLink.click();
      await expect(page).not.toHaveURL(new RegExp(`${currentPath}$`));
      return;
    }

    if (hasPrev) {
      await prevLink.click();
      await expect(page).not.toHaveURL(new RegExp(`${currentPath}$`));
    }
  });
});
