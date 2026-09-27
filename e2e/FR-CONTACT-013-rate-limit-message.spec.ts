import { expect, test, type Page } from '@playwright/test';

/**
 * FR-CONTACT-013 お問い合わせの送信上限の案内
 * 対応 FREQ: FREQ-361
 *
 * 上限の応答（429）の本文には依存しない。API の本文は英語の "Too many requests" で、
 * Vercel WAF など手前の層が返す 429 は JSON ですらない。どちらでも同じ案内を出す。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const RATE_LIMIT_MESSAGE = /しばらく時間をおいてから、あらためてお問い合わせください/;
const MESSAGE_BODY = '送信上限の案内を確認します。';

async function mockContactRateLimited(page: Page, body: string, contentType: string) {
  await page.route('**/api/contact', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 429,
      contentType,
      headers: { 'Retry-After': '3600' },
      body,
    });
  });
}

function contactForm(page: Page) {
  return page.locator('form:has(textarea[name="message"])');
}

async function fillAndSubmitContactForm(page: Page) {
  const form = contactForm(page);
  await form.locator('input[name="name"]').fill('テスト太郎');
  await form.locator('input[name="email"]').fill('tester@example.com');
  await form.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole('option', { name: 'その他' }).click();
  await form.locator('input[name="subject"]').fill('送信上限テスト');
  await form.locator('textarea[name="message"]').fill(MESSAGE_BODY);
  await form.getByRole('button', { name: 'SEND MESSAGE' }).click();
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-CONTACT-013 送信上限の案内 (${viewport.name} ${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-361-AC-01
    test('上限（429）に達したら、しばらく時間をおいてから問い合わせるよう案内し、入力内容を残す', async ({ page }) => {
      await mockContactRateLimited(page, JSON.stringify({ error: 'Too many requests' }), 'application/json');
      await page.goto('/contact');
      await fillAndSubmitContactForm(page);

      await expect(page.getByRole('alert').filter({ hasText: RATE_LIMIT_MESSAGE })).toBeVisible();
      await expect(page.getByText('Too many requests')).toHaveCount(0);

      const form = contactForm(page);
      await expect(form.locator('input[name="email"]')).toHaveValue('tester@example.com');
      await expect(form.locator('textarea[name="message"]')).toHaveValue(MESSAGE_BODY);
    });

    // FREQ-361-AC-02
    test('手前の層が JSON 以外の 429 を返しても、同じ案内を出す', async ({ page }) => {
      await mockContactRateLimited(page, '<html><body>Too Many Requests</body></html>', 'text/html');
      await page.goto('/contact');
      await fillAndSubmitContactForm(page);

      await expect(page.getByRole('alert').filter({ hasText: RATE_LIMIT_MESSAGE })).toBeVisible();
    });

    // FREQ-361-AC-03
    test('案内を表示しても横スクロールが発生しない', async ({ page }) => {
      await mockContactRateLimited(page, JSON.stringify({ error: 'Too many requests' }), 'application/json');
      await page.goto('/contact');
      await fillAndSubmitContactForm(page);
      await expect(page.getByRole('alert').filter({ hasText: RATE_LIMIT_MESSAGE })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
