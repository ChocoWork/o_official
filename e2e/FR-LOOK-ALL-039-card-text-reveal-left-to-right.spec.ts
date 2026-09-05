import { expect, test, type Locator, type Page } from '@playwright/test';

// FREQ-338: LOOK カードの文字リビールを、画像（左→右に現れるカバー）と
// 同じ向きに揃える。文字はマスクの左外から滑り込む（.reveal-rise-x）。
// ITEM カードは従来どおり下から迫り上がる（.reveal-rise のまま）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** リビールのアニメーション（カバー 0.5s+0.5s / 文字 1.0s+0.5s）が終わるまでの猶予 */
const REVEAL_SETTLE_MS = 2000;

type Translate = { x: number; y: number };

/** computed transform（matrix(a, b, c, d, tx, ty)）から移動量だけを取り出す */
async function translateOf(rise: Locator): Promise<Translate> {
  return rise.evaluate((el) => {
    const transform = getComputedStyle(el).transform;
    const values = transform
      .replace(/^matrix\(|\)$/g, '')
      .split(',')
      .map((value) => Number.parseFloat(value));

    if (transform === 'none' || values.length !== 6) {
      return { x: 0, y: 0 };
    }

    return { x: values[4], y: values[5] };
  });
}

async function animationNameOf(rise: Locator): Promise<string> {
  return rise.evaluate((el) => getComputedStyle(el).animationName);
}

async function firstOffscreenCard(page: Page, testId: string) {
  const cards = page.locator(`[data-testid="${testId}"]`);
  const count = await cards.count();
  const height = page.viewportSize()?.height ?? 800;
  for (let i = 0; i < count; i += 1) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.y > height) return cards.nth(i);
  }
  return null;
}

test.describe('FR-LOOK-ALL-039 LOOK カードの文字リビールを左→右にする', () => {
  for (const vp of VIEWPORTS) {
    test(`FREQ-338-AC-01: ${vp.name} リビール前の文字は左外へ退避している`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(
        page.locator('[data-testid="look-card"]').first(),
      ).toBeVisible();

      const target = await firstOffscreenCard(page, 'look-card');
      test.skip(target === null, '画面外に出る LOOK カードがないため対象外');
      if (!target) return;

      const rise = target.locator('.reveal-rise').first();
      const translate = await translateOf(rise);

      expect(translate.x, '文字がマスクの左外に退避していない').toBeLessThan(0);
      expect(translate.y, '文字が縦方向に退避している（下→上のまま）').toBe(0);
    });

    test(`FREQ-338-AC-02: ${vp.name} リビールで左→右に滑り込み定位置に戻る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');

      const card = page.locator('[data-testid="look-card"]').first();
      await expect(card).toBeVisible();
      await page.waitForTimeout(REVEAL_SETTLE_MS);

      const rise = card.locator('.reveal-rise').first();

      expect(await animationNameOf(rise)).toBe('reveal-rise-x-act');
      expect(await translateOf(rise)).toEqual({ x: 0, y: 0 });
    });

    test(`FREQ-338-AC-03: ${vp.name} ITEM カードの文字は下→上のまま`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item');

      const card = page.locator('[data-testid="item-card-link"]').first();
      await expect(card).toBeVisible();
      await page.waitForTimeout(REVEAL_SETTLE_MS);

      const rise = page.locator('[data-testid="item-info"] .reveal-rise').first();

      expect(await animationNameOf(rise)).toBe('reveal-rise-act');
    });
  }
});
