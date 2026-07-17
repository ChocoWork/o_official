import { expect, test, type Page } from '@playwright/test';

// FREQ-129: LOOK カード PC オーバーレイのテーマ名はセリフ体・大文字で表示し、
// 白文字の視認性のためオーバーレイ下部に黒グラデーション（下→上で透明）を敷く。

type OverlayStyle = {
  fontFamily: string;
  textTransform: string;
  backgroundImage: string;
};

async function readFirstOverlayStyle(
  page: Page,
  scopeSelector: string,
): Promise<OverlayStyle | null> {
  return page.locator(scopeSelector).evaluate((scope) => {
    const overlay = scope.querySelector<HTMLElement>('[data-testid="look-card-overlay"]');
    if (!overlay) return null;
    const theme = overlay.querySelector<HTMLElement>('h3');
    if (!theme) return null;

    const themeStyle = getComputedStyle(theme);
    return {
      fontFamily: themeStyle.fontFamily,
      textTransform: themeStyle.textTransform,
      backgroundImage: getComputedStyle(overlay).backgroundImage,
    };
  });
}

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

test.describe('FR-LOOK-ALL-016 オーバーレイのセリフ体・大文字・黒グラデーション', () => {
  for (const target of PAGES) {
    test(`desktop ${target.label} でセリフ体・大文字・グラデーションになる`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(target.path);
      await expect(page.locator(target.scope)).toBeVisible();

      const style = await readFirstOverlayStyle(page, target.scope);
      expect(style, `${target.label} にオーバーレイが見つかりませんでした`).not.toBeNull();

      // AC-01: セリフ体（Didot または Georgia を含む）
      expect(style!.fontFamily).toMatch(/Didot|Georgia/i);
      // AC-02: 大文字表示
      expect(style!.textTransform).toBe('uppercase');
      // AC-03: 下端が黒く上に向かって透明になる linear-gradient
      expect(style!.backgroundImage).toContain('linear-gradient');
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
