/**
 * FR-CHECKOUT-044 価格変更の読み直しと、再試行できる断り・できない断りでの配送先の選択
 * 対応 FREQ: FREQ-425-AC-01（金額の読み直し）、FREQ-430-AC-08（明細を外した後の再試行）、
 * FREQ-377（案内の入れ物を保つ）、FREQ-425-AC-02・FREQ-385-AC-02（再試行不可の案内と無効状態を保つ）。
 * 金額を更新して送ること自体は page の単体テストでも確かめる。
 */
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, fillShippingForm, proceedToFinal, seedCart, stubPostalCode } from './checkout-flow-helpers';

const PRICE_MESSAGE = '価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。';
const UNAVAILABLE_MESSAGE = '次の商品はお求めいただけなくなったため、カートから外しました: E2E のシャツ。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';
const INVALID_MEMBER_EMAIL_MESSAGE = 'ログイン中のメールアドレスを確かめられませんでした。ログインし直してから、もう一度お試しください。';

test.describe('FR-CHECKOUT-044 価格変更と配送先の選択', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）金額不一致の案内の後、押し直すと最終確認へ進む`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      let creations = 0;
      let cartReads = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/cart' && request.method() === 'GET') cartReads += 1;
      });
      await page.route('**/api/checkout/create-session', async (route) => {
        creations += 1;
        if (creations === 1) {
          await route.fulfill({ status: 409, json: { error: 'checkout_amount_mismatch' } });
        } else {
          await route.continue();
        }
      });
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-amount-refresh-${viewport.name}@example.com`);
      const readsBefore = cartReads;
      await page.getByRole('button', { name: '確認へ進む' }).click();
      await expect(page.getByTestId('checkout-session-error')).toHaveText(PRICE_MESSAGE);
      expect(cartReads).toBeGreaterThan(readsBefore);
      await proceedToFinal(page);
      expect(creations).toBe(2);
    });

    test(`${viewport.name}（${viewport.width}px）明細を外した案内後も確認へ進め、新規を選ぶと案内を消せる`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      // 保存済み住所の入口を差し替え、配送先の選択欄を確実に出す（既存の住所帳 E2E と同じ形）。
      // ログインのお客様はメールアドレスの欄が読み取り専用なので、お客様情報はプロフィールの差し替えで埋め、
      // フォームには入力しない（保存済みの住所を選んだまま「確認へ進む」を押す）。
      await page.route('**/api/auth/me', (route) => route.fulfill({ json: { authenticated: true, user: { id: 'test-user-id', role: 'user', mfaVerified: false } } }));
      await page.route('**/api/profile', (route) => route.fulfill({ json: {
        email: `e2e-error-new-address-${viewport.name}@example.com`,
        fullName: '山田 花子',
        kanaName: 'ヤマダ ハナコ',
        phone: '0312345678',
        address: { postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3', building: '' },
      } }));
      await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [
        { id: 'e2e-address', postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3', building: '', isDefault: true },
      ] } }));
      await page.route('**/api/checkout/create-session', (route) => route.fulfill({ status: 409, json: { error: 'cart_updated', retryable: true, message: UNAVAILABLE_MESSAGE } }));
      await page.goto('/checkout');
      const select = page.getByRole('combobox', { name: '保存済みの配送先' });
      await expect(select).toContainText('150-0001');
      const proceed = page.getByRole('button', { name: '確認へ進む' });
      await expect(proceed).toBeEnabled();
      await proceed.click();
      await expect(page.getByTestId('checkout-session-error')).toHaveText(UNAVAILABLE_MESSAGE);
      await expect(proceed).toBeEnabled();
      await expect(page).toHaveURL(/\/checkout$/);

      await select.click();
      await page.getByRole('option', { name: '新規', exact: true }).click();
      await expect(select).toContainText('新規');
      // LiveMessage は案内を読み上げる入れ物を保つため、消えるのは中身だけ（FREQ-377）。
      await expect(page.getByTestId('checkout-session-error')).toHaveText('');
      await expect(proceed).toBeEnabled();
    });

    test(`${viewport.name}（${viewport.width}px）やり直せない断りの案内と無効な確認ボタンは新規を選んでも残る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      // 保存済みの住所とお客様情報で入力を満たし、配送先の変更後も断りが残ることを確かめる。
      await page.route('**/api/auth/me', (route) => route.fulfill({ json: { authenticated: true, user: { id: 'test-user-id', role: 'user', mfaVerified: false } } }));
      await page.route('**/api/profile', (route) => route.fulfill({ json: {
        email: `e2e-blocked-new-address-${viewport.name}@example.com`,
        fullName: '山田 花子',
        kanaName: 'ヤマダ ハナコ',
        phone: '0312345678',
        address: { postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3', building: '' },
      } }));
      await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [
        { id: 'e2e-address', postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3', building: '', isDefault: true },
      ] } }));
      // create-session が実際に 400・retryable: false で返し、checkout-api がそのまま写す断りを使う。
      // ログイン中のメールの問題は配送先を新規にしても解決しないため、案内と無効状態を保つ例にする。
      await page.route('**/api/checkout/create-session', (route) => route.fulfill({ status: 400, json: { error: 'invalid_member_email', retryable: false, message: INVALID_MEMBER_EMAIL_MESSAGE } }));
      await page.goto('/checkout');
      const select = page.getByRole('combobox', { name: '保存済みの配送先' });
      await expect(select).toContainText('150-0001');
      const proceed = page.getByRole('button', { name: '確認へ進む' });
      await expect(proceed).toBeEnabled();
      await proceed.click();
      await expect(page.getByTestId('checkout-session-error')).toHaveText(INVALID_MEMBER_EMAIL_MESSAGE);
      await expect(proceed).toBeDisabled();

      await select.click();
      await page.getByRole('option', { name: '新規', exact: true }).click();
      await expect(select).toContainText('新規');
      await expect(page.getByTestId('checkout-session-error')).toHaveText(INVALID_MEMBER_EMAIL_MESSAGE);
      await expect(proceed).toBeDisabled();
      await expect(page).toHaveURL(/\/checkout$/);
    });
  }
});
