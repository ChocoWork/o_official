import { expect, test, type Page, type Route } from '@playwright/test';
import { expectNoHorizontalOverflow } from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, expectOrderStatusPrivateVisible, isolateOrderStatusApiIp, openOrderStatusPage,
  orderStatusViewports, prepareOrderStatusTestLink, verifyOrderStatusInPage, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

const isPrivateRead = (url: string) => new URL(url).pathname.endsWith('/private');

/** 次の個人情報の読取を1回だけ止めておく（答え待ちの間の画面を確かめるため）。止めた後は素通しにする。 */
async function holdNextPrivateRead(page: Page): Promise<{ held: Promise<void>; release: () => void }> {
  let release: () => void = () => undefined;
  let arrived: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { arrived = resolve; });
  let used = false;
  // 後から登録した handler が先に動く。fallback で isolateOrderStatusApiIp の handler（IP の付け替え）へ渡す。
  await page.route('**/api/order-status/**', async (route: Route) => {
    if (used || route.request().method() !== 'GET' || !isPrivateRead(route.request().url())) { await route.fallback(); return; }
    used = true;
    arrived();
    await gate;
    await route.fallback();
  });
  return { held, release };
}

/** 画面へ戻った時の読み直しを起こす（FR-ORDER-004 と同じ起こし方）。 */
async function returnToPage(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

for (const viewport of orderStatusViewports) {
  // FREQ-513-AC-01
  test(`${viewport.width}px 下4桁を途中まで入れて画面へ戻っても、入れた数字と表示が残る`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    await withOrderStatusDb(async (db) => {
      const order = await createOrderStatusScenario(db, { kind: 'public' });
      const token = await prepareOrderStatusTestLink(db, order.orderId);
      await openOrderStatusPage(page, token);
      const input = page.getByLabel('ご注文の時の電話番号の下4桁', { exact: true });
      await expect(input).toBeVisible();
      const partial = order.lastFour!.slice(0, 2);
      await input.fill(partial);
      // 入れた欄の要素そのものを覚え、読み直しの後も同じ要素かを比べる
      await page.evaluate(() => { (window as unknown as { e2eLastFour?: Element | null }).e2eLastFour = document.querySelector('input[name="lastFour"]'); });
      const sameInput = () => page.evaluate(() => {
        const kept = (window as unknown as { e2eLastFour?: Element | null }).e2eLastFour;
        return Boolean(kept && kept.isConnected && kept === document.querySelector('input[name="lastFour"]'));
      });

      const first = await holdNextPrivateRead(page);
      const firstDone = page.waitForResponse((response) => isPrivateRead(response.url()));
      await returnToPage(page);
      await first.held;
      // 読み直しの答え待ちの間
      await expect(page.getByRole('heading', { name: 'ご注文の状況', exact: true })).toBeVisible();
      await expect(input).toHaveValue(partial);
      expect(await sameInput(), '答え待ちの間も同じ下4桁の欄が残る').toBe(true);
      await expectNoHorizontalOverflow(page);
      first.release();
      await firstDone;
      // 答えの後
      await expect(page.getByRole('button', { name: '確かめる', exact: true })).toBeEnabled();
      await expect(input).toHaveValue(partial);
      expect(await sameInput(), '答えの後も同じ下4桁の欄が残る').toBe(true);
      await expectNoHorizontalOverflow(page);

      // 確かめた後の個人情報も、読み直しの答え待ちの間に消えない
      await verifyOrderStatusInPage(page, order.lastFour!);
      const second = await holdNextPrivateRead(page);
      const secondDone = page.waitForResponse((response) => isPrivateRead(response.url()));
      await returnToPage(page);
      await second.held;
      await expect(page.getByRole('heading', { name: 'お届け先', exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      second.release();
      await secondDone;
      await expectOrderStatusPrivateVisible(page);
    });
  });
}
