import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-004 address form', () => {
  test('郵便番号補完を使って配送先住所を保存できる', async ({ page }) => {
    await mockOtpAuthentication(page);

    let savedPayload: Record<string, unknown> | null = null;

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            email: 'user@example.com',
            fullName: '',
            kanaName: '',
            phone: '',
            address: {
              postalCode: '',
              prefecture: '',
              city: '',
              address: '',
              building: '',
            },
          }),
        });
        return;
      }

      savedPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, ...savedPayload }),
      });
    });

    await page.route('**/api/orders', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });

    await page.route('**/api/checkout/postal-code?postalCode=1500001', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          address: {
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
          },
        }),
      });
    });

    await loginAndOpenAccount(page);

    await page.getByRole('button', { name: '配送情報' }).click();

    await page.getByLabel('郵便番号').fill('1500001');
    await expect(page.getByLabel('郵便番号')).toHaveValue('150-0001');
    await expect(page.getByLabel('都道府県')).toHaveValue('東京都');
    await expect(page.getByLabel('市区町村')).toHaveValue('渋谷区');
    await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');

    await page.getByLabel('建物名・部屋番号').fill('青山ハイツ 101');
    await page.getByRole('button', { name: '保存する' }).click();

    await expect.poll(() => savedPayload).not.toBeNull();
    await expect(savedPayload).toMatchObject({
      address: {
        postalCode: '1500001',
        prefecture: '東京都',
        city: '渋谷区',
        address: '神宮前1-2-3',
        building: '青山ハイツ 101',
      },
    });
  });
});