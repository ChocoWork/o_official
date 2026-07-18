import { expect, test, type Page } from '@playwright/test';

// FREQ-142: mobile/tablet（lg: 1024px 未満）のみ、LOOK カード全体
// （画像+情報パネル）を 1px のグレー枠線（border-black/10）で囲む。
// 画像は枠線に密着（水平余白 0）し、情報パネルの文字にのみ枠線との
// 内側余白（モバイル 13px / タブレット 21px）を設ける。
// desktop（lg 以上）は枠線なしの従来表示を維持する。

const BORDER_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, panelPadding: 13 },
  { name: 'tablet', width: 768, height: 1024, panelPadding: 21 },
] as const;

const TARGETS = [
  { name: 'HOME LOOK セクション', path: '/', scope: '#look' },
  { name: '/look 一覧', path: '/look', scope: 'main' },
] as const;

async function gotoScope(page: Page, path: string, scope: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator(scope)).toBeVisible();
}

test.describe('FR-LOOK-ALL-029 LOOK カードのグレー枠線（lg 未満）', () => {
  for (const vp of BORDER_VIEWPORTS) {
    for (const target of TARGETS) {
      test(`${vp.name} ${target.name} カードに 1px のグレー枠線が表示される`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoScope(page, target.path, target.scope);

        const card = page
          .locator(`${target.scope} [data-testid="look-card"]`)
          .first();
        await expect(card).toBeVisible();

        // AC-01: 全辺 1px・グレー（black/10 = rgba(0,0,0,0.1)）
        const border = await card.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            top: style.borderTopWidth,
            right: style.borderRightWidth,
            bottom: style.borderBottomWidth,
            left: style.borderLeftWidth,
            color: style.borderTopColor,
          };
        });
        expect(border.top).toBe('1px');
        expect(border.right).toBe('1px');
        expect(border.bottom).toBe('1px');
        expect(border.left).toBe('1px');
        // black/10: Tailwind v4 は oklab 形式で解決される（= rgba(0,0,0,0.1)）
        expect(border.color).toMatch(
          /^(rgba\(0, 0, 0, 0\.1\)|oklab\(0 0 0 \/ 0\.1\))$/,
        );
      });

      test(`${vp.name} ${target.name} 画像は枠線に密着し情報パネルには内側余白がある`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoScope(page, target.path, target.scope);

        const card = page
          .locator(`${target.scope} [data-testid="look-card"]`)
          .first();
        const cardBox = await card.boundingBox();
        expect(cardBox).not.toBeNull();

        // AC-02: 画像コンテナの左右端が枠線の内側に密着（枠線 1px 分のみのずれ）
        const imageBox = await card
          .locator('.aspect-\\[2\\/3\\]')
          .first()
          .boundingBox();
        expect(imageBox).not.toBeNull();
        expect(Math.abs(imageBox!.x - cardBox!.x)).toBeLessThanOrEqual(2);
        expect(
          Math.abs(
            cardBox!.x + cardBox!.width - (imageBox!.x + imageBox!.width),
          ),
        ).toBeLessThanOrEqual(2);

        // AC-03: 情報パネル（キャプション）は枠線から水平に離れる
        // （padding-left: モバイル 13px / タブレット 21px + 枠線 1px）
        const captionBox = await card
          .locator('[data-testid="look-card-caption"]')
          .first()
          .boundingBox();
        expect(captionBox).not.toBeNull();
        const captionInset = captionBox!.x - cardBox!.x;
        expect(captionInset).toBeGreaterThanOrEqual(vp.panelPadding);
        expect(captionInset).toBeLessThanOrEqual(vp.panelPadding + 2);
      });
    }
  }

  // AC-04: desktop（lg 以上）はカード枠線なし
  for (const target of TARGETS) {
    test(`desktop ${target.name} ではカードに枠線が表示されない`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoScope(page, target.path, target.scope);

      const card = page
        .locator(`${target.scope} [data-testid="look-card"]`)
        .first();
      await expect(card).toBeVisible();
      await expect(card).toHaveCSS('border-top-width', '0px');
      await expect(card).toHaveCSS('border-bottom-width', '0px');
      await expect(card).toHaveCSS('border-left-width', '0px');
      await expect(card).toHaveCSS('border-right-width', '0px');
    });
  }
});
