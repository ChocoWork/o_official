import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-DETAIL-001 ルック詳細の基本表示', () => {
  test('FR-LOOK-DETAIL-001-AC-01 テーマ・シーズンラベル・メイン画像・説明文を表示する', async ({ page }) => {
    // 見本の LOOK 1（supabase/seed.sql）: 2026 SS・Aoi Weekend Layers
    await page.goto('/look/1');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Aoi Weekend Layers/i);
    // FREQ-179: ビューポートによって表示されるギャラリーが異なるため、可視の画像を検証する
    await expect(page.locator('img:visible').first()).toBeVisible();
    await expect(page.getByText('2026 SS', { exact: true })).toBeVisible();
    await expect(page.getByText('Aoi synthetic styling with linen layers.', { exact: true })).toBeVisible();
  });
});
