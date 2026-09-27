import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FR-UI-009 選択欄（SingleSelect の dropdown）を、誤りの案内と結びつけ、キーボードだけで選べるようにする
 * 対応 FREQ: FREQ-379（AC-01〜AC-03）
 *
 * 引き金は APG の select-only combobox（role="combobox"）。button の役割では aria-invalid を
 * 使えない（ARIA 1.2 の対象外）ため。誤りの案内は部品の中の入れ物に出し、説明（aria-describedby）と
 * 誤りの状態（aria-invalid）で結ぶ。選択肢はフォーカスを引き金に残したまま矢印キーで移る。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

/** FR-UI-007 と同じく、決済フォームは用意せずに配送先フォームだけを動かす。 */
async function mockCheckoutApis(page: Page): Promise<void> {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route('**/api/profile', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/profile/addresses', (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({ status: 429, json: { error: 'Too many requests' } }),
  );
}

function activeOption(page: Page, combobox: ReturnType<Page['getByRole']>) {
  return combobox.getAttribute('aria-activedescendant').then((id) => page.locator(`[id="${id}"]`));
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-UI-009 選択欄 (${viewport.name} ${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-379-AC-01
    test('都道府県を選ばずに確定すると、欄が誤りの状態になり、案内が説明として結びつく', async ({ page }) => {
      await mockCheckoutApis(page);
      await page.goto('/checkout');

      const prefecture = page.getByRole('combobox', { name: '都道府県' });
      await expect(prefecture).not.toHaveAttribute('aria-invalid', 'true');

      await page.getByRole('button', { name: '確認へ進む' }).click();

      await expect(prefecture).toHaveAttribute('aria-invalid', 'true');
      await expect(prefecture).toHaveAccessibleDescription('都道府県を選択してください');
      await expect(page.locator('#prefecture-error')).toHaveAttribute('aria-live', 'polite');
      await expect(page.locator('#prefecture-error')).toHaveText('都道府県を選択してください');
      // 名前は見出しだけ（案内が混ざらない）
      await expect(page.getByRole('combobox', { name: '都道府県', exact: true })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    // FREQ-379-AC-02
    test('キーボードだけで都道府県を選べ、選ぶと案内が消える', async ({ page }) => {
      await mockCheckoutApis(page);
      await page.goto('/checkout');
      await page.getByRole('button', { name: '確認へ進む' }).click();

      const prefecture = page.getByRole('combobox', { name: '都道府県' });
      await expect(prefecture).toHaveAttribute('aria-invalid', 'true');
      await prefecture.focus();

      await page.keyboard.press('ArrowDown');
      await expect(prefecture).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('listbox')).toBeVisible();
      await expect(prefecture).toBeFocused();

      // 先頭の「選択してください」から2つ下（北海道 → 青森県）
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(await activeOption(page, prefecture)).toHaveText('青森県');
      await page.keyboard.press('Enter');

      await expect(prefecture).toHaveAttribute('aria-expanded', 'false');
      await expect(prefecture).toContainText('青森県');
      await expect(prefecture).toBeFocused();
      await expect(prefecture).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#prefecture-error')).toHaveText('');
    });

    // FREQ-379-AC-03
    test('Esc で一覧を閉じても値は変わらない', async ({ page }) => {
      await mockCheckoutApis(page);
      await page.goto('/checkout');

      const prefecture = page.getByRole('combobox', { name: '都道府県' });
      await prefecture.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');

      await expect(prefecture).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(prefecture).toContainText('選択してください');
    });
  });
}
