import { expect, test, type Page } from '@playwright/test';

// FREQ-138: mobile/tablet（lg: 1024px 未満）のみ、LOOK カードは画像の下に
// 「シーズンラベル（2026 AW）／セリフ体・大文字テーマ名／罫線／
// 関連アイテム名+右寄せ価格」の情報パネルを表示する。
// desktop（lg 以上）は従来どおり画像上オーバーレイ（FREQ-128〜136）を維持し、
// 画像下のキャプション・罫線・関連アイテムリストは表示しない。

const PANEL_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

const TARGETS = [
  { name: 'HOME LOOK セクション', path: '/', scope: '#look' },
  { name: '/look 一覧', path: '/look', scope: 'main' },
] as const;

async function gotoScope(page: Page, path: string, scope: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator(scope)).toBeVisible();
}

test.describe('FR-LOOK-ALL-025 LOOK カードの画像下情報パネル（lg 未満）', () => {
  for (const vp of PANEL_VIEWPORTS) {
    for (const target of TARGETS) {
      test(`${vp.name} ${target.name} シーズンラベルが「{年} {SS|AW}」形式で画像下に表示される`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoScope(page, target.path, target.scope);

        const caption = page
          .locator(`${target.scope} [data-testid="look-card-caption"]`)
          .first();
        // AC-01: 空白あり・COLLECTION なし
        await expect(caption).toBeVisible();
        const seasonText = (await caption.locator('p').first().textContent())?.trim() ?? '';
        expect(seasonText).toMatch(/^\d{4} (SS|AW)$/);
        expect(seasonText).not.toContain('COLLECTION');

        // AC-01: 画像の下（キャプション上端が画像下端以上）
        const imageBox = await page
          .locator(`${target.scope} a[href^="/look/"] img`)
          .first()
          .boundingBox();
        const captionBox = await caption.boundingBox();
        expect(imageBox).not.toBeNull();
        expect(captionBox).not.toBeNull();
        expect(captionBox!.y).toBeGreaterThanOrEqual(imageBox!.y + imageBox!.height - 1);
      });

      test(`${vp.name} ${target.name} テーマ名がセリフ体・大文字で表示される`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoScope(page, target.path, target.scope);

        const title = page
          .locator(`${target.scope} [data-testid="look-card-caption"] h3`)
          .first();
        await expect(title).toBeVisible();
        // AC-02: セリフ体（Didot/Georgia）+ uppercase
        const fontFamily = await title.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(fontFamily).toMatch(/Didot|Georgia/);
        await expect(title).toHaveCSS('text-transform', 'uppercase');
      });

      test(`${vp.name} ${target.name} テーマ名と関連アイテムの間に罫線が表示される`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoScope(page, target.path, target.scope);

        const dividers = page.locator(`${target.scope} [data-testid="look-card-divider"]`);
        const count = await dividers.count();
        test.skip(count === 0, '関連アイテムを持つ LOOK がないため対象外');

        // AC-03: 罫線がテーマ名より下・関連アイテムリストより上にある
        const card = page
          .locator(`${target.scope} [data-testid="look-card-divider"]`)
          .first()
          .locator('..');
        const titleBox = await card.locator('h3').first().boundingBox();
        const dividerBox = await dividers.first().boundingBox();
        const relatedBox = await card
          .locator('.look-related-items')
          .first()
          .boundingBox();
        expect(titleBox).not.toBeNull();
        expect(dividerBox).not.toBeNull();
        expect(relatedBox).not.toBeNull();
        expect(dividerBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1);
        expect(relatedBox!.y).toBeGreaterThanOrEqual(dividerBox!.y);
      });
    }
  }

  // AC-04: tablet では商品名と価格が同一行で、価格が行の右端に右寄せされる
  test('tablet /look 関連アイテムの価格が右寄せで表示される', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await gotoScope(page, '/look', 'main');

    const rows = page.locator('main a.look-related-item-text');
    const count = await rows.count();
    test.skip(count === 0, '関連アイテムを持つ LOOK がないため対象外');

    const row = rows.first();
    const rowBox = await row.boundingBox();
    const priceBox = await row.locator('span').nth(1).boundingBox();
    expect(rowBox).not.toBeNull();
    expect(priceBox).not.toBeNull();
    // 価格の右端が行コンテナの右端に一致（誤差 2px 以内）
    expect(
      Math.abs(rowBox!.x + rowBox!.width - (priceBox!.x + priceBox!.width)),
    ).toBeLessThanOrEqual(2);
  });

  // AC-05: desktop は従来どおりオーバーレイ表示で、画像下のパネルは表示されない
  test('desktop /look ではオーバーレイが表示され画像下パネルが表示されない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoScope(page, '/look', 'main');

    await expect(
      page.locator('main [data-testid="look-card-overlay"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('main [data-testid="look-card-caption"]').first(),
    ).toBeHidden();
    const divider = page.locator('main [data-testid="look-card-divider"]').first();
    if ((await divider.count()) > 0) {
      await expect(divider).toBeHidden();
    }
  });
});
