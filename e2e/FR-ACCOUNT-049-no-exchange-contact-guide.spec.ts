/**
 * FR-ACCOUNT-049 交換先が無く不良・誤送を選べない商品の連絡先（FREQ-642-AC-33）。
 * FR-ACCOUNT-048 と同じログイン・写しのある注文・申し込みの本物の材料を使う。
 */
import { createActor } from './order-email-test-utils';
import { appJson, expect, noOverflow, openRequest, test, viewports, addSizeVariant } from './return-request-test-utils';
import { seedSnapshotOrder } from './unit-binding-test-utils';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';

const PRODUCT_NAME = '照合テスト（BLACK / M）';
const GUIDE = 'この商品の不良・誤送は、お問い合わせフォームからご連絡ください。';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-049 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-33: 交換先が無い行に選択前から問い合わせ案内が出て、交換先があれば出ない', async ({ page, rr }) => {
      test.setTimeout(240_000);
      const actorId = await createActor(rr.db);
      const order = await seedSnapshotOrder(rr.db, {
        actorId, buyerUserId: rr.member.userId, email: rr.member.email,
        lines: [{ price: 20_000, quantity: 1 }], definitions: () => [],
      });
      const itemId = order.catalogs[0].itemId;
      await rr.db.query('update public.item_variants set is_active=false where item_id=$1', [itemId]);
      await openRequest(page, rr, order.orderId);
      const row = page.getByRole('group', { name: PRODUCT_NAME, exact: true });
      const guide = row.getByText(GUIDE, { exact: true });
      const link = row.getByRole('link', { name: 'お問い合わせフォーム', exact: true });
      const checkbox = row.getByRole('checkbox', { name: 'この商品を申し込む', exact: true });
      await expect(checkbox).not.toBeChecked();
      await expect(guide).toBeVisible();
      await expect(link).toHaveAttribute('href', '/contact');
      const response = await appJson<{ data: CustomerReturnRequestMaterials }>(page, '/api/orders/' + order.orderId + '/return-request');
      expect(response.status).toBe(200);
      expect(response.body.data.reasons.filter((r) => ['defective', 'wrong_item'].includes(r.reason)).map((r) => r.resolutions))
        .toEqual(['exchange_only', 'exchange_only']);
      await checkbox.check();
      const reasons = row.getByRole('combobox', { name: '理由', exact: true });
      await expect(reasons.locator('option[value="defective"], option[value="wrong_item"]')).toHaveCount(0);
      await expect(guide).toBeVisible();
      await noOverflow(page);

      // 返品不可の行でも、不良・誤送の連絡先を残す。
      await rr.setItem(itemId, true);
      await page.reload();
      await expect(checkbox).toBeDisabled();
      await expect(guide).toBeVisible();
      await expect(link).toHaveAttribute('href', '/contact');
      await noOverflow(page);

      await addSizeVariant(rr.db, itemId, 'BLACK', 'L', 3);
      await page.reload();
      await expect(checkbox).toBeEnabled();
      await expect(guide).toHaveCount(0);
      await expect(link).toHaveCount(0);
      await checkbox.check();
      await expect(row.getByRole('combobox', { name: '理由', exact: true }).locator('option[value="defective"], option[value="wrong_item"]'))
        .toHaveCount(2);
      await noOverflow(page);
    });
  });
}
