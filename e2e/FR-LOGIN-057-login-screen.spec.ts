/**
 * FR-LOGIN-057 新しいログイン画面（/login）
 * 対応: FR-AUTH-027-AC-01〜06（設計: DD-AUTH-063）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で流す。ここでは本物の仮想の認証器を使わず、
 * `page.addInitScript` で `navigator.credentials.get` を差し替える（パスキーの本物の往復は FR-LOGIN-059）。
 * メール欄から送る試験は、始めの窓口は本物で、Mailpit にコードが届くことまで確かめる。
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readMailpitMessages } from './member-session-helpers';
import { injectTurnstileToken, stubTurnstileScript } from './turnstile-test-utils';

test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueEmail(label: string): string {
  return `e2e-login-screen-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** `navigator.credentials.get` を差し替える。`mode` が cancel なら NotAllowedError、credential なら最小の応答を返す。 */
async function stubCredentialsGet(page: Page, mode: 'cancel' | 'credential'): Promise<void> {
  await page.addInitScript((m) => {
    Object.defineProperty(navigator.credentials, 'get', {
      configurable: true,
      value: async () => {
        if (m === 'cancel') throw new DOMException('cancelled', 'NotAllowedError');
        return {
          id: 'AAAA',
          rawId: new ArrayBuffer(4),
          type: 'public-key',
          toJSON: () => ({
            id: 'AAAA',
            rawId: 'AAAA',
            type: 'public-key',
            clientExtensionResults: {},
            response: { clientDataJSON: 'AAAA', authenticatorData: 'AAAA', signature: 'AAAA' },
          }),
        };
      },
    });
  }, mode);
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-057 login screen (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await stubTurnstileScript(page);
    });

    test(`FR-AUTH-027-AC-01 ${viewport.name}: パスキー・Google・メールの3つの入口が見え、aria-label とタブ移動の順が正しい`, async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeAttached();
      const passkey = page.getByRole('button', { name: 'パスキーでログイン' });
      await expect(passkey).toBeVisible();
      await expect(page.getByText('この端末の顔認証・指紋・PIN で入れます。')).toBeVisible();
      await expect(page.getByText('OR', { exact: true })).toHaveCount(2);
      await expect(page.getByRole('group', { name: 'その他のログイン方法' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Googleでサインイン/ })).toBeVisible();
      await expect(page.getByLabel('Email')).toBeVisible();
      await expect(page.getByRole('button', { name: 'メールでコードを受け取る' })).toBeVisible();
      await expect(page.getByText('はじめての方も、同じ方法でアカウントを作れます。')).toBeVisible();
      await expect(page.getByRole('link', { name: '利用規約' })).toHaveAttribute('href', '/terms');
      await expect(page.getByRole('link', { name: 'プライバシーポリシー' })).toHaveAttribute('href', '/privacy');

      await passkey.focus();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: /Googleでサインイン/ })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByLabel('Email')).toBeFocused();
    });

    test(`FR-AUTH-027-AC-02 ${viewport.name}: パスキーを押すと始めの窓口が1回呼ばれ、中止なら中止の文が出る`, async ({ page }) => {
      await stubCredentialsGet(page, 'cancel');
      await page.goto('/login');
      let starts = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/auth/passkey/login/start' && request.method() === 'POST') starts += 1;
      });

      await page.getByRole('button', { name: 'パスキーでログイン' }).click();

      await expect(page.getByText('パスキーでのログインを中止しました。')).toBeVisible();
      expect(starts).toBe(1);
      await expect(page.getByRole('button', { name: 'パスキーでログイン' })).toBeEnabled();
    });

    test(`FR-AUTH-027-AC-02 ${viewport.name}: next は終わりの窓口の本文に戻り先として渡る`, async ({ page }) => {
      await stubCredentialsGet(page, 'credential');
      let finishBody: Record<string, unknown> | null = null;
      await page.route('**/api/auth/passkey/login/finish', async (route) => {
        finishBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'passkey_login_failed' }) });
      });
      await page.goto('/login?next=%2Fstockist%3Ffrom%3De2e');

      await page.getByRole('button', { name: 'パスキーでログイン' }).click();

      await expect(
        page.getByText('このパスキーではログインできませんでした。メールのコードか Google でもログインできます。'),
      ).toBeVisible();
      expect(finishBody).not.toBeNull();
      expect((finishBody as unknown as Record<string, unknown>).next).toBe('/stockist?from=e2e');
    });

    test(`FR-AUTH-027-AC-03 ${viewport.name}: パスキーに未対応なら、ボタンを出さず一文を出す`, async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
      });
      await page.goto('/login');

      await expect(
        page.getByText('この端末ではパスキーを使えません。メールのコードか Google でログインできます。'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'パスキーでログイン' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Googleでサインイン/ })).toBeVisible();
    });

    test(`FR-AUTH-027-AC-04 ${viewport.name}: メールを入れて送ると /login/code へ移り、Mailpit にコードが届く`, async ({ page }) => {
      const email = uniqueEmail('start');
      await page.goto('/login');
      await injectTurnstileToken(page);
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'メールでコードを受け取る' }).click();

      await expect(page).toHaveURL(/\/login\/code$/);
      await expect(page.getByRole('heading', { name: '確認コードを入力してください' })).toBeVisible();
      await expect
        .poll(async () => (await readMailpitMessages(email)).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
    });

    test(`FR-AUTH-027-AC-04 ${viewport.name}: 形の誤りは送らずに文を出す`, async ({ page }) => {
      await page.goto('/login');
      await page.getByLabel('Email').fill('not-an-email');
      await page.getByRole('button', { name: 'メールでコードを受け取る' }).click();

      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
    });

    test(`FR-AUTH-027-AC-05 ${viewport.name}: Google のボタンは今と同じで、authorize へ select_account 付きで移る`, async ({ page }) => {
      await page.route('**/auth/v1/authorize?**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>authorize stub</title>' }),
      );
      await page.goto('/login');
      await page.getByRole('button', { name: /Googleでサインイン/ }).click();
      await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('prompt=select_account');
      expect(new URL(page.url()).searchParams.get('provider')).toBe('google');
    });

    test(`FR-AUTH-027-AC-06 ${viewport.name}: 横にはみ出さず、?email はメール欄の初めの値。消した確認リンクの印（?registered=1）は案内を出さない`, async ({ page }) => {
      await page.goto('/login?tab=register&email=hanako%40example.com&registered=1');
      await expect(page.getByLabel('Email')).toHaveValue('hanako@example.com');
      await expect(page.getByText('会員登録が完了しました。ログインしてください。')).toHaveCount(0);
      await expect(page.getByRole('tab')).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (viewport.width === 390) {
        const submit = await page.getByRole('button', { name: 'メールでコードを受け取る' }).boundingBox();
        expect(submit).not.toBeNull();
        expect(submit!.y + submit!.height).toBeLessThanOrEqual(viewport.height);
      }
    });
  });
}
