import { expect, test, type Page } from '@playwright/test';

// FREQ-57 / FR-STOCKIST-010: STOCKIST 一覧の「地方→都道府県」ネストチェックボックスツリー。
// 地方（親）と都道府県（子）を同時に表示し、地方チェックで配下の都道府県を一括選択、
// 都道府県チェックで個別に絞り込む。シード店舗は 関東(東京: Aoyama 等)・
// 近畿(大阪/京都)・九州・沖縄(福岡)。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 800, drawer: false },
] as const;

// フィルター UI のスコープ（desktop=サイドバー / mobile・tablet=drawer）を返す。
async function openFilterScope(page: Page, useDrawer: boolean) {
  if (useDrawer) {
    await page.locator('[data-filter-button="floating"]').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }
  const sidebar = page.getByRole('complementary');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function checkArea(page: Page, useDrawer: boolean, label: string) {
  const scope = await openFilterScope(page, useDrawer);
  await scope.getByText(label, { exact: true }).click();
  // drawer は操作のたびに開閉するため、クリック後に閉じてグリッドを確認する。
  if (useDrawer) {
    await page.getByRole('dialog').getByLabel('Close filter drawer').click();
  }
}

// 折りたたまれた地方（親）を展開する。展開状態はコンポーネントに保持される。
async function expandRegion(page: Page, useDrawer: boolean, region: string) {
  const scope = await openFilterScope(page, useDrawer);
  await scope
    .getByRole('button', { name: new RegExp(`${region}の都道府県を展開`) })
    .click();
  if (useDrawer) {
    await page.getByRole('dialog').getByLabel('Close filter drawer').click();
  }
}

test.describe('FR-STOCKIST-010 地方→都道府県のネストフィルター', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: 地方（親）チェックで配下の都道府県の店舗のみ表示する`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/stockist');
      await page.waitForLoadState('networkidle');

      const cards = page.locator('article');
      const initialCount = await cards.count();
      expect(initialCount).toBeGreaterThan(1);
      await expect(page.locator('article', { hasText: 'Aoyama' })).toHaveCount(1);

      // 近畿（親）を選択 → 関東(青山)が消え、近畿(大阪・京都)が残る。
      await checkArea(page, vp.drawer, '近畿');
      await expect(page).toHaveURL(/pref=/);
      await expect(page.locator('article', { hasText: 'Aoyama' })).toHaveCount(0);
      await expect(page.locator('article', { hasText: '大阪' }).first()).toBeVisible();
      await expect(page.locator('article', { hasText: '京都' }).first()).toBeVisible();
      expect(await cards.count()).toBeLessThan(initialCount);
    });

    test(`${vp.name}: 都道府県（子）チェックで個別に絞り込める`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/stockist');
      await page.waitForLoadState('networkidle');

      // 近畿を展開してから大阪（子）のみを選択 → 大阪のみ残り、京都・関東は消える。
      await expandRegion(page, vp.drawer, '近畿');
      await checkArea(page, vp.drawer, '大阪');
      await expect(page).toHaveURL(/pref=/);
      await expect(page.locator('article', { hasText: '大阪' }).first()).toBeVisible();
      await expect(page.locator('article', { hasText: '京都' })).toHaveCount(0);
      await expect(page.locator('article', { hasText: 'Aoyama' })).toHaveCount(0);
    });

    test(`${vp.name}: 店舗が無い地方・都道府県は選択肢に表示しない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/stockist');
      await page.waitForLoadState('networkidle');

      const scope = await openFilterScope(page, vp.drawer);
      // 店舗のある地方は表示、無い地方（東北・四国 等）は非表示。
      await expect(scope.getByText('近畿', { exact: true })).toBeVisible();
      await expect(scope.getByText('東北', { exact: true })).toHaveCount(0);
      await expect(scope.getByText('四国', { exact: true })).toHaveCount(0);
    });
  }
});
