import { expect, test } from '@playwright/test';
import { SEED_STOCKISTS, stockistCardByName } from './stockist-test-utils';

// 手元の見本の店は電話・営業時間・定休日が全部同じ値（supabase/seed.sql）。
const SEED_PHONE = '000-0000-0000';
const SEED_TIME = '11:00-18:00';
const SEED_HOLIDAY = 'Synthetic schedule';

test.describe('FR-STOCKIST-002 カード情報表示', () => {
  // 640px 以上で5つの情報が全部出る。幅は AC の決めた 768px と 1280px。
  for (const width of [768, 1280]) {
    test(`FR-STOCKIST-002-AC-01 ${width}px: 店舗名・住所・電話・営業時間・定休日を表示する`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/stockist');

      for (const shop of SEED_STOCKISTS) {
        const card = stockistCardByName(page, shop.name);
        await expect(card, shop.name).toHaveCount(1);
        await expect(card.getByRole('heading', { level: 3, name: shop.name, exact: true })).toBeVisible();
        await expect(card.getByRole('link', { name: shop.address, exact: true })).toBeVisible();
        await expect(card.getByRole('link', { name: SEED_PHONE, exact: true })).toBeVisible();
        await expect(card.getByText(SEED_TIME, { exact: true })).toBeVisible();
        await expect(card.getByText(SEED_HOLIDAY, { exact: true })).toBeVisible();
      }
    });
  }
});
