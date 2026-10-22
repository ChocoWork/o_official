import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import { mailsTo, runWorkerOnce } from './order-email-test-utils';
import {
  createOrderStatusScenario, expireOrderStatusTestBuckets, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, postOrderStatusVerify, prepareOrderStatusTestLink,
  queueOrderStatusPaidMail, readOrderStatusTestState, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-500-AC-02
  // FREQ-500-AC-03
  // FREQ-505-AC-04
  test(`${viewport.width}px 短い枠と20回の失敗で止まり新しいメール成功で再開する`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const ip = await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public' });
      const token = await prepareOrderStatusTestLink(db, order.orderId);
      await openOrderStatusPage(page, token);
      const wrong = order.lastFour === '0000' ? '1111' : '0000';
      const send = () => postOrderStatusVerify(request, token, wrong, { ip });
      for (let n = 0; n < 5; n += 1) expect((await send()).body.code).toBe('ORDER_STATUS_MISMATCH');
      const sixth = await send();
      expect(sixth.status).toBe(429);
      expect(sixth.body.code).toBe('ORDER_STATUS_RATE_LIMITED');
      expect(Number(sixth.retryAfter) > 0).toBe(true);
      expect((await readOrderStatusTestState(db, order.orderId)).failedAttempts).toBe(5);
      await expireOrderStatusTestBuckets(db, { ip, orderId: order.orderId });
      expect((await send()).body.code).toBe('ORDER_STATUS_MISMATCH');
      // 入力の誤り（下4桁が4桁に満たない）は 400 で、失敗の合計（今は6）を増やさない。
      const invalidInput = await postOrderStatusVerify(request, token, '12', { ip });
      expect(invalidInput.status).toBe(400);
      expect(invalidInput.body.code).toBe('ORDER_STATUS_INPUT_INVALID');
      expect((await readOrderStatusTestState(db, order.orderId)).failedAttempts).toBe(6);
      // 存在しないトークンの 404 も IP の枠を使う。枠を移した後の30回で IP の上限に届き、別の注文でも次は 429 になる。
      await expireOrderStatusTestBuckets(db, { ip, orderId: order.orderId });
      const invalidToken = randomBytes(32).toString('base64url');
      for (let n = 0; n < 30; n += 1) expect((await postOrderStatusVerify(request, invalidToken, wrong, { ip })).status).toBe(404);
      const another = await createOrderStatusScenario(db, { kind: 'public' });
      const anotherToken = await prepareOrderStatusTestLink(db, another.orderId);
      expect((await postOrderStatusVerify(request, anotherToken, wrong, { ip })).status).toBe(429);
      expect((await readOrderStatusTestState(db, another.orderId)).failedAttempts).toBe(0);
      await expireOrderStatusTestBuckets(db, { ip, orderId: another.orderId });
      expect((await postOrderStatusVerify(request, anotherToken, wrong, { ip })).body.code).toBe('ORDER_STATUS_MISMATCH');
      // 実DBの比較を14回進め、6→20の境界を通す。時刻を待たず自分の枠だけを移す。
      let twentieth: Awaited<ReturnType<typeof send>> | undefined;
      for (let n = 7; n <= 20; n += 1) {
        await expireOrderStatusTestBuckets(db, { ip, orderId: order.orderId });
        twentieth = await send();
        expect(twentieth.status).toBe(400);
        expect(twentieth.body.code).toBe('ORDER_STATUS_MISMATCH');
      }
      expect(twentieth?.body.verifiable).toBe(false);
      expect(twentieth?.body.reason).toBe('locked');
      expect((await readOrderStatusTestState(db, order.orderId)).failedAttempts).toBe(20);
      const locked = await send();
      expect(locked.status).toBe(423);
      expect(locked.body.code).toBe('ORDER_STATUS_LOCKED');
      await openOrderStatusPage(page, token);
      await expect(page.getByText('確認できる回数を超えました。ログインするか、お問い合わせください。', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '確かめる', exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      // 期限を直接延長せず、新本文の paid を worker から送信する。
      const email = await queueOrderStatusPaidMail(db, order.orderId);
      await expect.poll(async () => {
        await runWorkerOnce(request);
        return (await readOrderStatusTestState(db, order.orderId)).failedAttempts;
      }, { timeout: 90_000, message: '新しいメールの送信成功が失敗数を戻す' }).toBe(0);
      expect((await mailsTo(request, email)).length > 0).toBe(true);
      await openOrderStatusPage(page, token);
      await expect(page.getByRole('button', { name: '確かめる', exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expireOrderStatusTestBuckets(db, { ip, orderId: order.orderId });
      expect((await postOrderStatusVerify(request, token, order.lastFour!, { ip })).status).toBe(200);
    });
  });
}
