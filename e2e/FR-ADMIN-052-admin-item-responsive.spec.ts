import { test, expect, Page } from '@playwright/test';

// FREQ-310: Admin の ITEM タブ / 新規登録 / 編集画面を
// mobile(390) / tablet(768) / PC(1280) / PC-L(1920) / 4K(3840) の5帯に対応させる。
// columns は公開 ITEM 一覧の ITEM_GRID_CLASS（PublicItemGrid.tsx / FREQ-276）
// と同じ 2 列（md 未満）/ 3 列（md〜2xl 未満）/ 4 列（2xl 以上）を期待値にする。
const viewports = [
  { name: 'mobile', width: 390, height: 844, columns: 2 },
  { name: 'tablet', width: 768, height: 1024, columns: 3 },
  { name: 'desktop', width: 1280, height: 900, columns: 3 },
  { name: 'pc-l', width: 1920, height: 1080, columns: 4 },
  { name: '4k', width: 3840, height: 2160, columns: 4 },
];

// フォームが2カラムになる下限（xl = 1280px）
const FORM_TWO_COLUMN_MIN_WIDTH = 1280;

const SECTION_TITLES = [
  '商品画像',
  '基本情報',
  '商品説明',
  'バリエーション',
  '商品仕様',
  '公開設定',
];

function buildItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `テスト商品 ${index + 1}`,
    category: 'TOPS',
    price: 24000 + index * 100,
    image_url: '/placeholder.png',
    status: index % 2 === 0 ? 'published' : 'private',
  }));
}

async function mockAdminApis(page: Page): Promise<void> {
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

  await page.route('**/api/admin/item-color-presets**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    }),
  );

  await page.route('**/api/admin/items', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: buildItems(12) }),
    }),
  );
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth + 1;
  });
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-312-AC-01: ITEM一覧の列数が公開ITEM一覧と同じ', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');

      const grid = page.getByTestId('admin-item-grid');
      await expect(grid).toBeVisible();
      await expect(grid.locator('[data-ui-card]').first()).toBeVisible();

      const columns = await grid.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
      );

      expect(columns).toBe(viewport.columns);
    });

    test('FREQ-310-AC-02: ITEM一覧で横スクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto('/admin?tab=ITEM');

      await expect(page.getByTestId('admin-item-grid')).toBeVisible();
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });

    test('FREQ-310-AC-03: 登録フォームが xl 以上で2カラム、未満で1カラム', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      const media = page.getByTestId('item-form-media');
      const fields = page.getByTestId('item-form-fields');
      await expect(media).toBeVisible();
      await expect(fields).toBeVisible();

      const mediaBox = await media.boundingBox();
      const fieldsBox = await fields.boundingBox();
      expect(mediaBox).not.toBeNull();
      expect(fieldsBox).not.toBeNull();
      if (!mediaBox || !fieldsBox) return;

      if (viewport.width >= FORM_TWO_COLUMN_MIN_WIDTH) {
        // 2カラム: 上端が揃い、画像列の右端が入力列の左端より左にある
        expect(Math.abs(mediaBox.y - fieldsBox.y)).toBeLessThanOrEqual(2);
        expect(mediaBox.x + mediaBox.width).toBeLessThanOrEqual(fieldsBox.x + 1);
      } else {
        // 1カラム: 入力列が画像列より下に積まれる
        expect(fieldsBox.y).toBeGreaterThan(mediaBox.y + mediaBox.height - 1);
      }
    });

    test('FREQ-310-AC-04: 登録フォームで横スクロールが発生しない', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      await expect(page.getByTestId('item-form-fields')).toBeVisible();
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });

    test('FREQ-310-AC-05: 登録フォームに6つのセクション見出しが表示される', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      for (const title of SECTION_TITLES) {
        await expect(
          page.getByRole('heading', { level: 2, name: title }),
        ).toBeVisible();
      }
    });

    test('FREQ-310-AC-06: セクション間の間隔がフィールド間より広い（近接）', async ({
      page,
    }) => {
      await mockAdminApis(page);
      await page.goto('/admin/item/create');

      await expect(page.getByTestId('item-form-fields')).toBeVisible();

      const gaps = await page
        .getByTestId('item-form-fields')
        .evaluate((el) => {
          const styles = getComputedStyle(el);
          const sectionGap = parseFloat(styles.rowGap);
          const firstSection = el.querySelector('section');
          const fieldGap = firstSection
            ? parseFloat(getComputedStyle(firstSection).rowGap)
            : Number.NaN;
          return { sectionGap, fieldGap };
        });

      expect(gaps.fieldGap).toBeGreaterThan(0);
      expect(gaps.sectionGap).toBeGreaterThan(gaps.fieldGap);
    });
  });
}
