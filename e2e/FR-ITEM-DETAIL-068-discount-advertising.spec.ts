import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ITEM-DETAIL-068 (${viewport.width}px)`, () => {
    test('FREQ-550-AC-03: 自動の広告ONだけ１行を出しguestに会員用案内を出さない', async ({ page, browser }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('advertising', async (s) => {
        const item = await s.item(20_000);
        const input = discountInput({ method: 'automatic', code: null, advertisingText: '２着目からお得になります' });
        const id = await s.createDiscount(input);
        await installDiscountDbBridge(page, s, 'guest');
        await page.goto(`/item/${item.itemId}`);
        const advertisement = page.getByTestId('item-discount-advertisement');
        await expect(advertisement).toHaveCount(0);
        await s.update(id, { advertise: true });
        await page.reload();
        await expect(advertisement).toHaveCount(1);
        await expect(advertisement).toHaveText(input.advertisingText!);
        await expect(page.locator('del, s')).toHaveCount(0);
        await expect(page.locator('#main-content')).toContainText('¥20,000');
        await expect(page.locator('#main-content')).not.toContainText('¥18,000');
        await s.stop(id);
        const a = await s.createDiscount(discountInput({ method: 'automatic', code: null, kind: 'repeat', targetMode: 'include', itemIds: [item.itemId],
          repeatPrevious: true, advertise: true, advertisingText: '前回も買った会員への案内' }));
        const context = await browser.newContext({ baseURL: 'http://localhost:3000', viewport });
        try {
          const member = await context.newPage();
          await installDiscountDbBridge(member, s, 'member');
          await member.goto(`/item/${item.itemId}`);
          await expect(member.getByTestId('item-discount-advertisement')).toHaveText('前回も買った会員への案内');
          for (const both of [false, true]) {
            await s.update(a, { repeatInOrder: both });
            const guestReply = await s.api('guest', `/api/discounts/advertisements?itemId=${item.itemId}`);
            expect(guestReply.body).toEqual({ rows: [] });
            expect(guestReply.cacheControl).toContain('no-store');
            await page.reload(); await expect(advertisement).toHaveCount(0);
            await member.reload(); await expect(member.getByTestId('item-discount-advertisement')).toHaveText('前回も買った会員への案内');
          }
          await s.update(a, { endsAt: '2026-01-02T00:00:00Z' });
          await member.reload(); await expect(member.getByTestId('item-discount-advertisement')).toHaveCount(0);
          await expectNoHorizontalOverflow(member);
        } finally { await context.close(); }
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
