import { expect, test, type Page } from '@playwright/test';

// FREQ-130: LOOK カード PC オーバーレイの黒グラデーションは、イージングを近似した
// 多段ストップ（4つ以上）で上端が完全な透明（alpha 0）になり、影が滑らかに消える。

async function readOverlayGradient(
  page: Page,
  scopeSelector: string,
): Promise<string | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const overlay = scope.querySelector<HTMLElement>('[data-testid="look-card-overlay"]');
    return overlay ? getComputedStyle(overlay).backgroundImage : null;
  });
}

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-017 オーバーレイグラデーションの滑らかなフェード', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} で多段ストップかつ上端が完全透明になる`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const gradient = await readOverlayGradient(page, target.scope);
      expect(gradient, `${target.label} にオーバーレイが見つかりませんでした`).not.toBeNull();
      expect(gradient).toContain('linear-gradient');

      // AC-01: カラーストップが4つ以上（rgba(...) の出現数で判定）
      const stopCount = (gradient!.match(/rgba?\(/g) ?? []).length;
      expect(stopCount, `gradient="${gradient}"`).toBeGreaterThanOrEqual(4);

      // AC-02: 上端側の色が完全な透明（alpha 0）
      expect(gradient!).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)/);
    });
  }

  // mobile / tablet はオーバーレイ自体が非表示（FREQ-128 AC-03）
  for (const vp of [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ] as const) {
    test(`${vp.name} ではオーバーレイが表示されない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');
      await expect(page.locator('main')).toBeVisible();
      await expect(
        page.locator('[data-testid="look-card-overlay"]').first(),
      ).toBeHidden();
    });
  }
});
