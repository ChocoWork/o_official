import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-006 extended profile fields', () => {
  test('フリガナと住所を含む完全な顧客情報を管理できる', async ({ page }) => {
    await mockOtpAuthentication(page);

    let savedProfilePayload: Record<string, unknown> | null = null;
    let savedAddressesPayload: Record<string, unknown> | null = null;

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

      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      savedProfilePayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, email: 'user@example.com', ...savedProfilePayload }),
      });
    });

    await page.route('**/api/profile/addresses', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ addresses: [{
            id: 'shipping-1',
            postalCode: '1500001',
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
            building: '青山ハイツ 101',
            isDefault: true,
          }] }),
        });
        return;
      }
      if (method !== 'PUT') {
        await route.fallback();
        return;
      }
      savedAddressesPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, ...savedAddressesPayload }),
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

    await page.getByRole('button', { name: '編集' }).click();
    await page.getByLabel('フリガナ').fill('サトウ ハナコ');
    await page.getByLabel('氏名').fill('佐藤 花子');
    await page.getByLabel('電話番号').fill('08033334444');
    await expect(page.getByLabel('電話番号')).toHaveValue('080-3333-4444');
    await page.getByRole('button', { name: '保存', exact: true }).click();

    await expect.poll(() => savedProfilePayload).not.toBeNull();
    expect(savedProfilePayload).toEqual({
      fullName: '佐藤 花子',
      kanaName: 'サトウ ハナコ',
      phone: '080-3333-4444',
    });
    await expect(page.getByRole('button', { name: '編集' })).toBeVisible();
    await expect(page.getByLabel('氏名')).toHaveValue('佐藤 花子');
    await expect(page.getByLabel('フリガナ')).toHaveValue('サトウ ハナコ');
    await expect(page.getByLabel('電話番号')).toHaveValue('080-3333-4444');

    await page.getByRole('tab', { name: '配送情報' }).click();
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await page.getByLabel('郵便番号').fill('1600022');
    await expect(page.getByLabel('郵便番号')).toHaveValue('160-0022');
    await expect(page.getByRole('combobox', { name: '都道府県' })).toContainText('東京都');
    await page.getByRole('combobox', { name: '都道府県' }).click();
    await page.getByRole('option', { name: '東京都', exact: true }).click();
    await page.getByLabel('市区町村').fill('新宿区');
    await expect(page.getByLabel('番地')).toHaveValue('新宿');
    await page.getByLabel('番地').fill('新宿3-4-5');
    await expect(page.getByLabel('番地')).toHaveValue('新宿3-4-5');
    await page.getByLabel('建物名・部屋番号').fill('新宿ビル 502');
    await page.getByRole('button', { name: '保存', exact: true }).click();

    await expect.poll(() => savedAddressesPayload).not.toBeNull();
    expect(savedAddressesPayload).toEqual({
      addresses: [{
        id: 'shipping-1',
        postalCode: '1600022',
        prefecture: '東京都',
        city: '新宿区',
        address: '新宿3-4-5',
        building: '新宿ビル 502',
        isDefault: true,
      }],
    });
    await expect(page.getByRole('status').filter({ hasText: '配送情報を保存しました' })).toBeVisible();
    await expect(page.getByText('〒160-0022', { exact: true })).toBeVisible();
    await expect(page.getByText('東京都新宿区新宿3-4-5新宿ビル 502', { exact: true })).toBeVisible();
  });
});
