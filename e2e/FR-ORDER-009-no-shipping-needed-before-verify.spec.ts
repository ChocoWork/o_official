import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusReturnCase, isolateOrderStatusApiIp, openOrderStatusPage, orderStatusViewports,
  prepareOrderStatusTestLink, STATUS_PRIVATE, verifyOrderStatusInPage, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

const NO_SHIPPING = '品物のご返送は不要です。';
const SEND_TO = '下記の返送先へお送りください。';

/** お店の返送先の住所が画面のどこかに出ているか（値は出さず true/false だけ）。 */
async function returnAddressShown(page: Page): Promise<boolean> {
  return page.evaluate((address) => document.body.textContent?.includes(address) ?? false, STATUS_PRIVATE.returnAddress);
}

for (const viewport of orderStatusViewports) {
  // FREQ-512-AC-01
  // FREQ-512-AC-02
  // FREQ-512-AC-03
  // FREQ-512-AC-04
  test(`${viewport.width}px 返送不要の返品は確かめる前から返送不要の文を1回出し、返送先は確かめた後だけ出す`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      for (const state of ['accepted', 'partially_received'] as const) {
        const order = await createOrderStatusReturnCase(db, state, { returnMethod: 'not_required' });
        const token = await prepareOrderStatusTestLink(db, order.orderId);
        await openOrderStatusPage(page, token);
        // 確かめる前（下4桁の欄が出ている）
        await expect(page.getByRole('button', { name: '確かめる', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: '返送のしかた', exact: true })).toBeVisible();
        await expect(page.getByText(NO_SHIPPING, { exact: true })).toHaveCount(1);
        expect(await returnAddressShown(page), '確かめる前に返送先の住所が出ない').toBe(false);
        await expectNoHorizontalOverflow(page);
        // 確かめた後も同じ文は1回だけ
        await verifyOrderStatusInPage(page, order.lastFour!);
        await expect(page.getByText(NO_SHIPPING, { exact: true })).toHaveCount(1);
        expect(await returnAddressShown(page), '返送不要の返品には返送先の住所が出ない').toBe(false);
        await expectNoHorizontalOverflow(page);
      }

      // 返送不要でも、お受け取りの後（確かめ中）には出さない
      const inspecting = await createOrderStatusReturnCase(db, 'inspecting', { returnMethod: 'not_required' });
      await openOrderStatusPage(page, await prepareOrderStatusTestLink(db, inspecting.orderId));
      await expect(page.getByText('お受け取りしました（確かめています）', { exact: true })).toBeVisible();
      await expect(page.getByText(NO_SHIPPING, { exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);

      // 返送が要る返品は、返送先・返送料の文を確かめた後だけ出す
      const required = await createOrderStatusReturnCase(db, 'accepted');
      await openOrderStatusPage(page, await prepareOrderStatusTestLink(db, required.orderId));
      await expect(page.getByText('返品の受付済み', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '確かめる', exact: true })).toBeVisible();
      await expect(page.getByText(NO_SHIPPING, { exact: true })).toHaveCount(0);
      await expect(page.getByText(SEND_TO, { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('order-return-shipping')).toHaveCount(0);
      expect(await returnAddressShown(page), '確かめる前に返送先の住所が出ない').toBe(false);
      await verifyOrderStatusInPage(page, required.lastFour!);
      await expect(page.getByRole('heading', { name: '返品の返送先・送り返しの伝票番号', exact: true })).toBeVisible();
      await expect(page.getByText(SEND_TO, { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('order-return-shipping')).toHaveCount(1);
      expect(await returnAddressShown(page), '確かめた後は返送先の住所が出る').toBe(true);
      await expect(page.getByText(NO_SHIPPING, { exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });
  });
}
