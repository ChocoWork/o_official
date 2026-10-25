import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-001 公開済みルック一覧', () => {
  test('FR-LOOK-ALL-001-AC-01 公開済みルックをカードグリッドで表示する', async ({ page }) => {
    await page.goto('/look');

    const cards = page.locator('[data-testid="look-card"]');
    await expect(cards.first()).toBeVisible();

    // 見本の公開の LOOK は 7 件（supabase/seed.sql）。他の spec が足した分は増えるだけ
    expect(await cards.count()).toBeGreaterThanOrEqual(7);
  });
});
