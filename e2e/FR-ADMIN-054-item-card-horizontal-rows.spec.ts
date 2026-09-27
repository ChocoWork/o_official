import { test, expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';

// FREQ-313: Admin ITEM 一覧カードで
//   - 公開状態タグ + カテゴリタグを1行に横並び
//   - 商品名 / 価格のフォントを公開 ITEM 一覧カード（--lk-size-2xs / weight 400）に合わせる
//   - 編集 / 公開切替 / 削除を1行3等分に横並び
// にする。カード内容幅は 390:約152px / 768:約121px と狭いため、
// 1行に収まっているか（＝欠けていないか）まで見る。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'pc-l', width: 1920, height: 1080 },
  { name: '4k', width: 3840, height: 2160 },
];

const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'];

function buildItems() {
  return CATEGORIES.map((category, index) => ({
    id: index + 1,
    name: `テスト商品 ${index + 1}`,
    category,
    price: 24000 + index * 1000,
    image_url: '/placeholder.png',
    status: index === 0 ? 'published' : 'private',
  }));
}

async function mockAdminApis(page: Page): Promise<void> {
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
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: buildItems() }),
    }),
  );
}

async function gotoItemTab(page: Page) {
  await mockAdminApis(page);
  await page.goto('/admin?tab=ITEM');

  const grid = page.getByTestId('admin-item-grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-ui-card]').first()).toBeVisible();

  return grid;
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}（${viewport.width}px）`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-313-AC-01: 公開状態タグとカテゴリタグが横並び', async ({ page }) => {
      const grid = await gotoItemTab(page);

      const rows = await grid.evaluate(() =>
        Array.from(
          document.querySelectorAll('[data-testid="admin-item-tags"]'),
        ).map((row) => {
          const tags = Array.from(row.querySelectorAll('[data-ui-tag-label]'));
          const [status, category] = tags.map((tag) =>
            tag.getBoundingClientRect(),
          );
          return {
            count: tags.length,
            topDelta: Math.abs(status.top - category.top),
            gap: category.left - status.right,
          };
        }),
      );

      expect(rows.length).toBe(CATEGORIES.length);
      for (const row of rows) {
        expect(row.count).toBe(2);
        // 同一行（上端が揃う）
        expect(row.topDelta).toBeLessThanOrEqual(1);
        // カテゴリは公開状態タグの右側（縦積みなら負の値になる）
        expect(row.gap).toBeGreaterThanOrEqual(0);
      }
    });

    test('FREQ-313-AC-02: 商品名と価格が --lk-size-2xs / weight 400', async ({
      page,
    }) => {
      const grid = await gotoItemTab(page);

      const metrics = await grid.evaluate(() => {
        // 黄金比スケールの基準値を実測（公開 ITEM 一覧カードと同じトークン）
        const probe = document.createElement('span');
        probe.style.fontSize = 'var(--lk-size-2xs)';
        document.body.appendChild(probe);
        const size2xs = getComputedStyle(probe).fontSize;
        probe.remove();

        const read = (testId: string) => {
          const node = document.querySelector(
            `[data-testid="${testId}"]`,
          ) as HTMLElement;
          const style = getComputedStyle(node);
          return { fontSize: style.fontSize, fontWeight: style.fontWeight };
        };

        return {
          size2xs,
          name: read('admin-item-name'),
          price: read('admin-item-price'),
        };
      });

      expect(metrics.name.fontSize).toBe(metrics.size2xs);
      expect(metrics.price.fontSize).toBe(metrics.size2xs);
      expect(metrics.name.fontWeight).toBe('400');
      expect(metrics.price.fontWeight).toBe('400');
    });

    test('FREQ-313-AC-03: 編集 / 公開切替 / 削除が1行に横並び', async ({ page }) => {
      const grid = await gotoItemTab(page);

      const rows = await grid.evaluate(() =>
        Array.from(
          document.querySelectorAll('[data-testid="admin-item-actions"]'),
        ).map((row) => {
          const buttons = Array.from(row.querySelectorAll('[data-ui-button]'));
          const boxes = buttons.map((button) =>
            button.getBoundingClientRect(),
          );
          return {
            labels: buttons.map((button) => button.textContent?.trim() ?? ''),
            topDelta: Math.max(
              ...boxes.map((box) => Math.abs(box.top - boxes[0].top)),
            ),
            ascending: boxes.every(
              (box, index) => index === 0 || box.left >= boxes[index - 1].right,
            ),
          };
        }),
      );

      expect(rows.length).toBe(CATEGORIES.length);
      for (const row of rows) {
        expect(row.labels.length).toBe(3);
        expect(row.labels[0]).toBe('編集');
        expect(['公開', '非公開']).toContain(row.labels[1]);
        expect(row.labels[2]).toBe('削除');
        expect(row.topDelta).toBeLessThanOrEqual(1);
        expect(row.ascending).toBe(true);
      }
    });

    test('FREQ-313-AC-04: ラベルが欠けず、カード外にはみ出さない', async ({ page }) => {
      const grid = await gotoItemTab(page);

      const overflow = await grid.evaluate(() =>
        Array.from(document.querySelectorAll('[data-ui-card]')).map((card) => {
          const cardRight = card.getBoundingClientRect().right;
          const buttons = Array.from(card.querySelectorAll('[data-ui-button]'));
          const boxed = Array.from(
            card.querySelectorAll('[data-ui-tag-label], [data-ui-button]'),
          );
          return {
            clipped: Math.max(
              ...buttons.map(
                (button) => button.scrollWidth - button.clientWidth,
              ),
            ),
            beyondCard: Math.max(
              ...boxed.map((node) => node.getBoundingClientRect().right - cardRight),
            ),
          };
        }),
      );

      for (const card of overflow) {
        // ボタンは overflow:hidden。ラベルが収まっていれば scrollWidth は増えない
        expect(card.clipped).toBeLessThanOrEqual(1);
        expect(card.beyondCard).toBeLessThanOrEqual(1);
      }

      const hasHorizontalScroll = await page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth > root.clientWidth + 1;
      });
      expect(hasHorizontalScroll).toBe(false);
    });
  });
}
