import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import { stubCheckoutSessionApis } from './checkout-test-utils';
import { injectTurnstileToken, stubTurnstileScript } from './turnstile-test-utils';

/**
 * FR-UI-008 操作の結果として出る案内を、確実に読み上げる
 * 対応 FREQ: FREQ-377（AC-01〜AC-05）
 *
 * - 案内を中身ごと後から差し込むと読み上げられないことがある（MDN alert / status role）。
 *   入れ物を最初から置き、中身だけを入れ替える（LiveMessage）
 * - フォームごと結果の画面に入れ替わる場合は、押したボタンが消えてフォーカスが外れるので、
 *   結果の見出し・文言へフォーカスを移して読ませる
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

/** 応答を止めておき、release() で返す。入れ物が先にあることを確かめるために使う。 */
function gate(): { wait: Promise<void>; release: () => void } {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function mockGuestCheckout(page: Page): Promise<void> {
  await stubCheckoutSessionApis(page);
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/profile', (route) =>
    route.fulfill({ status: 401, json: { error: 'Unauthorized' } }),
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const hasHorizontalOverflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
  expect(hasHorizontalOverflow).toBe(false);
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-UI-008 操作の結果の案内 (${viewport.name} ${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-377-AC-01
    test('決済の準備に失敗した案内は、最初からある role=alert の入れ物に入り、再試行のボタンは入れ物の外にある', async ({
      page,
    }) => {
      await mockGuestCheckout(page);
      const createSession = gate();
      await page.route('**/api/checkout/create-session', async (route) => {
        await createSession.wait;
        await route.fulfill({
          status: 503,
          json: {
            error: 'checkout_session_failed',
            message: '決済サービスが一時的に利用できません。少し時間をおいて再試行してください。',
            correlationId: 'e2e-stubbed-correlation-id',
            retryable: true,
          },
        });
      });
      await page.goto('/checkout');

      const region = page.getByTestId('checkout-session-error');
      await expect(region).toHaveAttribute('role', 'alert');
      await expect(region).toHaveText('');

      createSession.release();

      await expect(region).toHaveText(/決済サービスが一時的に利用できません/);
      await expect(region).toBeVisible();
      await expect(page.getByRole('button', { name: '再試行する' })).toBeVisible();
      await expect(region.getByRole('button')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });

    // FREQ-377-AC-02
    test('決済から戻って注文の確定に失敗したら、入力画面の先頭の入れ物に案内が入る', async ({ page }) => {
      await mockGuestCheckout(page);
      const complete = gate();
      await page.route('**/api/checkout/complete', async (route) => {
        await complete.wait;
        await route.fulfill({ status: 500, json: { error: 'failed' } });
      });
      await page.goto('/checkout?session_id=cs_test_return_failure');

      const region = page.getByTestId('checkout-return-error');
      await expect(region).toHaveAttribute('role', 'alert');
      await expect(region).toHaveText('');

      complete.release();

      await expect(region).toHaveText('注文確定に失敗しました。時間をおいて再度お試しください。');
      await expect(region).toBeVisible();
    });

    // FREQ-377-AC-03
    test('お問い合わせの送信完了は、最初からある role=status の入れ物に入る', async ({ page }) => {
      await page.route('**/api/contact', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.fallback();
          return;
        }
        await route.fulfill({ status: 200, json: { success: true } });
      });
      await page.goto('/contact');

      const form = page.locator('form:has(textarea[name="message"])');
      // 送信後にお礼のモーダルが開き、背面は支援技術から隠れるので、役割ではなく属性で探す
      const region = form.locator('[role="status"]');
      await expect(region).toHaveCount(1);
      await expect(region).toHaveText('');

      await form.locator('input[name="name"]').fill('テスト太郎');
      await form.locator('input[name="email"]').fill('tester@example.com');
      await form.getByRole('combobox', { name: 'お問い合わせ内容' }).click();
      await page.getByRole('option', { name: 'その他' }).click();
      await form.locator('input[name="subject"]').fill('案内の読み上げテスト');
      await form.locator('textarea[name="message"]').fill('送信完了の案内を確認します。');
      await form.getByRole('button', { name: 'SEND MESSAGE' }).click();

      await expect(region).toHaveCount(1);
      await expect(region).toHaveText(/送信完了しました。/);
    });

    // FREQ-377-AC-04
    test('パスワード再設定メールを送ると、結果の見出しにフォーカスが移る', async ({ page }) => {
      await stubTurnstileScript(page);
      await page.route('**/api/auth/password-reset/session', (route) =>
        route.fulfill({ status: 200, json: { ready: false } }),
      );
      await page.route('**/api/auth/password-reset/request', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
      );
      await page.goto('/auth/password-reset');

      await injectTurnstileToken(page);
      await page.locator('#email').fill('user@example.com');
      await page.getByRole('button', { name: '再設定メールを送信' }).click();

      await expect(
        page.getByRole('heading', { level: 1, name: '再設定メールを送信しました' }),
      ).toBeFocused();
      // フォーカスで読ませるので、同じ内容を status でも読ませない（二重に読まれないように）
      await expect(page.locator('[data-testid="auth-result-body"][role="status"]')).toHaveCount(0);
    });

    // FREQ-377-AC-05
    test('会員登録の確認メールを送ると、完了の文言にフォーカスが移る', async ({ page }) => {
      const password = 'Passw0rd!2026-focus-check';
      await stubTurnstileScript(page);
      await page.route('**/api/auth/register', (route) =>
        route.fulfill({
          status: 200,
          json: { message: '確認メールを送信しました。メールのリンクから登録を完了してください。' },
        }),
      );
      await page.goto('/login');
      await page.getByRole('tab', { name: '会員登録' }).click();

      const panel = page.getByRole('tabpanel');
      await injectTurnstileToken(page);
      await panel.getByLabel('Email').fill('new-member@example.com');
      await panel.getByLabel('Password', { exact: true }).fill(password);
      await panel.getByLabel('Confirm Password', { exact: true }).fill(password);
      await panel.getByRole('button', { name: /登録|会員登録/ }).first().click();

      await expect(
        page.getByText('確認メールを送信しました。メールのリンクから登録を完了してください。'),
      ).toBeFocused();
    });
  });
}
