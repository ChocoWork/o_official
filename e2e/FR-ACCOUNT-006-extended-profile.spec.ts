import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-006 extended profile fields', () => {
  test('フリガナと住所を含む完全な顧客情報を管理できる', async ({ page }) => {
    await mockOtpAuthentication(page);

    let savedPayload: Record<string, unknown> | null = null;

    await page.route('**/api/profile', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            email: 'user@example.com',
            fullName: '山田 花子',
            kanaName: 'ヤマダ ハナコ',
            phone: '090-1111-2222',
            address: {
              postalCode: '1500001',
              prefecture: '東京都',
              city: '渋谷区',
              address: '神宮前1-2-3',
              building: '青山ハイツ 101',
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

    await page.route('**/api/checkout/postal-code?postalCode=1600022', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          address: {
            prefecture: '東京都',
            city: '新宿区',
            address: '新宿',
          },
        }),
      });
    });

    await loginAndOpenAccount(page);

    await page.getByRole('button', { name: '変更する' }).click();
    await page.getByLabel('フリガナ').fill('サトウ ハナコ');
    await page.getByLabel('氏名').fill('佐藤 花子');
    await page.getByLabel('電話番号').fill('08033334444');
    await expect(page.getByLabel('電話番号')).toHaveValue('080-3333-4444');
    await page.getByRole('button', { name: '変更を保存' }).click();

    await page.getByRole('button', { name: '配送情報' }).click();
    await page.getByRole('button', { name: '変更する' }).click();
    await page.getByLabel('郵便番号').fill('1600022');
    await expect(page.getByLabel('郵便番号')).toHaveValue('160-0022');
    await page.getByLabel('都道府県').fill('東京都');
    await page.getByLabel('市区町村').fill('新宿区');
    await expect(page.getByLabel('番地')).toHaveValue('新宿');
    await page.getByLabel('番地').fill('新宿3-4-5');
    await expect(page.getByLabel('番地')).toHaveValue('新宿3-4-5');
    await page.getByLabel('建物名・部屋番号').fill('新宿ビル 502');
    await page.getByRole('button', { name: '変更を保存' }).click();

    await expect.poll(() => savedPayload).not.toBeNull();
    await expect(savedPayload).toMatchObject({
      fullName: '佐藤 花子',
      kanaName: 'サトウ ハナコ',
      phone: '080-3333-4444',
      address: {
        postalCode: '1600022',
        prefecture: '東京都',
        city: '新宿区',
        address: '新宿3-4-5',
        building: '新宿ビル 502',
      },
    });
  });
});