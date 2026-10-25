import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-003 LOOK一覧の表示件数要件', () => {
  test('FR-LOOK-ALL-003-AC-01 LOOK一覧でカードが表示され、6件以上存在する場合でも一覧表示が成立する', async ({ page }) => {
    await page.goto('/look');

    await expect(page.locator('main [data-testid="look-card"]').first()).toBeVisible();

    // 見本の公開の LOOK は 7 件（supabase/seed.sql）なので、6 件以上のカードが出る
    expect(await page.locator('main [data-testid="look-card"]').count()).toBeGreaterThanOrEqual(6);
  });
});
