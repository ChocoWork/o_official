import { test, expect, type Page } from '@playwright/test';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';
import { stubTurnstileScript } from './turnstile-test-utils';

// FREQ-330: Turnstile のトークンは siteverify が引き換えた時点で無効になる。
// 送信のたびにウィジェットを引き直さないと、2 回目の送信が timeout-or-duplicate で
// 403 になる。E2E では TURNSTILE_SECRET_KEY を使わないので実際の 403 は再現できない。
// 代わりに「2 回目のリクエストが 1 回目と別のトークンを載せていること」を固定する。

const OTP_RESPONSE = {
  step: 'otp',
  message: '認証コードを送信しました。メールに届いたコードを入力してください。',
};

const tokenOf = (route: { request: () => { postDataJSON: () => unknown } }) => {
  const body = route.request().postDataJSON() as { turnstileToken?: string } | null;
  return body?.turnstileToken;
};

const expectDistinctTokens = (tokens: (string | undefined)[]) => {
  expect(tokens).toHaveLength(2);
  expect(tokens[0]).toBeTruthy();
  expect(tokens[1]).toBeTruthy();
  expect(tokens[1]).not.toBe(tokens[0]);
};

const fillLogin = async (page: Page, password: string) => {
  await page.getByLabel('EMAIL').fill('user@example.com');
  await page.getByLabel('PASSWORD').fill(password);
};

test('AC-01: ログイン失敗後の再試行は新しい Turnstile トークンを送る', async ({ page }) => {
  await stubTurnstileScript(page);

  const tokens: (string | undefined)[] = [];
  await page.route('**/api/auth/login', async (route) => {
    tokens.push(tokenOf(route));
    if (tokens.length === 1) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'メールアドレスまたはパスワードが正しくありません。' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(OTP_RESPONSE),
    });
  });

  await page.goto('/login');
  // 2 回目の送信は成功して専用画面へ進む。モックは本物の 2FA Cookie を
  // 発行しないので、テスト側で置いておく。
  await setLoginTwoFactorCookie(page, 'user@example.com');

  await fillLogin(page, 'WrongPassword1234567!');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByText('メールアドレスまたはパスワードが正しくありません。')).toBeVisible();

  await fillLogin(page, 'CorrectPassword1234567!');
  await page.getByRole('button', { name: 'ログイン' }).click();
  // FREQ-334: 成功の合図は画面遷移。成功メッセージの表示は撤去した。
  await page.waitForURL('**/login/verify');

  expectDistinctTokens(tokens);
});

test('AC-02: OTP 再送信は Turnstile を要求しない', async ({ page }) => {
  // 再送は 60 秒待たないと押せない。実時間で待つ代わりに仮想時計で送る。
  await page.clock.install();
  await stubTurnstileScript(page);

  // FREQ-334: 再送は /api/auth/login ではなく専用エンドポイントへ行く。
  // パスワード検証済みであることは 2FA Cookie が証明しているので、
  // Turnstile も宛先も送らない。
  let resendBody: string | null | undefined = 'not-called';
  await page.route('**/api/auth/login/resend', async (route) => {
    resendBody = route.request().postData();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  const loginTokens: (string | undefined)[] = [];
  await page.route('**/api/auth/login', async (route) => {
    loginTokens.push(tokenOf(route));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(OTP_RESPONSE),
    });
  });

  await page.goto('/login');
  // ウィジェットのコールバックは 1 tick 遅れるので、仮想時計を少し進めて届かせる。
  await page.clock.runFor(1);
  await setLoginTwoFactorCookie(page, 'user@example.com');

  await fillLogin(page, 'Password1234567890!');
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByText(/後に再送可能/)).toBeVisible();

  await page.clock.fastForward(61_000);
  await page.getByRole('button', { name: '再送信' }).click();

  await expect(page.getByText('認証コードを再送信しました。')).toBeVisible();
  expect(resendBody).toBeNull();
  // 再送で /api/auth/login を叩き直していないこと（叩くと 2 通目が飛ぶ）
  expect(loginTokens).toHaveLength(1);
});

test('AC-03: パスワード再設定の送信失敗後の再試行は新しい Turnstile トークンを送る', async ({ page }) => {
  await stubTurnstileScript(page);
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: false }),
    });
  });

  const tokens: (string | undefined)[] = [];
  await page.route('**/api/auth/password-reset/request', async (route) => {
    tokens.push(tokenOf(route));
    if (tokens.length === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '送信に失敗しました' }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/auth/password-reset');

  await page.locator('#email').fill('user@example.com');
  await page.getByRole('button', { name: '再設定メールを送信' }).click();
  await expect(page.getByText('送信に失敗しました')).toBeVisible();

  await page.getByRole('button', { name: '再設定メールを送信' }).click();
  await expect(page.getByText('再設定メールを送信しました')).toBeVisible();

  expectDistinctTokens(tokens);
});
