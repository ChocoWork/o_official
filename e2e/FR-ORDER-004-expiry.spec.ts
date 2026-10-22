import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, expectOrderStatusPrivateVisible, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, postOrderStatusVerify, prepareOrderStatusTestLink,
  readOrderStatusPrivate, reloadOrderStatusPage, setOrderStatusSessionForTest, setOrderStatusTestState,
  withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-499-AC-04
  // FREQ-500-AC-04
  // FREQ-505-AC-04
  test(`${viewport.width}px 21日と24時間の後は公開を残して個人情報を消す`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const ip = await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public' });
      const token = await prepareOrderStatusTestLink(db, order.orderId);
      const now = new Date();
      const future = new Date(now.getTime() + 21 * 86_400_000);
      await setOrderStatusSessionForTest(page, { orderId: order.orderId, token, issuedAt: now, verifyUntil: future });
      await openOrderStatusPage(page, token);
      await expectOrderStatusPrivateVisible(page);
      for (const verifyUntil of [null, new Date(now.getTime() - 1_000).toISOString()]) {
        await setOrderStatusTestState(db, { orderId: order.orderId, verifyUntil });
        // Cookie はブラウザに残し、DB の期限が切れた時の再取得で消えることを確かめる。
        expect((await page.context().cookies()).some((cookie) => cookie.name === 'sb-order-status')).toBe(true);
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toHaveCount(0);
        expect((await readOrderStatusPrivate(page, token)).body.access).toBe('none');
        await reloadOrderStatusPage(page);
        await expect(page.getByRole('heading', { name: 'ご注文の状況', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '確かめる', exact: true })).toHaveCount(0);
        await expect(page.getByText('電話番号で確認できる期間が過ぎました。ログインするか、お問い合わせください。', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'ログインする', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'お問い合わせから申し込む', exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
      expect((await postOrderStatusVerify(request, token, order.lastFour!, { ip })).status).toBe(410);
      await setOrderStatusTestState(db, { orderId: order.orderId, verifyUntil: future.toISOString() });
      for (const input of [
        { issuedAt: new Date(now.getTime() - 25 * 3_600_000), keepExpiredTransport: true },
        { issuedAt: now, tamper: true },
      ]) {
        await setOrderStatusSessionForTest(page, { orderId: order.orderId, token, verifyUntil: future, ...input });
        await reloadOrderStatusPage(page);
        expect((await readOrderStatusPrivate(page, token)).body.access).toBe('none');
        await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '確かめる', exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
      // transport 自体が期限切れならブラウザが Cookie を送らない（長時間待たない）。
      await setOrderStatusSessionForTest(page, {
        orderId: order.orderId, token, issuedAt: new Date(now.getTime() - 25 * 3_600_000), verifyUntil: future,
      });
      expect((await page.context().cookies()).some((cookie) => cookie.name === 'sb-order-status')).toBe(false);
      await reloadOrderStatusPage(page);
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('none');
      await expect(page.getByRole('heading', { name: 'ご注文の状況', exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}
