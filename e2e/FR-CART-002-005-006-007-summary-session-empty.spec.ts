import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

test.describe('FR-CART-002/005/006/007 cart summary session empty', () => {
  test('session_id cookie を払い出し、注文サマリーとプロモーション UI を表示する', async ({ page }) => {
    await mockCartApis(page, [sampleCartItem({ quantity: 2 })]);

    await page.goto('/cart');

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'session_id');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.expires ?? 0).toBeGreaterThan(Date.now() / 1000 + 20 * 24 * 60 * 60);

    await expect(page.getByText('Order Summary')).toBeVisible();
    await expect(page.getByText('小計')).toBeVisible();
    await expect(page.getByText('配送料')).toBeVisible();
    await expect(page.getByText('無料')).toBeVisible();
    await expect(page.getByText('合計')).toBeVisible();
    await expect(page.getByPlaceholder('コードを入力')).toBeVisible();
    await expect(page.getByRole('button', { name: '適用' })).toBeVisible();
    await expect(page.getByRole('link', { name: '購入手続きへ進む' })).toHaveAttribute('href', '/checkout');
  });

  test('空カートでは EmptyCart と継続購入リンクを表示する', async ({ page }) => {
    await mockCartApis(page, []);

    await page.goto('/cart');

    await expect(page.getByText('カートは空です')).toBeVisible();
    await expect(page.getByRole('link', { name: 'CONTINUE SHOPPING' })).toHaveAttribute('href', '/item');
  });
});