import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-011 お問い合わせスレッド', () => {
  test('お問い合わせタブでスレッドをチャット表示できる', async ({ page }) => {
    await mockOtpAuthentication(page);

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: 'user@example.com',
          fullName: '山田 花子',
          kanaName: 'ヤマダ ハナコ',
          phone: '090-1111-2222',
          address: { postalCode: '', prefecture: '', city: '', address: '', building: '' },
        }),
      });
    });

    await page.route('**/api/profile/addresses', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ addresses: [] }),
      });
    });

    await page.route('**/api/contact/threads', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'thread-1',
              created_at: '2026-05-01T10:00:00.000Z',
              last_message_at: '2026-05-02T10:00:00.000Z',
              inquiry_type: 'order',
              subject: '配送について',
              status: 'answered',
            },
          ],
        }),
      });
    });

    await page.route('**/api/contact/threads/thread-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'thread-1',
            created_at: '2026-05-01T10:00:00.000Z',
            updated_at: '2026-05-02T10:00:00.000Z',
            last_message_at: '2026-05-02T10:00:00.000Z',
            inquiry_type: 'order',
            subject: '配送について',
            status: 'answered',
            messages: [
              { id: 'm1', sender_role: 'user', body: 'いつ届きますか？', channel: 'web', created_at: '2026-05-01T10:00:00.000Z' },
              { id: 'm2', sender_role: 'admin', body: '明日発送いたします。', channel: 'web', created_at: '2026-05-02T10:00:00.000Z' },
            ],
          },
        }),
      });
    });

    await loginAndOpenAccount(page);
    await page.getByRole('button', { name: 'お問い合わせ' }).click();

    await expect(page.getByText('配送について')).toBeVisible();

    await page.getByRole('button', { name: /配送について/ }).click();

    await expect(page.getByText('いつ届きますか？')).toBeVisible();
    await expect(page.getByText('明日発送いたします。')).toBeVisible();
  });
});
