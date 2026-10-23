import { expect, test, type Page } from '@playwright/test';
import { fulfillJson, mockAdminSession, viewports } from './order-fulfillment-test-utils';

// FREQ-515: 管理画面とログインの確認の選択欄で選んだ値が反映される
// AC-01: 管理画面のユーザー一覧で役割を選ぶと、選んだ役割で変更が送られること
// AC-03: お知らせの編集でカテゴリーを選んで更新すると、選んだカテゴリーで保存されること
// （AC-02 のログインの確認の認証要素は tests/unit/app/auth/verified-page.test.tsx で確かめる）

const USERS = [
  {
    id: 'user-1',
    name: '山田 花子',
    email: 'hanako@example.com',
    role: 'User',
    roleValue: 'user',
    lastLogin: '2026-10-01',
    status: 'アクティブ',
  },
];

const ARTICLE = {
  id: 'news-1',
  title: '秋冬コレクションのお知らせ',
  category: 'COLLECTION',
  published_date: '2026-10-01',
  image_url: '/news1.png',
  content: '要約',
  detailed_content: '詳細',
  status: 'published',
};

/** ユーザー一覧の GET と、役割の変更（PATCH）を受けて送られた中身を返す */
async function mockUsers(page: Page): Promise<Array<Record<string, unknown>>> {
  const patches: Array<Record<string, unknown>> = [];
  await page.route('**/api/admin/users', async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      patches.push(request.postDataJSON() as Record<string, unknown>);
      await fulfillJson(route, { ok: true });
      return;
    }
    await fulfillJson(route, { data: USERS });
  });
  return patches;
}

/** お知らせの記事の GET と、更新（PUT）を受けて送られた multipart の本文を返す */
async function mockNewsArticle(page: Page): Promise<string[]> {
  const puts: string[] = [];
  await page.route('**/api/admin/news', (route) => fulfillJson(route, { data: [] }));
  await page.route('**/api/admin/news/news-1', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      puts.push(request.postData() ?? '');
      await fulfillJson(route, { data: { ...ARTICLE, category: 'STORE' } });
      return;
    }
    await fulfillJson(route, { data: ARTICLE });
  });
  return puts;
}

/** multipart の本文から、その名前の欄の値を読む */
function formField(body: string, name: string): string | null {
  const match = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return match ? match[1] : null;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-108 select fields (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminSession(page);
    });

    test('ユーザー一覧で役割を選ぶと、選んだ役割で変更が送られる', async ({ page }) => {
      // FREQ-515-AC-01
      const patches = await mockUsers(page);
      await page.goto('/admin?tab=USER');

      const row = page.getByRole('row', { name: /山田 花子/ });
      const roleSelect = row.getByRole('combobox');
      await expect(roleSelect).toHaveText('User');

      await roleSelect.click();
      await page.getByRole('listbox').getByRole('option', { name: 'Support', exact: true }).click();

      await expect.poll(() => patches).toEqual([{ userId: 'user-1', role: 'supporter' }]);
      await expect(roleSelect).toHaveText('Support');
      await expect(roleSelect).toBeEnabled();
    });

    test('お知らせの編集でカテゴリーを選んで更新すると、選んだカテゴリーで保存される', async ({ page }) => {
      // FREQ-515-AC-03
      const puts = await mockNewsArticle(page);
      await page.goto('/admin/news/edit/news-1');

      const category = page.getByRole('combobox', { name: 'カテゴリー' });
      await expect(category).toHaveText('COLLECTION');

      await category.click();
      await page.getByRole('listbox').getByRole('option', { name: 'STORE', exact: true }).click();
      await expect(category).toHaveText('STORE');

      await page.getByRole('button', { name: '更新', exact: true }).click();

      await expect.poll(() => puts.length).toBe(1);
      expect(formField(puts[0], 'category')).toBe('STORE');
      expect(formField(puts[0], 'title')).toBe(ARTICLE.title);
      await expect(page).toHaveURL(/\/admin\?tab=NEWS$/);
    });
  });
}
