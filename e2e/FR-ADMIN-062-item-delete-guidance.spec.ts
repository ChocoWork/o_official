import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-414: 注文や在庫の記録がある商品を削除しようとすると、非公開を促す案内が出て商品が残る（R-44）。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ITEMS = [
  {
    id: 1,
    name: 'シルクブラウス',
    category: 'TOPS',
    price: 28000,
    image_url: '/placeholder.png',
    status: 'published',
    canDelete: false,
    deleteBlockedReasons: ['注文がある'],
  },
  {
    id: 2,
    name: 'タックスカート',
    category: 'BOTTOMS',
    price: 32000,
    image_url: '/placeholder.png',
    status: 'private',
    canDelete: true,
    deleteBlockedReasons: [],
  },
];

async function mockAdminApis(page: Page, deleteRequests: string[]): Promise<void> {
  await mockAdminBackgroundApis(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );
  await page.route('**/api/admin/items', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: ITEMS }) }),
  );
  await page.route('**/api/admin/items/*', (route) => {
    if (route.request().method() !== 'DELETE') {
      return route.fallback();
    }
    deleteRequests.push(route.request().url());
    // 一覧を読んだ後に注文が入った（競合）場合の応答
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'この商品は削除できません（決済中のお客様がいる）。非公開にすると、お客様の画面から見えなくなります。',
        reasons: ['決済中のお客様がいる'],
      }),
    });
  });
}

async function openItems(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ITEM' }).click();
  await expect(page.getByText('シルクブラウス')).toBeVisible();
}

function cardOf(page: Page, name: string) {
  return page.getByTestId('admin-item-grid').locator('.admin-item-card').filter({ hasText: name });
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-062 item delete guidance (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('注文のある商品は削除を送らず、非公開を促す案内を出して残す', async ({ page }) => {
      // FREQ-414-AC-01・AC-03
      const deleteRequests: string[] = [];
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      await mockAdminApis(page, deleteRequests);
      await openItems(page);

      // 削除できない商品にも削除ボタンを出し、押せる（無効化・非表示にしない。2026-09-27 決定）
      const deleteButton = cardOf(page, 'シルクブラウス').getByRole('button', { name: '削除' });
      await expect(deleteButton).toBeVisible();
      await expect(deleteButton).toBeEnabled();

      await deleteButton.click();

      await expect.poll(() => dialogs).toEqual([
        'この商品は削除できません（注文がある）。非公開にすると、お客様の画面から見えなくなります。',
      ]);
      expect(deleteRequests).toEqual([]);
      await expect(page.getByText('シルクブラウス')).toBeVisible();
    });

    test('一覧の後に削除できなくなった商品は、サーバーの案内を出して残す', async ({ page }) => {
      // FREQ-414-AC-02
      const deleteRequests: string[] = [];
      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.accept();
      });
      await mockAdminApis(page, deleteRequests);
      await openItems(page);

      await cardOf(page, 'タックスカート').getByRole('button', { name: '削除' }).click();

      await expect.poll(() => dialogs.length).toBe(2);
      expect(dialogs[0]).toBe('この商品を削除してもよろしいですか？');
      expect(dialogs[1]).toContain('非公開にすると');
      expect(deleteRequests).toHaveLength(1);
      await expect(page.getByText('タックスカート')).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page, []);
      await openItems(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
