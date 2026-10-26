import { test, expect, type Page } from '@playwright/test';
import { adminOrderDetail, detailSection, mockAdminSession, mockOrderDetail, openOrderDetail, viewports } from './order-fulfillment-test-utils';

// FREQ-412: ①→122⑥、②→121④、③〜⑥→110③。残る発送止めの理由は詳細で確かめる。
const ORDER_ID = 'a6100000-1111-4222-8333-444455556666';
async function mockApis(page: Page): Promise<void> {
  await mockAdminSession(page);
  await mockOrderDetail(page, () => adminOrderDetail({
    id: ORDER_ID, canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）',
    attention: { paymentExceptions: [{ id: 'f6100000-1111-4222-8333-444455556666', reason: 'amount_mismatch', detectionCount: 1, firstDetectedAt: '2026-10-12T01:00:00Z' }] },
  }));
}
for (const viewport of viewports) {
  test.describe(`FR-ADMIN-061 order list review states (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('支払額の違いの要対応が開いている注文は「発送済みにする」を押せず、理由が表示される', async ({ page }) => {
      // FREQ-412-AC-04
      await mockApis(page);
      await openOrderDetail(page, ORDER_ID);

      const info = detailSection(page, '注文情報');
      await expect(info.getByText('支払額の確認が必要です（要対応）', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      await expect(detailSection(page, '発送').getByRole('link', { name: '荷作り表を開く', exact: true })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockApis(page);
      await openOrderDetail(page, ORDER_ID);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
