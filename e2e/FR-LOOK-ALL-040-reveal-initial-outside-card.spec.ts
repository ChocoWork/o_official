import { expect, test, type Locator, type Page } from '@playwright/test';

// FREQ-339: リビール前（初期位置）の情報パネルはカードの外へ完全に退避していること。
// マスク側に padding があるとクリップ範囲（padding box）の内側で退避が止まり、
// 価格の右端などがカード内に覗いてしまうため、余白は動く側（.reveal-rise）に持たせる。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

type Rects = { cardLeft: number; riseRight: number; riseWidth: number };

async function rectsOf(card: Locator): Promise<Rects> {
  return card.evaluate((el) => {
    const rise = el.querySelector('.reveal-rise') as HTMLElement;
    const cardRect = el.getBoundingClientRect();
    const riseRect = rise.getBoundingClientRect();

    return {
      cardLeft: Number(cardRect.left.toFixed(2)),
      riseRight: Number(riseRect.right.toFixed(2)),
      riseWidth: Number(riseRect.width.toFixed(2)),
    };
  });
}

async function firstOffscreenCard(page: Page) {
  const cards = page.locator('[data-testid="look-card"]');
  const count = await cards.count();
  const height = page.viewportSize()?.height ?? 800;
  for (let i = 0; i < count; i += 1) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.y > height) return cards.nth(i);
  }
  return null;
}

test.describe('FR-LOOK-ALL-040 リビール前の文字はカード内に入らない', () => {
  for (const vp of VIEWPORTS) {
    test(`FREQ-339-AC-01: ${vp.name} 初期位置のパネルはカード左端より外にある`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(
        page.locator('[data-testid="look-card"]').first(),
      ).toBeVisible();

      const target = await firstOffscreenCard(page);
      test.skip(target === null, '画面外に出る LOOK カードがないため対象外');
      if (!target) return;

      const rects = await rectsOf(target);

      expect(rects.riseWidth, 'パネルの幅が取得できていない').toBeGreaterThan(0);
      expect(
        rects.riseRight,
        `パネルの右端(${rects.riseRight})がカード左端(${rects.cardLeft})の内側にある`,
      ).toBeLessThanOrEqual(rects.cardLeft);
    });

    test(`FREQ-339-AC-02: ${vp.name} リビール後のパネルはカード内の定位置に戻る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');

      const card = page.locator('[data-testid="look-card"]').first();
      await expect(card).toBeVisible();
      await page.waitForTimeout(2000);

      const rects = await rectsOf(card);

      expect(rects.riseRight).toBeGreaterThan(rects.cardLeft);
    });
  }
});
