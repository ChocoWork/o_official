import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

async function mockFailingCreateSession(page: Page) {
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status: 500,
      json: { error: '決済セッションの初期化に失敗しました。' },
    }),
  );
}

test.describe('FR-CHECKOUT-008 決済エラー時の再試行導線', () => {
  test('決済セッション初期化に失敗するとエラーと再試行するボタンが表示される', async ({ page }) => {
    // create-session はカートが読み込み済みで空でないときだけ呼ばれるため、
    // 先にカートをモックしておく（さもないと 500 スタブは一度も発火しない）。
    await mockCartApis(page, [sampleCartItem()]);
    await mockFailingCreateSession(page);

    await page.goto('/checkout');

    await expect(
      page.locator('text=決済セッションの初期化に失敗しました。'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '再試行する' })).toBeVisible();
  });

  test('再試行するボタンをクリックすると決済セッション作成が再試行される', async ({ page }) => {
    await mockCartApis(page, [sampleCartItem()]);
    let createSessionCalls = 0;
    await page.route('**/api/checkout/create-session', (route) => {
      createSessionCalls += 1;
      return route.fulfill({
        status: 500,
        json: { error: '決済セッションの初期化に失敗しました。' },
      });
    });

    await page.goto('/checkout');

    await expect(page.getByRole('button', { name: '再試行する' })).toBeVisible();
    expect(createSessionCalls).toBe(1);

    await page.getByRole('button', { name: '再試行する' }).click();

    await expect
      .poll(() => createSessionCalls)
      .toBe(2);
  });

  test('決済セッションが失敗していても配送先入力欄は編集できる', async ({ page }) => {
    await mockCartApis(page, [sampleCartItem()]);
    await mockFailingCreateSession(page);

    await page.goto('/checkout');

    await expect(
      page.locator('text=決済セッションの初期化に失敗しました。'),
    ).toBeVisible();

    const fullName = page.locator('input[name="fullName"]');
    await fullName.fill('テスト太郎');
    await expect(fullName).toHaveValue('テスト太郎');
  });
});
