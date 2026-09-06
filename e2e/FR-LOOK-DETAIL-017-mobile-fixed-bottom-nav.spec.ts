import { expect, test } from '@playwright/test';
import { gotoFirstLookDetail } from './look-detail-test-utils';

// FREQ-343: モバイル（md 未満）では PREV LOOK / LOOK LIST / NEXT LOOK を
// UI の BottomNavigation として画面下に固定し、インラインの3カラムナビは出さない。
// md 以上は従来どおりインラインナビのみ。

const MOBILE = { width: 390, height: 844 } as const;
const WIDER_VIEWPORTS = [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const FIXED_NAV = '[data-testid="look-detail-fixed-nav"]';
const INLINE_NAV = '[data-testid="look-detail-bottom-nav"]';

test.describe('FR-LOOK-DETAIL-017 モバイル固定ボトムナビ', () => {
  test('mobile 固定ナビが画面下端に貼り付く', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await gotoFirstLookDetail(page);

    // AC-01: 固定ナビが可視で position:fixed、下端が viewport 下端に一致する
    const nav = page.locator(`${FIXED_NAV} [data-ui-bottom-nav]`);
    await expect(nav).toBeVisible();
    await expect(nav).toHaveAttribute('data-ui-bottom-nav-fixed', 'true');
    await expect(nav).toHaveCSS('position', 'fixed');

    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeCloseTo(MOBILE.height, 0);

    // ページ最下部までスクロールしても貼り付いたままであること
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolledBox = await nav.boundingBox();
    expect(scrolledBox!.y + scrolledBox!.height).toBeCloseTo(MOBILE.height, 0);
  });

  test('mobile 固定ナビに3項目が並び LOOK LIST が /look へのリンク', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await gotoFirstLookDetail(page);

    // AC-02: 3ラベルが表示され、LOOK LIST は /look へのリンク
    const nav = page.locator(FIXED_NAV);
    await expect(nav.getByText('PREV LOOK')).toBeVisible();
    await expect(nav.getByText('LOOK LIST')).toBeVisible();
    await expect(nav.getByText('NEXT LOOK')).toBeVisible();
    await expect(nav.getByRole('link', { name: 'LOOK LIST' })).toHaveAttribute(
      'href',
      '/look',
    );
  });

  test('mobile ではインラインナビを表示しない', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await gotoFirstLookDetail(page);

    // AC-03: モバイルはインラインナビを出さない（固定ナビに置き換わる）
    await expect(page.locator(INLINE_NAV)).toBeHidden();
  });

  test('mobile 固定ナビがフッターの著作権表示・法務リンクを覆わない', async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE);
    await gotoFirstLookDetail(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // AC-04: 最下部まで送っても、フッター末尾の法務リンクが固定ナビに隠れない
    const navBox = await page
      .locator(`${FIXED_NAV} [data-ui-bottom-nav]`)
      .boundingBox();
    for (const name of ['Privacy Policy', 'Terms of Service', 'Legal Notice']) {
      const link = page.getByRole('link', { name });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(navBox!.y);
    }
  });

  test('mobile 固定ナビのラベルが既定より 2 段階大きい', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await gotoFirstLookDetail(page);

    // AC-05: ラベルは BottomNavigation 既定（font/φ）ではなく --lk-size-7xs
    const expected = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.width = 'var(--lk-size-7xs)';
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    });

    const sizes = await page
      .locator(`${FIXED_NAV} .bottom-nav__label`)
      .evaluateAll((els) =>
        els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
      );
    expect(sizes).toHaveLength(3);
    for (const size of sizes) {
      expect(size).toBeCloseTo(expected, 1);
    }
  });

  for (const vp of WIDER_VIEWPORTS) {
    test(`${vp.name} ではインラインナビのみで固定ナビを表示しない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoFirstLookDetail(page);

      // AC-03: md 以上は従来どおりインラインナビだけ
      const inline = page.locator(INLINE_NAV);
      await inline.scrollIntoViewIfNeeded();
      await expect(inline).toBeVisible();
      await expect(page.locator(`${FIXED_NAV} [data-ui-bottom-nav]`)).toBeHidden();
    });
  }
});
