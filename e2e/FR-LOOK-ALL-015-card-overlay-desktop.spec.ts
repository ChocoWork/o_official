import { expect, test, type Page } from '@playwright/test';

// FREQ-128: PC（lg: 1024px 以上）では LOOK カードのシーズンラベルとテーマ名を
// 画像下部に白文字で重ねて表示し、画像下の従来キャプションは非表示にする。
// モバイル・タブレットでは従来どおり画像下にキャプションを表示する。

type OverlayLayout = {
  color: string;
  overlayTop: number;
  imageTop: number;
  imageBottom: number;
};

async function readFirstOverlayLayout(
  page: Page,
  scopeSelector: string,
): Promise<OverlayLayout | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const overlay = scope.querySelector<HTMLElement>('[data-testid="look-card-overlay"]');
    if (!overlay) return null;
    const imageContainer = overlay.parentElement;
    if (!imageContainer) return null;

    // コンテナはグラデーションのフェード距離（上余白）を含むため、
    // 位置の検証はテキスト（シーズンラベル p）の矩形で行う。
    const seasonLabel = overlay.querySelector<HTMLElement>('p');
    if (!seasonLabel) return null;
    const textRect = seasonLabel.getBoundingClientRect();
    const imageRect = imageContainer.getBoundingClientRect();
    const theme = overlay.querySelector<HTMLElement>('h3');

    return {
      color: theme ? getComputedStyle(theme).color : '',
      overlayTop: Number(textRect.top.toFixed(2)),
      imageTop: Number(imageRect.top.toFixed(2)),
      imageBottom: Number(imageRect.bottom.toFixed(2)),
    };
  });
}

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-015 PC でのカード画像下部オーバーレイ', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} で画像下部に白文字オーバーレイを表示する`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const scope = page.locator(target.scope);

      // AC-01: オーバーレイが表示され、テキストが白（rgb(255, 255, 255)）
      const overlay = scope.locator('[data-testid="look-card-overlay"]').first();
      await expect(overlay).toBeVisible();

      const layout = await readFirstOverlayLayout(page, target.scope);
      expect(layout).not.toBeNull();
      expect(layout!.color).toBe('rgb(255, 255, 255)');

      // AC-04: オーバーレイは画像の下半分（画像下部）に位置する
      const imageMiddle = (layout!.imageTop + layout!.imageBottom) / 2;
      expect(layout!.overlayTop).toBeGreaterThan(imageMiddle);
      expect(layout!.overlayTop).toBeGreaterThanOrEqual(layout!.imageTop);

      // AC-02: 画像下の従来キャプションは非表示
      await expect(
        scope.locator('[data-testid="look-card-caption"]').first(),
      ).toBeHidden();
    });
  }

  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    for (const target of PAGES) {
      test(`${vp.name} ${target.label} ではオーバーレイ非表示・キャプション表示`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(target.path);
        await expect(page.locator(target.scope)).toBeVisible();

        const scope = page.locator(target.scope);

        // AC-03: オーバーレイは表示されず、画像下のキャプションが表示される
        await expect(
          scope.locator('[data-testid="look-card-overlay"]').first(),
        ).toBeHidden();

        const caption = scope.locator('[data-testid="look-card-caption"]').first();
        await caption.scrollIntoViewIfNeeded();
        await expect(caption).toBeVisible();
      });
    }
  }
});
