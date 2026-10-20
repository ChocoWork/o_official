import { test, expect, viewports, unshipped } from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-040 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('キャンセルの欄を開いた後に受付がオフになったら、キャンセルの言葉だけを表示する', async ({ page, rr }) => {
      // FREQ-487-AC-01, FREQ-487-AC-02
      await rr.db.query("update public.shop_return_settings set request_types='returns_and_cancellations' where id=1");
      const fx = await unshipped(rr);
      await rr.login();
      await page.goto('/account/orders/' + fx.orderId);
      await page.getByTestId('order-cancel-open').click();
      const form = page.getByTestId('cancel-request-form');
      await expect(form.getByRole('heading', { name: 'キャンセルのお申し込み', exact: true })).toBeVisible();
      await form.getByRole('checkbox', { name: 'E2Eシャツ（ホワイト / M）', exact: true }).check();

      // 開いている間の設定変更を再現し、送信時に DB が断った言葉を確かめる。
      await rr.db.query('update public.shop_return_settings set requests_enabled=false where id=1');
      await form.getByRole('button', { name: '申し込む', exact: true }).click();

      await expect(form.getByRole('alert')).toHaveText('現在、キャンセルのお申し込みを受け付けていません。');
      await expect(page.getByText('現在、返品・交換のお申し込みを受け付けていません。', { exact: true })).toHaveCount(0);
    });
  });
}
