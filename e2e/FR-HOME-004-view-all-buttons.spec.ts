import { test, expect } from '@playwright/test';

// FREQ-126〜128: VIEW ALL 導線は各区画のカードの下（区画の末尾）に置く共通のボタン。
// FREQ-147〜149: 表示/非表示は「公開総数 > 帯域別表示数」で切り替わる（FR-HOME-013・021 で検証）。
// ここでは、seed の公開数（ITEM 7・LOOK 7・NEWS 8）が表示数（6）より多いので VIEW ALL が見える前提で、
// 区画の末尾にあること、押すと各一覧が開くことを確かめる。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const SECTIONS = [
  { id: 'items', label: 'ITEM', card: '[data-testid="item-card-link"]:visible', href: '/item', path: /\/item\/?$/ },
  { id: 'look', label: 'LOOK', card: '[data-testid="look-card"]:visible', href: '/look', path: /\/look\/?$/ },
  { id: 'news', label: 'NEWS', card: 'article:visible', href: '/news', path: /\/news\/?$/ },
] as const;

test.describe('FR-HOME-004 home CTA buttons', () => {
  for (const vp of VIEWPORTS) {
    for (const section of SECTIONS) {
      test(`FR-HOME-004-AC-01 ${vp.name}(${vp.width}px) ${section.label} の区画の末尾の VIEW ALL を押すと ${section.href} が開く`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto('/');

        const scope = page.locator(`#${section.id}`);
        const viewAll = scope.locator('[data-testid="home-section-view-all"]');
        await expect(viewAll).toBeVisible();
        await expect(viewAll).toHaveAttribute('href', section.href);

        // 区画の末尾: ボタンの上端が、区画の最後のカードの下端より下にある
        const cards = scope.locator(section.card);
        await expect(cards.first()).toBeVisible();
        const lastCardBox = await cards.last().boundingBox();
        const buttonBox = await viewAll.boundingBox();
        expect(lastCardBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        if (!lastCardBox || !buttonBox) return;
        expect(buttonBox.y).toBeGreaterThanOrEqual(lastCardBox.y + lastCardBox.height - 1);

        await viewAll.click();
        await expect(page).toHaveURL(section.path);
      });
    }
  }
});
