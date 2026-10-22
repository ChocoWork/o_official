import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, expectOrderStatusPrivateVisible, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, prepareOrderStatusTestLink, readOrderStatusPrivate,
  reloadOrderStatusPage, verifyOrderStatusInPage, withOrderStatusDb,
  setOrderStatusTestState,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-499-AC-01
  // FREQ-499-AC-02
  // FREQ-499-AC-03
  // FREQ-505-AC-04
  test(`${viewport.width}px 下4桁の確認で指定の情報だけを見られ同じブラウザで覚える`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const first = await createOrderStatusScenario(db, { kind: 'returns', phone: '+８１ (９０) １２３４-５６７８' });
      const token = await prepareOrderStatusTestLink(db, first.orderId);
      await openOrderStatusPage(page, token);
      await verifyOrderStatusInPage(page, '５６７８');
      expect((await readOrderStatusPrivate(page, token)).body.access).toBe('verified');
      await expectOrderStatusPrivateVisible(page, { returns: true });
      const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === 'sb-order-status');
      const cookie = cookies.find((value) => value.path === `/api/order-status/${token}`);
      expect(Boolean(cookie)).toBe(true);
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe('Strict');
      expect(cookie?.secure).toBe(true); // controller は本番ビルドで実行する。
      expect((cookie?.expires ?? 0) > Date.now() / 1000).toBe(true);
      expect((cookie?.expires ?? Infinity) <= Date.now() / 1000 + 86_402).toBe(true);
      expect(await page.evaluate(() => document.cookie.includes('sb-order-status='))).toBe(false);
      await reloadOrderStatusPage(page);
      await expectOrderStatusPrivateVisible(page, { returns: true });
      await expectNoHorizontalOverflow(page);

      const second = await createOrderStatusScenario(db, { kind: 'public' });
      const secondToken = await prepareOrderStatusTestLink(db, second.orderId);
      const shorterDeadline = new Date(Date.now() + 3_600_000);
      await setOrderStatusTestState(db, { orderId: second.orderId, verifyUntil: shorterDeadline.toISOString() });
      await openOrderStatusPage(page, secondToken);
      expect((await readOrderStatusPrivate(page, secondToken)).body.access).toBe('none');
      await verifyOrderStatusInPage(page, second.lastFour!);
      expect((await readOrderStatusPrivate(page, secondToken)).body.access).toBe('verified');
      const shorter = (await page.context().cookies()).find((value) => value.name === 'sb-order-status' && value.path === `/api/order-status/${secondToken}`);
      expect((shorter?.expires ?? Infinity) <= shorterDeadline.getTime() / 1000 + 2).toBe(true);
      const paths = (await page.context().cookies()).filter((value) => value.name === 'sb-order-status').map((value) => value.path);
      expect(paths.length).toBe(2);
      expect(paths.includes(`/api/order-status/${token}`) && paths.includes(`/api/order-status/${secondToken}`)).toBe(true);
      // 付け替えの拒否を期限差で通してしまわないよう、2件目のDB期限を十分先へ戻す。
      await setOrderStatusTestState(db, { orderId: second.orderId, verifyUntil: new Date(Date.now() + 21 * 86_400_000).toISOString() });
      // 値・path は assertion の差分へ出さず、別注文への付け替えだけを試す。
      await page.context().clearCookies({ name: 'sb-order-status' });
      if (!cookie) throw new Error('確認印を保存できない');
      try { await page.context().addCookies([{ ...cookie, path: `/api/order-status/${secondToken}` }]); }
      catch { throw new Error('別注文への確認印の付け替えを試せない'); }
      expect((await readOrderStatusPrivate(page, secondToken)).body.access).toBe('none');
      await reloadOrderStatusPage(page);
      await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });
  });
}
