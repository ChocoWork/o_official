import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

test.describe('FR-LOOK-DETAIL-001 ルック詳細の基本表示', () => {
  test('テーマ・シーズンラベル・メイン画像・説明文を表示する', async ({ page }) => {
    await gotoFirstLookDetail(page);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('img').first()).toBeVisible();
    await expect(page.locator('p').filter({ hasText: /SS|AW|20\d{2}/ }).first()).toBeVisible();
  });
});
