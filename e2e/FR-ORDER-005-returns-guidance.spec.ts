import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusCancelCase, createOrderStatusReturnCase, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, prepareOrderStatusTestLink, STATUS_SHOP_MESSAGE,
  withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-498-AC-03
  // FREQ-502-AC-02
  // FREQ-502-AC-03
  // FREQ-504-AC-04
  // FREQ-505-AC-04
  test(`${viewport.width}px 返品とキャンセルの記録を見せ申し込みは2つの道へ案内する`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const cases = [
        ['requested', 'お申し込み中'], ['accepted', '返品の受付済み'],
        ['partially_received', '一部をお受け取りしました'], ['inspecting', 'お受け取りしました（確かめています）'],
        ['awaiting_fee', 'お支払いをお待ちしています'], ['refund_preparing', 'ご返金の準備中'],
        ['returned', '返品済み'], ['declined', 'お受けできませんでした'],
      ] as const;
      let lastToken = '';
      let orderId = '';
      for (const [state, label] of cases) {
        ({ orderId } = await createOrderStatusReturnCase(db, state));
        lastToken = await prepareOrderStatusTestLink(db, orderId);
        await openOrderStatusPage(page, lastToken);
        await expect(page.getByRole('heading', { name: '返品・交換', exact: true })).toBeVisible();
        await expect(page.getByText(label, { exact: true })).toBeVisible();
        if (state === 'declined') {
          await expect(page.getByText(STATUS_SHOP_MESSAGE, { exact: true })).toBeVisible();
          expect(await page.locator('[data-e5-shop-html]').count()).toBe(0);
        }
        for (const name of ['返品・交換を申し込む', 'キャンセルを申し込む']) {
          await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
        }
        await expect(page.locator('main form')).toHaveCount(1); // 下4桁の確認欄だけ。
        expect(await page.locator('[data-testid="return-request-form"], [data-testid="cancel-request-form"]').count()).toBe(0);
        await expectNoHorizontalOverflow(page);
      }
      for (const [state, label] of [
        ['requested', 'キャンセルのお申し込み中'],
        ['declined', 'キャンセルのお申し込みをお受けできませんでした'],
        ['resolved', 'キャンセルのお申し込みのお手続きが済みました'],
        ['closed', 'キャンセルのお申し込みのお手続きが済みました'],
      ] as const) {
        ({ orderId } = await createOrderStatusCancelCase(db, state));
        lastToken = await prepareOrderStatusTestLink(db, orderId);
        await openOrderStatusPage(page, lastToken);
        await expect(page.getByText(label, { exact: true })).toBeVisible();
        for (const name of ['返品・交換を申し込む', 'キャンセルを申し込む']) {
          await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
        }
        await expectNoHorizontalOverflow(page);
      }
      await expect(page.getByText('ご注文の時と同じメールアドレスで会員登録し、メールの確認を済ませると、このご注文が会員の注文履歴に入り、そこから返品・キャンセルを申し込めます。', { exact: true })).toBeVisible();
      await expect(page.getByText('会員登録をせずにお申し込みをご希望の方は、お問い合わせからご連絡ください。注文番号は入力済みで開きます。', { exact: true })).toBeVisible();
      await page.getByRole('link', { name: '会員登録して申し込む', exact: true }).click();
      // クリック直後は画面遷移の途中。到着するまで待ってから行き先を確かめる。
      await expect.poll(() => page.evaluate(() => location.pathname === '/login' && location.search === '?tab=register')).toBe(true);
      await expect(page.getByRole('tab', { name: /会員登録/ })).toHaveAttribute('aria-selected', 'true');
      await openOrderStatusPage(page, lastToken);
      await page.getByRole('link', { name: 'お問い合わせから申し込む', exact: true }).click();
      await expect(page.getByLabel('ORDER NO. / 注文番号（任意）')).toHaveValue(`ORD-${orderId.slice(0, 8).toUpperCase()}`);
      await expect(page.getByRole('combobox', { name: 'お問い合わせ内容' })).toContainText('ご注文について');
      await expectNoHorizontalOverflow(page);
    });
  });
}
