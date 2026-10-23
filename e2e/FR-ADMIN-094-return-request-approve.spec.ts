import { listOrderReturns } from '@/lib/orders/returns/return-store';
import { dialogFooterClose } from './admin-test-utils';
import { addVariant, returnLabelOf } from './return-test-utils';
import {
  test, expect, viewports, shipped, line, requestDb, photoFiles, directUpload,
  adminScene, openReview, approveDb, defaultApproval, noOverflow,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ADMIN-094 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('写真を大きく見て閉じ、解決・返送・メモ・知らせを決めて承認し、DB に残す', async ({ page, rr }) => {
      // FREQ-476-AC-06, FREQ-478-AC-01, FREQ-478-AC-02, FREQ-478-AC-03
      const fx = await shipped(rr);
      await rr.login();
      const files = await photoFiles(page);
      const ids = [await directUpload(page, fx.orderId, files.jpeg), await directUpload(page, fx.orderId, files.jpeg)];
      const ret = await requestDb(rr, fx, [line(fx, 0, { photoUploadIds: ids })]);
      await rr.setItem(fx.itemId, true);
      const variant = await addVariant(rr.db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
      const scene = await adminScene(page, rr, fx);
      let dialog = await openReview(page, fx, ret.number);
      await expect(dialog).toContainText('詳しい内容: 試験の詳しい内容');
      await expect(dialog).toContainText('ご希望: 返金');
      await expect(dialog).toContainText('返品不可の品です');
      await dialog.getByRole('button', { name: '写真 1 を大きく見る', exact: true }).click();
      const viewer = page.getByRole('dialog', { name: '写真（1／2）', exact: true });
      await expect(viewer).toBeVisible();
      expect(await page.getByRole('dialog').count()).toBe(1);
      await expect.poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await viewer.getByRole('button', { name: '次の写真', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '写真（2／2）', exact: true })).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: '前の写真', exact: true }).click();
      await dialogFooterClose(page.getByRole('dialog')).click();
      dialog = page.getByRole('dialog', { name: '返品の申し込みを確かめる（' + returnLabelOf(fx.orderId, ret.number) + '）', exact: true });
      const resolution = dialog.getByRole('group', { name: 'E2Eシャツ（ホワイト / M）の解決', exact: true });
      await resolution.getByRole('combobox', { name: '解決の方法', exact: true }).selectOption('exchange');
      await resolution.getByRole('combobox', { name: '交換の色・サイズ', exact: true }).selectOption(String(variant));
      await resolution.getByRole('combobox', { name: '送り方', exact: true }).selectOption('stock');
      await dialog.getByRole('combobox', { name: '返送の方法', exact: true }).selectOption('customer_ships');
      await dialog.getByRole('textbox', { name: 'メモ（お客様には見えません）', exact: true }).fill('承認時の試験メモ');
      await dialog.getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る', exact: true }).check();
      await dialog.getByRole('button', { name: '承認する', exact: true }).click();
      await expect.poll(() => scene.posts.approve.length).toBe(1);
      expect(scene.posts.approve[0]).toMatchObject({
        lines: [{ resolution: 'exchange', exchangeVariantId: variant, exchangeMethod: 'stock' }],
        returnMethod: 'customer_ships', shopNote: '承認時の試験メモ', notifyCustomer: true,
      });
      expect(Object.keys(scene.posts.approve[0])).not.toContain('requestKey');
      const saved = (await rr.db.query('select status,approved_at is not null as approved,approved_by,shop_note from public.order_returns where id=$1', [ret.id])).rows[0];
      expect(saved).toMatchObject({ status: 'open', approved: true, approved_by: fx.actorId, shop_note: '承認時の試験メモ' });
      const lines = (await rr.db.query('select requested_resolution,resolution,exchange_variant_id from public.order_return_lines where return_id=$1', [ret.id])).rows[0];
      expect(lines.requested_resolution).toBe('refund'); expect(lines.resolution).toBe('exchange');
      expect(Number(lines.exchange_variant_id)).toBe(variant);
      expect(Number((await rr.db.query("select count(*) from private.order_email_outbox where return_id=$1 and kind='return_accepted'", [ret.id])).rows[0].count)).toBe(1);
      await noOverflow(page);
    });

    test('返送不要で承認すると受け取りの画面がすぐ開く', async ({ page, rr }) => {
      // FREQ-478-AC-05
      const fx = await shipped(rr);
      const ret = await requestDb(rr, fx);
      const scene = await adminScene(page, rr, fx);
      const dialog = await openReview(page, fx, ret.number);
      await dialog.getByRole('combobox', { name: '返送の方法', exact: true }).selectOption('not_required');
      await dialog.getByRole('checkbox', { name: 'お客様に返品の受付のお知らせを送る', exact: true }).uncheck();
      await dialog.getByRole('button', { name: '承認する', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '受け取る（' + returnLabelOf(fx.orderId, ret.number) + '）', exact: true })).toBeVisible();
      expect(scene.posts.approve[0].returnMethod).toBe('not_required');
      expect((await rr.db.query('select status,return_method from public.order_returns where id=$1', [ret.id])).rows[0])
        .toEqual({ status: 'open', return_method: 'not_required' });
    });

    test('別の担当者が先に承認した時は状態の言葉を出して読み直す', async ({ page, rr }) => {
      // FREQ-478-AC-06
      const fx = await shipped(rr);
      const ret = await requestDb(rr, fx);
      const scene = await adminScene(page, rr, fx);
      const dialog = await openReview(page, fx, ret.number);
      await approveDb(rr, ret.id, await defaultApproval(rr, fx, ret.id), fx.actorId);
      scene.state.returns = await listOrderReturns(rr.client, fx.orderId);
      await page.route('**/api/admin/returns/' + ret.id + '/approve', (route) => route.fulfill({
        status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: '返品の状態が変わりました。画面を開き直してください。', code: 'RETURN_STATE_CONFLICT' }),
      }));
      const reads = scene.state.listReads;
      await dialog.getByRole('button', { name: '承認する', exact: true }).click();
      await expect.poll(() => scene.state.listReads).toBeGreaterThan(reads);
      expect(Number((await rr.db.query("select count(*) from private.order_email_outbox where return_id=$1 and kind='return_accepted'", [ret.id])).rows[0].count)).toBe(0);
    });
  });
}
