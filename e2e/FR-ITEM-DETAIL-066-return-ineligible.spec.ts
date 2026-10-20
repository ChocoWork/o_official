import { test, expect, viewports, noOverflow } from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ITEM-DETAIL-066 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('返品不可の一文を商品名・価格の塊の次に出し、印が無ければ出さない', async ({ page, rr }) => {
      // FREQ-482-AC-05
      for (const enabled of [true, false]) {
        await rr.setItem(1, enabled);
        const response = await page.request.get('/api/items/1');
        expect(response.status()).toBe(200);
        const body = await response.json() as { returnIneligible: boolean };
        expect(body.returnIneligible).toBe(enabled);
        await page.goto('/item/1');
        await expect(page.getByTestId('item-detail-identity')).toBeVisible();
        const note = page.getByTestId('item-return-ineligible-note');
        if (enabled) {
          await expect(note).toHaveText('この商品は、初期不良・誤送を除き、返品・交換をお受けしていません');
          expect(await page.getByTestId('item-detail-identity').evaluate((node) =>
            node.nextElementSibling?.getAttribute('data-testid') === 'item-return-ineligible-note')).toBe(true);
        } else {
          await expect(note).toHaveCount(0);
        }
        await noOverflow(page);
      }
    });
  });
}
