import { expect, test, type Page } from '@playwright/test';
import { CART_API_URL, sampleCartItem, toCartJson } from './shop-test-utils';

/**
 * FREQ-309 ヘッダーのカート点数バッジ（AC-02〜05。AC-01 は FR-HEADER-008）。
 * FREQ-194 ヘッダーナビの下線を文字幅に揃える（AC-01・02）。
 */
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const badgeOf = (page: Page) =>
  page.locator('header [data-ui-badge-variant="count"]');
const cartIconOf = (page: Page) =>
  page.locator('header .ri-shopping-bag-line');

/** /api/cart を quantity 点の明細1行（0 なら空のカート）で返し、トップを開く */
async function openHomeWithCart(
  page: Page,
  viewport: { width: number; height: number },
  quantity: number,
) {
  await page.route(CART_API_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        toCartJson(quantity > 0 ? [sampleCartItem({ quantity })] : []),
      ),
    }),
  );
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

test.describe('FR-HEADER-009 header cart badge geometry and nav underline', () => {
  for (const viewport of VIEWPORTS) {
    test(`FREQ-309-AC-02 ${viewport.name}（${viewport.width}px）点数が1桁でも2桁でもバッジの幅と高さが等しい（±1px）`, async ({
      page,
    }) => {
      await openHomeWithCart(page, viewport, 3);
      const badge = badgeOf(page);
      await expect(badge).toHaveText('3');
      const single = await badge.boundingBox();
      expect(single).not.toBeNull();
      expect(Math.abs(single!.width - single!.height)).toBeLessThanOrEqual(1);

      await page.unroute(CART_API_URL);
      await openHomeWithCart(page, viewport, 12);
      await expect(badge).toHaveText('12');
      const double = await badge.boundingBox();
      expect(double).not.toBeNull();
      expect(Math.abs(double!.width - double!.height)).toBeLessThanOrEqual(1);
    });

    test(`FREQ-309-AC-03 ${viewport.name}（${viewport.width}px）点数が 128 のときバッジに 99+ と表示される`, async ({
      page,
    }) => {
      await openHomeWithCart(page, viewport, 128);
      await expect(badgeOf(page)).toHaveCount(1);
      await expect(badgeOf(page)).toHaveText('99+');
    });

    test(`FREQ-309-AC-04 ${viewport.name}（${viewport.width}px）バッジの中心がカートアイコンの右上の角にあり、box-shadow に白のリングが指定される`, async ({
      page,
    }) => {
      await openHomeWithCart(page, viewport, 3);
      const badge = badgeOf(page);
      await expect(badge).toHaveCount(1);
      const rect = await badge.boundingBox();
      const icon = await cartIconOf(page).boundingBox();
      expect(rect).not.toBeNull();
      expect(icon).not.toBeNull();
      // バッジの中心 = アイコンの右上の角（±2px）
      expect(
        Math.abs(rect!.x + rect!.width / 2 - (icon!.x + icon!.width)),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(rect!.y + rect!.height / 2 - icon!.y),
      ).toBeLessThanOrEqual(2);
      const shadow = await badge.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(shadow).toContain('rgb(255, 255, 255)');
    });

    test(`FREQ-309-AC-05 ${viewport.name}（${viewport.width}px）カートが空のときヘッダーに count バッジが存在しない`, async ({
      page,
    }) => {
      await openHomeWithCart(page, viewport, 0);
      // 空でも「バッジが無い」ことが描画前の偶然でないよう、カートアイコンの表示を待つ
      await expect(cartIconOf(page)).toBeVisible();
      await expect(badgeOf(page)).toHaveCount(0);
    });
  }

  /** ヘッダーナビの各リンクの下線とグリフの端の差を測る（desktop 1280px） */
  async function measureNavUnderline(page: Page) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('nav.header-nav-position a').first()).toBeVisible();

    return page.evaluate(() =>
      [...document.querySelectorAll('nav.header-nav-position a')].map((link) => {
        const underline = link.querySelector('.underline-animation-left2right')!;
        const textNode = [...link.childNodes].find(
          (node) => node.nodeType === 3 && node.textContent!.trim().length > 0,
        )!;
        const text = textNode.textContent!;
        const letterSpacing = parseFloat(getComputedStyle(link).letterSpacing);

        // 最後の文字の矩形には末尾の字間が含まれるので差し引く
        const lastChar = document.createRange();
        lastChar.setStart(textNode, text.length - 1);
        lastChar.setEnd(textNode, text.length);
        const glyphRight = lastChar.getBoundingClientRect().right - letterSpacing;

        const firstChar = document.createRange();
        firstChar.setStart(textNode, 0);
        firstChar.setEnd(textNode, 1);
        const glyphLeft = firstChar.getBoundingClientRect().left;

        const underlineLeft = underline.getBoundingClientRect().left;
        const underlineWidth = (underline as HTMLElement).offsetWidth;

        return {
          label: text.trim(),
          rightGap: underlineLeft + underlineWidth - glyphRight,
          leftGap: glyphLeft - underlineLeft,
        };
      }),
    );
  }

  test('FREQ-194-AC-01 desktop（1280px）ヘッダーナビの各リンクで下線の右端と最後の文字のグリフ右端の差が 1px 以内', async ({
    page,
  }) => {
    const links = await measureNavUnderline(page);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(Math.abs(link.rightGap), link.label).toBeLessThanOrEqual(1);
    }
  });

  test('FREQ-194-AC-02 desktop（1280px）ヘッダーナビの各リンクで下線の左端と最初の文字の左端の差が 1px 以内', async ({
    page,
  }) => {
    const links = await measureNavUnderline(page);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(Math.abs(link.leftGap), link.label).toBeLessThanOrEqual(1);
    }
  });
});
