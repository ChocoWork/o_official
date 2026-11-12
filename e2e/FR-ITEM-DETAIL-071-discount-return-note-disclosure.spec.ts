/**
 * FR-ITEM-DETAIL-071 商品ページの割引の扱いの文を初めは折りたたむ。
 * 対応 FREQ: FREQ-642-AC-36。詳細設計: docs/04_DetailDesign/pages/05_item_detail.md
 * E2E の実行は調整役が本番ビルド・手元の DB で行う。
 */
import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const FULL_NOTE =
  '割引（2着目割引・セット割引・割引コードなど）が付いたご注文で一部の商品を返品され、割引の条件を満たさなくなる場合は、お手元に残る商品の割引後の価格を差し引いて返金いたします。以前のご注文の商品を返品され、その後のご注文の2着目割引の条件を満たさなくなる場合も、その分を差し引いて返金いたします。初期不良・誤送は、同じ商品の交換でお応えします（在庫が無い場合はお作りしてお送りします）。どうしてもお送りできない場合に限り返金し、その時はお手元に残る商品の価格は上がりません。返金額がマイナスになることはありません。';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe(`FR-ITEM-DETAIL-071 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-36: 初めは要約の1行だけが見え、開くと割引の扱いの全文が見える', async ({ page }) => {
      await page.goto('/item/1');
      const summaryLine = page.getByText('割引のあるご注文の返品・交換について', { exact: true });
      const openControl = page.getByText('詳しく', { exact: true });
      const note = page.getByTestId('item-discount-return-note');
      await expect(summaryLine).toBeVisible();
      await expect(openControl).toBeVisible();
      await expect(note).toBeHidden();

      const lineCount = await summaryLine.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
      expect(lineCount).toBe(1);

      if (viewport.name === 'mobile') {
        const heading = page.getByRole('heading', { name: 'YOU MAY ALSO LIKE', exact: true });
        await expect(heading).toBeVisible();
        const box = await heading.boundingBox();
        expect(box).not.toBeNull();
        expect(box?.y).toBeGreaterThanOrEqual(0);
        expect(box?.y).toBeLessThan(844);
      }

      await openControl.click();
      await expect(note).toBeVisible();
      await expect(note).toHaveText(FULL_NOTE);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(overflow).toBe(false);
    });
  });
}
