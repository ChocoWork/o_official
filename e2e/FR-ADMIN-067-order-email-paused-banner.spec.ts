/**
 * FR-ADMIN-067 注文のメールを止めている時、ORDER タブに原因と再開の案内を出す
 * 対応 FREQ: FREQ-435（送信の一時停止、グループ D 全体のレビュー I-1）
 *
 * 店への知らせも止まる設定の問題を、毎日見る管理画面で分かるようにする。
 * FR-ADMIN-065 と同じ窓口の差し替えで3つの画面幅を確かめ、帯の写しを test-results/group-d/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import type { OrderAttention } from '@/lib/orders/order-payment-types';
import { mockAdminBackgroundApis } from './admin-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const TITLE = 'お客様への注文のメールの送信を止めています';
const REASON = '送信元のドメインの設定';

async function mockAdminApis(page: Page, state: { paused: boolean }): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'admin@example.com', role: 'admin', mfaVerified: true } }),
    }));
  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) }));
  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    }));
  await page.route('**/api/admin/order-attention', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {
        exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 },
        emailSending: { paused: state.paused, reasonLabel: state.paused ? REASON : null },
      } satisfies OrderAttention & { emailSending: { paused: boolean; reasonLabel: string | null } } }),
    }));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-067 order email paused banner (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('送信を止めている時は ORDER に帯と原因の名前が見える', async ({ page }) => {
      const state = { paused: true };
      await mockAdminApis(page, state);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ORDER' }).click();

      const banner = page.getByRole('alert').filter({ hasText: TITLE });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(`原因: ${REASON}。`);
      await expect(banner).toContainText('原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。');
      await expect(banner).toContainText('手順は「注文のメールの手順書」の「送信の一時停止」にあります。');
      await page.screenshot({ path: `test-results/group-d/order-email-paused-banner-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('送信を止めていない応答を読み直すと、ORDER の帯は無い', async ({ page }) => {
      const state = { paused: true };
      await mockAdminApis(page, state);
      await page.goto('/admin');
      await page.getByRole('button', { name: 'ORDER' }).click();
      await expect(page.getByRole('alert').filter({ hasText: TITLE })).toBeVisible();

      // 表示済みの帯が消えるのを待つので、応答が描画される前の「まだ無い」を成功にしない。
      state.paused = false;
      await page.getByRole('button', { name: 'KPI', exact: true }).click();
      await page.getByRole('button', { name: 'ORDER' }).click();
      await expect(page.getByRole('alert').filter({ hasText: TITLE })).toHaveCount(0);
    });
  });
}
