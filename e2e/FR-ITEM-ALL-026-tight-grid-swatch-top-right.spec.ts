import { expect, test } from '@playwright/test';
import { gotoItemList, itemCards } from './item-list-test-utils';

// FREQ-120: YOKE 参考。隣り合うカードの横余白を狭め、カラースウォッチを右上に配置する。

test.describe('FR-ITEM-ALL-026 グリッド間隔とカラースウォッチ右上配置', () => {
  test('FREQ-120-AC-01: ITEM グリッドの列間隔が 5px 以下', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoItemList(page);
    await expect(itemCards(page).first()).toBeVisible();

    const colGap = await itemCards(page)
      .first()
      .evaluate((card) => {
        const grid = card.closest('[data-testid="item-card-link"]')
          ?.parentElement as HTMLElement;
        return parseFloat(getComputedStyle(grid).columnGap);
      });
    expect(colGap).toBeLessThanOrEqual(5);
  });

  test('FREQ-120-AC-02/03: カラースウォッチが商品名の右・価格の上段（右上）に配置される', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoItemList(page);

    // カラースウォッチを持つ最初のカード
    const card = itemCards(page)
      .filter({ has: page.locator('[aria-label^="カラー"]') })
      .first();
    await expect(card).toBeVisible();

    const swatch = card.locator('[aria-label^="カラー"]');
    const name = card.locator('[data-testid="item-name"]');
    const price = card.locator('[data-testid="item-price"]');

    const [sb, nb, pb] = await Promise.all([
      swatch.boundingBox(),
      name.boundingBox(),
      price.boundingBox(),
    ]);
    expect(sb).not.toBeNull();
    expect(nb).not.toBeNull();
    expect(pb).not.toBeNull();

    // 右: スウォッチは商品名より右側
    expect(sb!.x).toBeGreaterThan(nb!.x);
    // 上: スウォッチ上端は価格の上端以下（＝商品名と同じ上段。価格より下ではない）
    expect(sb!.y).toBeLessThanOrEqual(pb!.y + 2);
  });

  test('FREQ-120-AC-04: 商品名の左とカラースウォッチの右に同量の余白がある', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoItemList(page);

    const card = itemCards(page)
      .filter({ has: page.locator('[aria-label^="カラー"]') })
      .first();
    await expect(card).toBeVisible();

    const { leftSpace, rightSpace } = await card.evaluate((el) => {
      const info = el.querySelector('[data-testid="item-info"]') as HTMLElement;
      const name = el.querySelector('[data-testid="item-name"]') as HTMLElement;
      const swatch = el.querySelector('[aria-label^="カラー"]') as HTMLElement;
      const ib = info.getBoundingClientRect();
      return {
        leftSpace: Math.round(name.getBoundingClientRect().left - ib.left),
        rightSpace: Math.round(ib.right - swatch.getBoundingClientRect().right),
      };
    });

    expect(leftSpace).toBeGreaterThan(0);
    // 左右の余白が同量（サブピクセル差を許容して1px以内）
    expect(Math.abs(leftSpace - rightSpace)).toBeLessThanOrEqual(1);
  });

  test('FREQ-120-AC-05: 商品名とカラースウォッチが同一行（縦中心が一致）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoItemList(page);

    const card = itemCards(page)
      .filter({ has: page.locator('[aria-label^="カラー"]') })
      .first();
    await expect(card).toBeVisible();

    const name = card.locator('[data-testid="item-name"]');
    const swatch = card.locator('[aria-label^="カラー"]');
    const [nb, sb] = await Promise.all([name.boundingBox(), swatch.boundingBox()]);
    expect(nb).not.toBeNull();
    expect(sb).not.toBeNull();

    const nameCenterY = nb!.y + nb!.height / 2;
    const swatchCenterY = sb!.y + sb!.height / 2;
    expect(Math.abs(nameCenterY - swatchCenterY)).toBeLessThanOrEqual(4);
  });
});
