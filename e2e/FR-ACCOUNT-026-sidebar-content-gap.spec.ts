import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// FREQ-95: サイドバー↔本文の列間隔を黄金比で1段階（×√φ）広げる。
// デスクトップ幅で .account-layout の column-gap が基準 --gap-layout より広いことを検証する。

const SQRT_PHI = 1.272019649514069;

test.describe('FR-ACCOUNT-026 sidebar/content gap', () => {
  test('デスクトップでサイドバーと本文の間隔が1段階（×√φ）広い', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockOtpAuthentication(page);

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'demo@gmail.com',
          fullName: 'test',
          kanaName: 'test',
          phone: '080-2222-5555',
          address: { postalCode: '', prefecture: '', city: '', address: '', building: '' },
        }),
      });
    });
    await page.route('**/api/orders', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });

    await loginAndOpenAccount(page, 'demo@gmail.com');

    const layout = page.locator('.account-layout');
    await expect(layout).toBeVisible();

    // 実際の column-gap と、基準トークン --gap-layout（×√φ 前の値）を取得
    const { columnGap, baseGap } = await layout.evaluate((el) => {
      const style = getComputedStyle(el);
      const base = style.getPropertyValue('--gap-layout').trim();
      const probe = document.createElement('div');
      probe.style.width = base;
      probe.style.position = 'absolute';
      el.appendChild(probe);
      const baseGapPx = parseFloat(getComputedStyle(probe).width);
      probe.remove();
      return { columnGap: parseFloat(style.columnGap), baseGap: baseGapPx };
    });

    // 列間隔は基準 --gap-layout の約 √φ 倍（1段階広い）
    expect(columnGap).toBeGreaterThan(baseGap);
    expect(columnGap / baseGap).toBeCloseTo(SQRT_PHI, 1);
  });
});
