import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

test.describe('FR-CONTACT-011 注文番号入力と送信完了', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: 任意の注文番号フィールドが表示される`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/contact');

      await expect(page.getByLabel('ORDER NO. / 注文番号（任意）')).toBeVisible();
    });
  }

  test('送信成功でサンクスモーダルが表示される', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.route('**/api/contact', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto('/contact');

    await page.getByLabel('NAME / お名前 *').fill('山田 太郎');
    await page.getByLabel('EMAIL / メールアドレス *').fill('taro@example.com');

    await page.getByRole('button', { name: '選択してください' }).click();
    await page.getByText('ご注文について', { exact: true }).click();

    await page.getByLabel('SUBJECT / 件名 *').fill('配送について');
    await page.getByLabel('ORDER NO. / 注文番号（任意）').fill('ORD-ABCD1234');
    await page.getByLabel('MESSAGE / メッセージ *').fill('注文商品の到着予定を教えてください。');

    await page.getByRole('button', { name: 'SEND MESSAGE' }).click();

    await expect(page.getByRole('heading', { name: 'お問い合わせありがとうございます' })).toBeVisible();
  });
});
