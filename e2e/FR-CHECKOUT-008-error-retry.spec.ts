import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import { fillShippingForm, stubPostalCode } from './checkout-flow-helpers';

// 本文に message が無い失敗。画面は決まった案内を出す（src/app/checkout/_lib/checkout-api.ts）
const FALLBACK_MESSAGE = '決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。';

async function openAndProceed(page: Page, onCreateSession: () => void): Promise<void> {
  await mockCartApis(page, [sampleCartItem()]);
  await stubPostalCode(page);
  await page.route('**/api/checkout/create-session', (route) => {
    onCreateSession();
    return route.fulfill({ status: 500, json: { error: 'checkout_session_failed' } });
  });
  await page.goto('/checkout');
  await fillShippingForm(page, 'e2e-retry@example.com');
  await page.getByRole('button', { name: '確認へ進む' }).click();
}

test.describe('FR-CHECKOUT-008 決済の準備の失敗と再試行', () => {
  test('確認へ進むで決済の準備に失敗すると案内が出て、確認へ進むはもう一度押せる', async ({ page }) => {
    await openAndProceed(page, () => undefined);

    await expect(page.getByTestId('checkout-session-error')).toHaveText(FALLBACK_MESSAGE);
    await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
  });

  test('もう一度確認へ進むを押すと、決済の画面の作成をもう一度試す', async ({ page }) => {
    let createSessionCalls = 0;
    await openAndProceed(page, () => {
      createSessionCalls += 1;
    });
    await expect(page.getByTestId('checkout-session-error')).toHaveText(FALLBACK_MESSAGE);
    expect(createSessionCalls).toBe(1);

    await page.getByRole('button', { name: '確認へ進む' }).click();

    await expect.poll(() => createSessionCalls).toBe(2);
  });

  test('失敗していても配送先の欄は編集できる', async ({ page }) => {
    await openAndProceed(page, () => undefined);
    await expect(page.getByTestId('checkout-session-error')).toHaveText(FALLBACK_MESSAGE);

    const fullName = page.locator('input[name="fullName"]');
    await fullName.fill('テスト太郎');
    await expect(fullName).toHaveValue('テスト太郎');
  });
});
