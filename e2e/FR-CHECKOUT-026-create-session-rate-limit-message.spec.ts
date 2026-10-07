import { expect, test, type Page } from '@playwright/test';
import { stubCheckoutSessionApis } from './checkout-test-utils';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import { fillShippingForm, stubPostalCode } from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-026 決済開始 API の上限到達時の案内
 * 対応 FREQ: FREQ-362（AC-07）
 *
 * 決済開始 API は上限に達すると、時間をおいて再試行するよう案内する文を返す（本文の形は
 * tests/unit/api/checkout/create-session-route.test.ts で固定している）。画面はその文をそのまま出す。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

// src/app/api/checkout/create-session/route.ts が上限到達時に返す本文と同じ。
const RATE_LIMITED_BODY = {
  error: 'rate_limited',
  message:
    'アクセスが集中しているため、決済の準備を一時的に止めています。少し時間をおいてから、もう一度「確認へ進む」を押してください。',
  retryable: true,
};

/** 決済開始 API への要求を、入力が済むまで止めてから上限到達（429）で返す。 */
async function holdCreateSessionThenRateLimit(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/checkout/create-session', async (route) => {
    await released;
    await route.fulfill({
      status: 429,
      headers: { 'Retry-After': '10' },
      json: RATE_LIMITED_BODY,
    });
  });
  return release;
}

test.describe('FR-CHECKOUT-026 決済開始 API の上限到達時の案内', () => {
  for (const viewport of VIEWPORTS) {
    // FREQ-362-AC-07
    test(`${viewport.name}（${viewport.width}px）上限に達したら時間をおいて再試行するよう案内し、入力内容を残す`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await stubCheckoutSessionApis(page);
      await mockCartApis(page, [sampleCartItem()]);
      // stubCheckoutSessionApis の 503 より後に登録するので、こちらが優先される。
      const release = await holdCreateSessionThenRateLimit(page);

      await stubPostalCode(page);
      await page.goto('/checkout');

      const fullName = page.locator('input[name="fullName"]');
      const email = page.locator('input[name="email"]');
      await fillShippingForm(page, 'buyer@example.com');

      const rateLimited = page.waitForResponse(
        (response) =>
          response.url().includes('/api/checkout/create-session') && response.status() === 429,
      );
      await page.getByRole('button', { name: '確認へ進む' }).click();
      release();
      await rateLimited;

      await expect(page.getByText(/少し時間をおいてから、もう一度「確認へ進む」を押してください/)).toBeVisible();
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      await expect(fullName).toHaveValue('山田花子');
      await expect(email).toHaveValue('buyer@example.com');

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  }
});
