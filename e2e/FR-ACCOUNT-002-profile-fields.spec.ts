import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-002 profile fields', () => {
  test('メールアドレスを読み取り専用で表示し、氏名と電話番号を編集保存できる', async ({ page }) => {
    await mockOtpAuthentication(page);

    let postPayload: Record<string, unknown> | null = null;

    await page.route('**/api/profile', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
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

      if (method === 'POST') {
        postPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, ...postPayload }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.route('**/api/orders', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
    });

    await loginAndOpenAccount(page);

    await expect(page.getByText('メールアドレス')).toBeVisible();
    await expect(page.getByText('user@example.com')).toBeVisible();
    await expect(page.getByText('山田 花子')).toBeVisible();
    await expect(page.getByText('090-1111-2222')).toBeVisible();

    await page.getByRole('button', { name: '変更する' }).click();
    await page.getByLabel('氏名').fill('佐藤 花子');
    await page.getByLabel('電話番号').fill('08033334444');
    await expect(page.getByLabel('電話番号')).toHaveValue('080-3333-4444');
    await page.getByRole('button', { name: '変更を保存' }).click();

    await expect.poll(() => postPayload).not.toBeNull();
    await expect(postPayload).toMatchObject({
      fullName: '佐藤 花子',
      phone: '080-3333-4444',
    });
  });
});