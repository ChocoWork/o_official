import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const requiredHeadings = [
  '5. 個人情報の取扱いの委託',
  '6. 個人情報の保有期間',
  '7. 個人情報の国外移転',
  '10. 保有個人データの開示・訂正・利用停止等の請求',
  '11. 本ポリシーの変更',
  '12. お問い合わせ窓口',
];

test.describe('FR-PRIVACY-003 追加した法的セクション', () => {
  for (const vp of viewports) {
    test(`${vp.name}: 委託・保有期間・国外移転・開示請求・変更・窓口を表示する`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/privacy');

      for (const name of requiredHeadings) {
        await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
      }

      await expect(page.getByText('privacy@lefildesheures.com')).toBeVisible();
    });
  }
});
