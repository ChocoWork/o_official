import { expect, test } from '@playwright/test';
import {
  checkArea,
  expandRegion,
  KINKI_PREFECTURES,
  openFilterScope,
  STOCKIST_VIEWPORTS as VIEWPORTS,
} from './stockist-test-utils';

// FREQ-57 / FR-STOCKIST-010: STOCKIST 一覧の「地方→都道府県」ネストチェックボックスツリー。
// 地方（親）と都道府県（子）を同時に表示し、地方チェックで配下の都道府県を一括選択、
// 都道府県チェックで個別に絞り込む。シード店舗は 関東(東京: Aoyama 等)・
// 近畿(大阪/京都)・九州・沖縄(福岡)。

test.describe('FR-STOCKIST-010 地方→都道府県のネストフィルター', () => {
  for (const vp of VIEWPORTS) {
    test(`FREQ-57-AC-01 ${vp.name}: 地方（親）チェックで配下の都道府県の店舗のみ表示する`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/stockist');
      await page.waitForLoadState('networkidle');

      const cards = page.locator('article');
      const initialCount = await cards.count();
      expect(initialCount).toBeGreaterThan(1);
      await expect(page.locator('article', { hasText: 'Aoyama' })).toHaveCount(1);

      // 近畿（親）を選択 → 関東(青山・銀座・渋谷)が消え、近畿(大阪・京都・兵庫)だけが残る。
      await checkArea(page, vp.drawer, '近畿');
      await expect(page).toHaveURL(/pref=/);
      for (const kanto of ['Aoyama Sample Select', 'Ginza Sample Store', 'Tokyo Synthetic Flagship']) {
        await expect(page.locator('article', { hasText: kanto }), kanto).toHaveCount(0);
      }
      for (const kinki of ['Osaka Sample Select', 'Kyoto Sample Select', 'Kobe Sample Store']) {
        await expect(page.locator('article', { hasText: kinki }), kinki).toHaveCount(1);
      }
      // 残ったカードは全部、近畿の府県の店（「のみ」）
      const addresses = await page.locator('article a[href^="https://www.google.com/maps"]').allInnerTexts();
      expect(addresses.length).toBeGreaterThanOrEqual(3);
      for (const address of addresses) {
        expect(KINKI_PREFECTURES.some((prefecture) => address.startsWith(prefecture)), address).toBe(true);
      }
    });

    test(`FREQ-57-AC-02 ${vp.name}: 都道府県（子）チェックで個別に絞り込める`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/stockist');
      await page.waitForLoadState('networkidle');

      // 近畿を展開してから大阪（子）のみを選択 → 大阪のみ残り、京都・関東は消える。
      await expandRegion(page, vp.drawer, '近畿');
      await checkArea(page, vp.drawer, '大阪');
      await expect(page).toHaveURL(/pref=/);
      await expect(page.locator('article', { hasText: 'Osaka Sample Select' })).toHaveCount(1);
      await expect(page.locator('article', { hasText: '京都府' })).toHaveCount(0);
      await expect(page.locator('article', { hasText: 'Aoyama' })).toHaveCount(0);
      // 残ったカードは全部、大阪府の店
      const addresses = await page.locator('article a[href^="https://www.google.com/maps"]').allInnerTexts();
      expect(addresses.length).toBeGreaterThanOrEqual(1);
      for (const address of addresses) {
        expect(address).toMatch(/^大阪府/);
      }
    });

    test(`FR-STOCKIST-010-AC-01 ${vp.name}: 店舗が無い地方・都道府県は選択肢に表示しない`, async ({ page }) => {
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
